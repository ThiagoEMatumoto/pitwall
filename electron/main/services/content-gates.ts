import { statSync } from "node:fs";
import { isAbsolute, normalize } from "node:path";
import { lintTexto, ocorrencias, temBloqueio } from "./content-gates/tone-lint";
import type {
  ContentContract,
  ContentGateAttestation,
  ContentGateFinding,
  ContentGateKind,
  ContentGateStatus,
  ForbiddenFact,
  ForbiddenFactStatus,
  OutOfScopeItem,
} from "../../../shared/types/ipc";

// CONTENT GATES — os seis portões executáveis do contrato de conteúdo.
//
// Módulo FOLHA: sem Electron, sem banco, sem processo externo. Entra dado, sai
// dado. A gravação em `content_gate_runs` NÃO acontece aqui — quem chama roda
// `runGate` e depois `createGateRun`, a mesma separação que `job-run-now` faz do
// store. Isso é o que deixa o registry testável sem DB e o que permite ao
// chamador decidir se um run merece linha no histórico.
//
// TODOS OS EXECUTORES SÃO SÍNCRONOS, por decisão registrada no plano: o
// `ToolDef.handler` de `mcp/tools.ts` devolve `ToolResult`, não Promise. É por
// isso que `delivery-limit` usa `statSync` de `node:fs` e nunca `fs/promises`.
// Se um gate futuro precisar de I/O assíncrono, o tipo `ToolDef` inteiro muda —
// a conversa é lá, não aqui.
//
// DUAS NATUREZAS DE GATE. Os analíticos (`tone-lint`, `forbidden-facts`,
// `scope`, `delivery-limit`) rodam sozinhos sobre o material. Os de atestação
// (`scope-checklist`, `positive-evidence`) não conseguem se verificar sozinhos e
// exigem respostas no payload: sem atestação eles reprovam, porque "não sei"
// nunca pode virar "passou".

/**
 * `track` é a trilha do material (o eixo de `appliesTo` dos fatos: o briefing
 * real tem regra permitida em incapacidade e proibida em BPC). Ausente ou vazia
 * significa TRILHA NÃO DECLARADA, e aí todo fato se aplica — errar para o lado
 * de reprovar é o barato; deixar passar um fato proibido é o caro.
 *
 * `material` é o texto a lintar em todos os gates, exceto `delivery-limit`, onde
 * é o caminho absoluto do arquivo a medir.
 */
export interface GateInput {
  contract: ContentContract;
  material: string;
  channel?: string | null;
  track?: string | null;
  attestation?: ContentGateAttestation | null;
}

/**
 * `passed` = o material está conforme (nenhum achado). `blocking` = não
 * entregável. Os dois não são o mesmo: um aviso de tom deixa `passed: false` com
 * `blocking: false` — há o que corrigir, mas dá para entregar.
 *
 * `status` não estava na assinatura do plano; entra opcional (e sempre
 * preenchido) porque `skipped` e `error` não cabem em dois booleanos, e o
 * chamador precisa dele para gravar o gate run. Gate que não conseguiu rodar sai
 * como `error` + `blocking: true`: falha de execução jamais pode ser lida como
 * aprovação.
 */
export interface GateOutcome {
  passed: boolean;
  blocking: boolean;
  evidence: string;
  details: Record<string, unknown>;
  status?: ContentGateStatus;
}

export type GateExecutor = (input: GateInput) => GateOutcome;

// ---- utilidades de texto ----
//
// Duplicam de propósito o cálculo de linha/coluna e o recorte do `tone-lint`:
// aqueles são internos do port do atelier e exportá-los ampliaria a superfície
// de um arquivo que deve continuar espelhando o original. Só `ocorrencias` é
// compartilhada, porque é o VEREDITO (o que conta como ocorrência de um termo) —
// e veredito duplicado é que seria bug.

const CONTEXTO = 24;

function indicesDeLinha(texto: string): number[] {
  const inicios = [0];
  for (let i = 0; i < texto.length; i++) {
    if (texto[i] === "\n") inicios.push(i + 1);
  }
  return inicios;
}

function posicaoDe(
  inicios: number[],
  offset: number,
): { linha: number; coluna: number } {
  let lo = 0;
  let hi = inicios.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (inicios[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return { linha: lo + 1, coluna: offset - inicios[lo] + 1 };
}

function recorte(texto: string, inicio: number, fim: number): string {
  const a = Math.max(0, inicio - CONTEXTO);
  const b = Math.min(texto.length, fim + CONTEXTO);
  const corpo = texto.slice(a, b).replace(/\s+/g, " ").trim();
  return `${a > 0 ? "…" : ""}${corpo}${b < texto.length ? "…" : ""}`;
}

// ---- trilha / appliesTo ----

/**
 * `appliesTo` vazio ou ausente = vale para todas as trilhas. Só quando o INPUT
 * declara trilha e o fato declara uma lista que não a contém é que o fato sai de
 * cena; comparação normalizada porque a trilha vem digitada por quem chama.
 */
function seAplica(
  appliesTo: string[] | null | undefined,
  track: string | null | undefined,
): boolean {
  if (!Array.isArray(appliesTo) || !appliesTo.length) return true;
  const alvo = (track ?? "").trim().toLowerCase();
  if (!alvo) return true;
  return appliesTo.some((t) => String(t).trim().toLowerCase() === alvo);
}

// ---- forbidden-facts / scope ----

interface Achado {
  finding: ContentGateFinding;
  linha: string;
}

/** Uma passada de busca literal, com linha/coluna e trecho do material. */
function buscar(
  material: string,
  formas: string[],
  regra: string,
  rotulo: (termo: string) => string,
  replacement: string | null,
): Achado[] {
  const inicios = indicesDeLinha(material);
  return ocorrencias(material, formas).map((o) => {
    const { linha, coluna } = posicaoDe(inicios, o.inicio);
    const excerpt = recorte(material, o.inicio, o.fim);
    const finding: ContentGateFinding = {
      rule: regra,
      severity: "bloqueante",
      message: rotulo(o.termo),
      line: linha,
      column: coluna,
      excerpt,
      replacement,
    };
    return {
      finding,
      linha: [
        `L${linha}:${coluna} — ${rotulo(o.termo)}`,
        `  trecho: ${excerpt}`,
        replacement ? `  escreva no lugar: ${replacement}` : null,
      ]
        .filter(Boolean)
        .join("\n"),
    };
  });
}

/**
 * `liberado` é o único status que solta o fato: nasceu proibido e alguém
 * conferiu contra fonte primária. `confirmado-falso` é o oposto de liberado — a
 * checagem confirmou que a afirmação é falsa mesmo — então continua bloqueando.
 * O nome do status carrega o `-falso` porque "confirmado" sozinho é ambíguo:
 * no briefing de quem escreve, ele quer dizer "conferi, é verdade".
 */
const STATUS_QUE_PROIBEM: readonly ForbiddenFactStatus[] = [
  "proibido",
  "confirmado-falso",
];

const proibe = (f: ForbiddenFact): boolean =>
  STATUS_QUE_PROIBEM.includes(f.status);

// ---- delivery-limit ----

interface CaminhoOk {
  ok: true;
  caminho: string;
}
interface CaminhoErro {
  ok: false;
  motivo: string;
}

/**
 * Primeira superfície do app que aceita caminho de arquivo vindo do modelo (via
 * MCP). Caminho relativo é recusado porque o cwd do processo Electron não é o
 * cwd de quem escreveu o roteiro: resolver relativo aqui mediria um arquivo
 * qualquer e devolveria um veredito sobre o arquivo errado. Byte nulo é recusado
 * antes do `statSync` porque lá ele vira exceção de plataforma, não resposta.
 */
function caminhoDeArquivo(bruto: string): CaminhoOk | CaminhoErro {
  const cru = (bruto ?? "").trim();
  if (!cru) return { ok: false, motivo: "caminho do arquivo vazio" };
  if (cru.includes("\0")) {
    return { ok: false, motivo: "caminho contém byte nulo" };
  }
  if (!isAbsolute(cru)) {
    return {
      ok: false,
      motivo: `caminho relativo recusado: "${cru}". Informe o caminho absoluto do arquivo a medir.`,
    };
  }
  return { ok: true, caminho: normalize(cru) };
}

const mib = (bytes: number): string =>
  `${(bytes / 1024 / 1024).toFixed(2)} MiB`;

// ---- positive-evidence ----

/**
 * Formas de output que afirmam sucesso sem medir nada. A lista é atalho para uma
 * mensagem melhor; quem realmente reprova é a ausência de dígito — evidência
 * positiva é um NÚMERO observado (bytes, duração, contagem, exit code), não um
 * adjetivo. O preço é o falso positivo do output legítimo sem número; é o lado
 * barato de errar, porque a saída é colar a medida.
 */
const OUTPUT_VAZIO =
  /^(ok(ay)?|funcionou|funciona|funcionando|passou|deu certo|tudo certo|sucesso|success|feito|pronto|done|works?|fine|sim|yes|no errors?|sem erros?|nenhum erro|✓|✅)[.!…]*$/i;

// ---- executores ----

const toneLint: GateExecutor = ({ contract, material }) => {
  // `tone` vem do JSON.parse do store, que já garante objeto; o `?? {}` cobre só
  // o contrato montado à mão fora do store. Sem adaptação de grafia: o tipo do
  // spec é um só (snake_case), o mesmo que o YAML do atelier escreve.
  const r = lintTexto(material, contract.tone ?? {});
  const blocking = temBloqueio(r.violacoes);
  const bloqueantes = r.violacoes.filter((v) => v.bloqueante).length;

  const cabecalho = r.violacoes.length
    ? `${r.violacoes.length} violação(ões) de tom (${bloqueantes} bloqueante(s)) em ${r.metricas.frases} frase(s), ${r.metricas.palavras} palavras.`
    : `Nenhuma violação de tom em ${r.metricas.frases} frase(s), ${r.metricas.palavras} palavras.`;

  const corpo = r.violacoes.map(
    (v) =>
      `L${v.linha}:${v.coluna} [${v.severidade ?? "sem severidade"}] ${v.id} — ${v.mensagem}\n  trecho: ${v.trecho}`,
  );

  // Regra pulada entra na evidência: regra que some sem rastro é pior que regra
  // que reprova — quem lê precisa saber o que NÃO foi verificado.
  const rodape = [...r.puladas, ...r.naoImplementadas].map(
    (s) => `regra não aplicada: ${s.id} (${s.motivo})`,
  );

  return {
    passed: r.violacoes.length === 0,
    blocking,
    status: r.violacoes.length ? "failed" : "passed",
    evidence: [cabecalho, ...corpo, ...rodape].join("\n"),
    details: {
      violacoes: r.violacoes,
      metricas: r.metricas,
      margens: r.margens,
      naoImplementadas: r.naoImplementadas,
      puladas: r.puladas,
    },
  };
};

const forbiddenFacts: GateExecutor = ({ contract, material, track }) => {
  const fatos = contract.forbiddenFacts ?? [];
  const aplicaveis = fatos.filter(
    (f) => proibe(f) && seAplica(f.appliesTo, track),
  );
  const ignorados = fatos.filter((f) => !aplicaveis.includes(f));

  const achados = aplicaveis.flatMap((f) =>
    buscar(
      material,
      f.forms ?? [],
      f.id,
      (termo) => `fato proibido "${f.id}": "${termo}"`,
      f.neutralForm || null,
    ),
  );

  const escopo = track ? ` (trilha "${track}")` : "";
  const cabecalho = achados.length
    ? `${achados.length} ocorrência(s) de fato proibido no material${escopo}.`
    : `Nenhum fato proibido no material${escopo}: ${aplicaveis.length} fato(s) verificado(s), ${ignorados.length} não aplicável(is).`;

  return {
    passed: achados.length === 0,
    blocking: achados.length > 0,
    status: achados.length ? "failed" : "passed",
    evidence: [cabecalho, ...achados.map((a) => a.linha)].join("\n"),
    details: {
      findings: achados.map((a) => a.finding),
      track: track ?? null,
      verificados: aplicaveis.map((f) => f.id),
      naoAplicaveis: ignorados.map((f) => ({ id: f.id, status: f.status })),
    },
  };
};

const scope: GateExecutor = ({ contract, material }) => {
  const itens: OutOfScopeItem[] = contract.outOfScope ?? [];

  const achados = itens.flatMap((i) =>
    buscar(
      material,
      i.forms ?? [],
      i.id,
      (termo) =>
        `assunto fora de escopo "${i.item}": "${termo}"${i.owner ? ` — é trabalho de ${i.owner}` : ""}`,
      null,
    ),
  );

  const cabecalho = achados.length
    ? `${achados.length} ocorrência(s) de assunto fora de escopo no material.`
    : `Nenhum assunto fora de escopo no material: ${itens.length} item(ns) verificado(s).`;

  return {
    passed: achados.length === 0,
    blocking: achados.length > 0,
    status: achados.length ? "failed" : "passed",
    evidence: [cabecalho, ...achados.map((a) => a.linha)].join("\n"),
    details: {
      findings: achados.map((a) => a.finding),
      verificados: itens.map((i) => i.id),
    },
  };
};

const deliveryLimit: GateExecutor = ({ contract, material, channel }) => {
  const canal = (channel ?? "").trim();
  const limite = (contract.deliveryLimits ?? []).find(
    (l) => l.channel.trim().toLowerCase() === canal.toLowerCase(),
  );

  // Sem canal ou sem limite declarado o gate não tem o que medir. Isso é
  // `skipped`, não aprovação: `passed` fica true (nada impede a entrega) e a
  // evidência diz, com todas as letras, que nada foi medido.
  if (!canal) {
    return {
      passed: true,
      blocking: false,
      status: "skipped",
      evidence:
        "Nenhum canal informado: o limite de entrega não foi verificado.",
      details: {
        canaisDeclarados: (contract.deliveryLimits ?? []).map((l) => l.channel),
      },
    };
  }
  if (!limite) {
    return {
      passed: true,
      blocking: false,
      status: "skipped",
      evidence: `O contrato não declara limite para o canal "${canal}": nada foi medido.`,
      details: {
        canal,
        canaisDeclarados: (contract.deliveryLimits ?? []).map((l) => l.channel),
      },
    };
  }

  const caminho = caminhoDeArquivo(material);
  if (!caminho.ok) {
    return {
      passed: false,
      blocking: true,
      status: "error",
      evidence: `delivery-limit não pôde medir o arquivo: ${caminho.motivo}`,
      details: { canal, motivo: caminho.motivo, material },
    };
  }

  let bytes: number;
  try {
    const st = statSync(caminho.caminho);
    if (!st.isFile()) {
      return {
        passed: false,
        blocking: true,
        status: "error",
        evidence: `delivery-limit não pôde medir: "${caminho.caminho}" não é um arquivo.`,
        details: { canal, caminho: caminho.caminho },
      };
    }
    bytes = st.size;
  } catch (err) {
    // Exceção crua de `statSync` (ENOENT, EACCES) vira resultado, nunca sobe:
    // um gate que explode no MCP some do histórico e a sessão segue produzindo.
    const motivo = err instanceof Error ? err.message : String(err);
    return {
      passed: false,
      blocking: true,
      status: "error",
      evidence: `delivery-limit não pôde medir "${caminho.caminho}": ${motivo}`,
      details: { canal, caminho: caminho.caminho, erro: motivo },
    };
  }

  // Duração declarada não é medida aqui: `maxDurationSec` exigiria ffprobe, e
  // executor de processo externo está explicitamente fora do escopo da feature.
  // Fica registrado como não verificado em vez de silenciosamente "passou".
  const duracaoNaoVerificada =
    typeof limite.maxDurationSec === "number" && limite.maxDurationSec > 0;

  if (typeof limite.maxBytes !== "number" || limite.maxBytes <= 0) {
    return {
      passed: true,
      blocking: false,
      status: "skipped",
      evidence: `O canal "${canal}" não declara limite de bytes: arquivo tem ${bytes} B (${mib(bytes)}), medido mas não comparado.`,
      details: {
        canal,
        bytes,
        caminho: caminho.caminho,
        duracaoNaoVerificada,
      },
    };
  }

  const excedeu = bytes > limite.maxBytes;
  const numeros = `${bytes} B (${mib(bytes)}) contra o limite de ${limite.maxBytes} B (${mib(limite.maxBytes)}) do canal "${canal}"`;
  const nota = duracaoNaoVerificada
    ? `\nlimite de duração (${limite.maxDurationSec}s) NÃO verificado: exige processo externo.`
    : "";

  return {
    passed: !excedeu,
    blocking: excedeu,
    status: excedeu ? "failed" : "passed",
    evidence: excedeu
      ? `Arquivo acima do limite: ${numeros}. Excesso de ${bytes - limite.maxBytes} B.${nota}`
      : `Arquivo dentro do limite: ${numeros}. Folga de ${limite.maxBytes - bytes} B.${nota}`,
    details: {
      canal,
      caminho: caminho.caminho,
      bytes,
      maxBytes: limite.maxBytes,
      folga: limite.maxBytes - bytes,
      duracaoNaoVerificada,
    },
  };
};

const scopeChecklist: GateExecutor = ({ contract, attestation }) => {
  const itens: OutOfScopeItem[] = contract.outOfScope ?? [];
  const respostas = attestation?.answers ?? {};

  const semResposta = itens.filter(
    (i) => !String(respostas[i.id] ?? "").trim(),
  );

  const findings: ContentGateFinding[] = semResposta.map((i) => ({
    rule: i.id,
    severity: "bloqueante",
    message: `sem atestação para "${i.item}"${i.question ? `: ${i.question}` : ""}`,
    line: null,
    column: null,
    excerpt: null,
  }));

  if (!itens.length) {
    return {
      passed: true,
      blocking: false,
      status: "skipped",
      evidence:
        "O contrato não declara itens fora de escopo: nada a atestar neste gate.",
      details: { findings: [], pendentes: [] },
    };
  }

  const cabecalho = semResposta.length
    ? `${semResposta.length} de ${itens.length} item(ns) fora de escopo sem atestação.`
    : `Todos os ${itens.length} item(ns) fora de escopo foram atestados.`;

  return {
    passed: semResposta.length === 0,
    blocking: semResposta.length > 0,
    status: semResposta.length ? "failed" : "passed",
    evidence: [
      cabecalho,
      ...semResposta.map(
        (i) =>
          `pendente: ${i.id} — ${i.question ?? i.item}${i.owner ? ` (responsável: ${i.owner})` : ""}`,
      ),
      ...itens
        .filter((i) => !semResposta.includes(i))
        .map((i) => `atestado: ${i.id} — ${String(respostas[i.id]).trim()}`),
    ].join("\n"),
    details: {
      findings,
      pendentes: semResposta.map((i) => i.id),
      atestados: itens.filter((i) => !semResposta.includes(i)).map((i) => i.id),
    },
  };
};

const positiveEvidence: GateExecutor = ({ attestation }) => {
  const comando = String(attestation?.command ?? "").trim();
  const saida = String(attestation?.output ?? "").trim();

  const problemas: string[] = [];
  if (!comando) problemas.push("nenhum comando informado (`command` vazio)");
  if (!saida) problemas.push("nenhuma saída informada (`output` vazio)");
  else if (OUTPUT_VAZIO.test(saida)) {
    problemas.push(
      `a saída "${saida}" afirma sucesso sem medir nada; cole o output literal do comando`,
    );
  } else if (!/\d/.test(saida)) {
    problemas.push(
      "a saída não contém nenhuma medida literal (nenhum número): evidência positiva é o valor observado, não a afirmação de que funcionou",
    );
  }

  const findings: ContentGateFinding[] = problemas.map((p) => ({
    rule: "positive-evidence",
    severity: "bloqueante",
    message: p,
    line: null,
    column: null,
    excerpt: saida || null,
  }));

  return {
    passed: problemas.length === 0,
    blocking: problemas.length > 0,
    status: problemas.length ? "failed" : "passed",
    evidence: problemas.length
      ? [
          `Evidência positiva insuficiente.`,
          ...problemas.map((p) => `- ${p}`),
        ].join("\n")
      : `Evidência positiva aceita.\ncomando: ${comando}\nsaída: ${saida}`,
    details: { findings, command: comando || null, output: saida || null },
  };
};

/**
 * Registry exportado = injeção testável: o teste troca uma entrada por stub e
 * prova o despacho sem tocar em banco nem em disco.
 */
export const GATE_REGISTRY: Record<ContentGateKind, GateExecutor> = {
  "tone-lint": toneLint,
  "forbidden-facts": forbiddenFacts,
  scope,
  "delivery-limit": deliveryLimit,
  "scope-checklist": scopeChecklist,
  "positive-evidence": positiveEvidence,
};

/**
 * Lê o registry na hora da chamada (não na carga do módulo) — é o que faz a
 * troca por stub valer. `kind` desconhecido devolve `error` em vez de lançar:
 * quem chama é uma MCP tool, e exceção lá vira uma sessão sem resposta em vez de
 * um gate reprovado.
 */
export function runGate(kind: ContentGateKind, input: GateInput): GateOutcome {
  const executor = GATE_REGISTRY[kind];
  if (!executor) {
    return {
      passed: false,
      blocking: true,
      status: "error",
      evidence: `gate desconhecido: "${kind}"`,
      details: { kind, conhecidos: Object.keys(GATE_REGISTRY) },
    };
  }
  return executor(input);
}
