/**
 * TONE-LINT — o gate mais barato do contrato de conteúdo.
 *
 * Port de `atelier/cli/lint-script.mjs`. Aplica as `hard_rules` de um tom já
 * resolvido a um texto e devolve as violações no estilo de um linter de código:
 * linha, coluna, trecho ofensor e a regra que reprovou. Não aborta e não decide:
 * devolve dados. Quem bloqueia é o chamador.
 *
 * A FONTE DAS REGRAS É O TOM, NÃO ESTE ARQUIVO. Nenhum limiar está hardcoded
 * aqui: os regexes vêm do campo `check` de cada regra e os limiares dos campos
 * `threshold*`. Regra sem implementação conhecida, ou com limiar ausente, é
 * reportada em `naoImplementadas` em vez de ser inventada — um lint que adivinha
 * a regra do autor é pior do que um que admite o buraco.
 *
 * O QUE MUDOU EM RELAÇÃO AO ORIGINAL DO ATELIÊ
 *
 * Ficaram de fora `lintArquivo`, o CLI (`parseArgs`/`main`) e os imports
 * `./lib/resolve.mjs` e `./lib/cas.mjs`. Duas consequências, ambas deliberadas:
 *
 *   1. Some a cascata de tons (ateliê > canal > peça > shot). Aqui a cascata é o
 *      próprio contrato de conteúdo: o `tone` chega já resolvido, como objeto
 *      vindo do JSON da coluna do banco. Nenhum parser de YAML entra neste
 *      módulo.
 *   2. Some a proveniência `violacao.from` — o arquivo:linha do YAML que
 *      escreveu a regra. No Pitwall a proveniência é a versão do contrato, que
 *      quem grava o gate run já registra. O campo continua na saída, sempre
 *      `null`, para não quebrar quem consome a forma do original; o `path`
 *      (`tone.hard_rules.N.id`) continua apontando a regra dentro do spec.
 *
 * Tudo é síncrono: o handler de MCP tool do repo devolve `ToolResult`, não
 * Promise.
 *
 * Calibração: o `paragrafo_canonico` do tom TEM que passar limpo. Se uma mudança
 * aqui reprovar o exemplar, o errado é a mudança.
 */

// ---------------------------------------------------------------- tipos

// O spec do tom é a MESMA estrutura que viaja na coluna JSON do contrato, então
// mora em `shared/types/ipc.ts` — daqui só sai a re-exportação, pra que quem já
// importava os tipos deste módulo continue funcionando. A direção é obrigatória:
// `shared/` compila também no renderer e não pode importar de `electron/main/**`.
import type {
  ToneHardRule,
  ToneSeverity,
  ToneSpec,
} from "../../../../shared/types/ipc";

export type { ToneHardRule, ToneSeverity, ToneSpec };

export interface ToneViolation {
  id: string;
  severidade: ToneSeverity | null;
  bloqueante: boolean;
  regra: string;
  porque: string | null;
  mensagem: string;
  offset: number;
  linha: number;
  coluna: number;
  trecho: string;
  /** caminho da regra dentro do spec, p.ex. `tone.hard_rules.3.id` */
  path: string;
  /** sempre null: a proveniência aqui é a versão do contrato, não o YAML */
  from: null;
}

/** Regra declarada no tom que não rodou, com o motivo. */
export interface ToneRuleSkip {
  id: string;
  motivo: string;
}

export interface ToneSecondPerson {
  ocorrencias: number;
  palavrasPorOcorrencia: number;
}

export interface ToneMetrics {
  palavras: number;
  frases: number;
  comprimentos: number[];
  maiorFrase: number;
  media: number;
  desvio: number;
  segundaPessoa: ToneSecondPerson | null;
  densidadeToneWords: number;
}

/** Valor medido vs limiar de uma regra estatística — a folga de calibração. */
export interface ToneMargin {
  id: string;
  medido: number;
  limiar: string;
  folga: number;
  /** só em `variacao-de-frase`: false quando a amostra ficou abaixo do n mínimo */
  aplicada?: boolean;
}

export interface ToneLintResult {
  violacoes: ToneViolation[];
  metricas: ToneMetrics;
  margens: ToneMargin[];
  naoImplementadas: ToneRuleSkip[];
  puladas: ToneRuleSkip[];
}

interface Frase {
  texto: string;
  terminador: string | null;
  inicio: number;
  fim: number;
  palavras: number;
}

// ---------------------------------------------------------------- texto

/**
 * Espaços no lugar do conteúdo, mesmo comprimento e mesmas quebras de linha:
 * mascarar sem mexer nos offsets é o que permite reportar linha/coluna do texto
 * ORIGINAL depois de ignorar as partes que não são narração.
 */
const branco = (s: string): string => s.replace(/[^\n]/g, " ");

/**
 * O que não é narração não é lintado: front matter, bloco de código cercado,
 * comentário HTML e linha de título ATX.
 *
 * Título entra nesta lista porque é rótulo de estrutura ("## shot 3 — abertura"),
 * e não texto que alguém vai locutar: lintá-lo geraria falso positivo de
 * travessão e de caixa alta, e ainda entraria como "frase" de 3 palavras nas
 * estatísticas de ritmo. Item de lista e ênfase NÃO entram: bullet é narração.
 */
export function mascararNaoProsa(src: string): string {
  const linhas = src.split("\n");
  let emCerca = false;
  let emFrontMatter = false;

  const saida = linhas.map((linha, i) => {
    if (i === 0 && /^---\s*$/.test(linha)) {
      emFrontMatter = true;
      return branco(linha);
    }
    if (emFrontMatter) {
      if (/^(---|\.\.\.)\s*$/.test(linha)) emFrontMatter = false;
      return branco(linha);
    }
    if (/^\s{0,3}(```|~~~)/.test(linha)) {
      emCerca = !emCerca;
      return branco(linha);
    }
    if (emCerca) return branco(linha);
    if (/^\s{0,3}#{1,6}\s/.test(linha)) return branco(linha);
    return linha;
  });

  return saida.join("\n").replace(/<!--[\s\S]*?-->/g, branco);
}

const RE_PALAVRA = /[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu;

const contarPalavras = (texto: string): number =>
  (texto.match(RE_PALAVRA) ?? []).length;

/**
 * `check: "split por [.!?] e contagem de tokens por frase"`.
 *
 * Além do que está escrito, linha em branco também fecha frase. Um roteiro em
 * bullets sem ponto final viraria uma única "frase" de 40 palavras e reprovaria
 * em `frase-curta` sem ter frase longa nenhuma — quebra de parágrafo é ponto
 * final em prosa.
 */
export function separarFrases(prosa: string): Frase[] {
  const frases: Frase[] = [];
  let inicio = 0;

  const fechar = (fim: number, terminador: string | null): void => {
    const bruto = prosa.slice(inicio, fim);
    const recuo = bruto.length - bruto.trimStart().length;
    const texto = bruto.trim();
    if (contarPalavras(texto)) {
      frases.push({
        texto,
        terminador,
        inicio: inicio + recuo,
        fim,
        palavras: contarPalavras(texto),
      });
    }
    inicio = fim;
  };

  for (let i = 0; i < prosa.length; i++) {
    const c = prosa[i];
    if (c === "." || c === "!" || c === "?") {
      let j = i;
      while (j + 1 < prosa.length && /[.!?]/.test(prosa[j + 1])) j++;
      fechar(j + 1, c);
      i = j;
      continue;
    }
    const linhaVazia = /^\n[ \t]*\n/.exec(prosa.slice(i));
    if (linhaVazia) {
      fechar(i, null);
      i += linhaVazia[0].length - 1;
    }
  }
  fechar(prosa.length, null);
  return frases;
}

function indexarLinhas(src: string): number[] {
  const inicios = [0];
  for (let i = 0; i < src.length; i++) {
    if (src[i] === "\n") inicios.push(i + 1);
  }
  return inicios;
}

function posicao(
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

const CONTEXTO = 18;

function recorte(src: string, inicio: number, fim: number): string {
  const a = Math.max(0, inicio - CONTEXTO);
  const b = Math.min(src.length, fim + CONTEXTO);
  const corpo = src.slice(a, b).replace(/\s+/g, " ").trim();
  return `${a > 0 ? "…" : ""}${corpo}${b < src.length ? "…" : ""}`;
}

const truncar = (s: string, n = 64): string =>
  s.replace(/\s+/g, " ").length > n
    ? `${s.replace(/\s+/g, " ").slice(0, n - 1)}…`
    : s.replace(/\s+/g, " ");

/** Desvio-padrão POPULACIONAL — é o que o autor usou ao medir o exemplar à mão. */
export function desvioPadrao(valores: number[]): number {
  if (valores.length < 2) return 0;
  const media = valores.reduce((a, b) => a + b, 0) / valores.length;
  const soma = valores.reduce((a, v) => a + (v - media) ** 2, 0);
  return Math.sqrt(soma / valores.length);
}

// ---------------------------------------------------------------- vocabulário

const escaparRegex = (s: string): string =>
  s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Busca literal, case-insensitive, com fronteira de palavra UNICODE.
 *
 * Duas decisões, ambas na direção de menos falso positivo:
 *   - fronteira em vez de substring crua: "elevar" não dispara dentro de
 *     "relevar", e "insight" não dispara dentro de "insights" (o preço é o
 *     falso negativo de flexão, que é o lado barato de errar);
 *   - `\b` do JS é ASCII e não fecha depois de "você" (ê não é \w), então a
 *     fronteira aqui é lookaround sobre \p{L}\p{N}.
 * Espaço no termo casa qualquer espaço, para o termo sobreviver à quebra de linha.
 */
function reTermo(termo: string): RegExp {
  const corpo = escaparRegex(termo.trim()).replace(/\s+/g, "\\s+");
  return new RegExp(`(?<![\\p{L}\\p{N}])${corpo}(?![\\p{L}\\p{N}])`, "giu");
}

export interface Ocorrencia {
  termo: string;
  inicio: number;
  fim: number;
}

/**
 * Exportada porque `forbidden-facts` e `scope` procuram formas literais com
 * exatamente esta semântica de fronteira: dois motores de busca diferentes no
 * mesmo contrato dariam vereditos diferentes para o mesmo texto.
 */
export function ocorrencias(
  texto: string,
  termos: readonly unknown[],
): Ocorrencia[] {
  const achados: Ocorrencia[] = [];
  for (const termo of termos) {
    if (typeof termo !== "string" || !termo.trim()) continue;
    for (const m of texto.matchAll(reTermo(termo))) {
      const inicio = m.index ?? 0;
      achados.push({ termo, inicio, fim: inicio + m[0].length });
    }
  }
  return achados;
}

/**
 * `check: "regex: <padrão>"` — o padrão é do autor e vai para o RegExp como está.
 * A flag `u` só entra quando o próprio padrão pede (`\u{...}`): ligá-la por
 * conta própria mudaria a semântica de um regex que o autor escreveu sem ela.
 */
function compilarCheck(check: unknown): RegExp | null {
  if (typeof check !== "string") return null;
  const m = /^\s*regex:\s*([\s\S]+?)\s*$/.exec(check);
  if (!m) return null;
  const fonte = m[1];
  try {
    return new RegExp(fonte, fonte.includes("\\u{") ? "gu" : "g");
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- regras

interface RegraComIndice extends ToneHardRule {
  indice: number;
}

interface Ctx {
  src: string;
  prosa: string;
  tone: ToneSpec | null | undefined;
  frases: Frase[];
  metricas: ToneMetrics;
  inicios: number[];
  violacoes: ToneViolation[];
  puladas: ToneRuleSkip[];
}

/** Devolve o motivo quando a regra não pôde rodar; null quando rodou. */
type ImplRegra = (ctx: Ctx, regra: RegraComIndice) => string | null;

interface Emissao {
  mensagem: string;
  inicio: number;
  fim?: number;
  trecho?: string;
}

const emitir = (
  ctx: Ctx,
  regra: RegraComIndice,
  { mensagem, inicio, fim, trecho }: Emissao,
): void => {
  ctx.violacoes.push({
    id: regra.id,
    severidade: regra.severidade ?? null,
    bloqueante: regra.severidade === "bloqueante",
    regra: String(regra.regra ?? "").trim(),
    porque: regra.porque ? String(regra.porque).trim() : null,
    mensagem,
    offset: inicio,
    ...posicao(ctx.inicios, inicio),
    trecho: trecho ?? recorte(ctx.src, inicio, fim ?? inicio),
    // a proveniência só existe em FOLHA: `hard_rules.3` não tem rastro, `.id` tem
    path: `tone.hard_rules.${regra.indice}.id`,
    from: null,
  });
};

/** Regra cujo veredito é o regex do tom rodando sobre a prosa. */
function regraRegex(rotulo: string): ImplRegra {
  return (ctx, regra) => {
    const re = compilarCheck(regra.check);
    if (!re) return `campo \`check\` não é um regex utilizável: ${regra.check}`;
    for (const m of ctx.prosa.matchAll(re)) {
      if (!m[0].length) continue;
      const inicio = m.index ?? 0;
      emitir(ctx, regra, {
        mensagem: `${rotulo}: "${truncar(m[0], 40)}"`,
        inicio,
        fim: inicio + m[0].length,
      });
    }
    return null;
  };
}

const REGRAS: Record<string, ImplRegra> = {
  "sem-travessao": regraRegex("travessão ou en dash"),
  "sem-triade": regraRegex(
    "tríade X, Y e Z (confira: vírgula antes de 'e' pode ser legítima)",
  ),
  "sem-exclamacao": regraRegex("ponto de exclamação"),
  "sem-emoji": regraRegex("emoji"),
  "sem-caixa-alta": regraRegex("palavra em caixa alta"),

  "sem-anti-tone-words": (ctx, regra) => {
    const lista = ctx.tone?.anti_tone_words;
    if (!Array.isArray(lista) || !lista.length) {
      return "tone.anti_tone_words ausente ou vazio";
    }
    for (const o of ocorrencias(ctx.prosa, lista)) {
      emitir(ctx, regra, {
        mensagem: `anti_tone_word: "${o.termo}"`,
        inicio: o.inicio,
        fim: o.fim,
      });
    }
    return null;
  },

  "frase-curta": (ctx, regra) => {
    const teto = regra.threshold;
    if (typeof teto !== "number") return "campo `threshold` ausente";
    for (const f of ctx.frases) {
      if (f.palavras > teto) {
        emitir(ctx, regra, {
          mensagem: `frase com ${f.palavras} palavras (teto ${teto})`,
          inicio: f.inicio,
          fim: f.fim,
          trecho: truncar(f.texto),
        });
      }
    }
    return null;
  },

  "media-de-frase": (ctx, regra) => {
    const min = regra.threshold_min;
    const max = regra.threshold_max;
    if (typeof min !== "number" || typeof max !== "number") {
      return "campos `threshold_min`/`threshold_max` ausentes";
    }
    const { media } = ctx.metricas;
    if (!ctx.frases.length || (media >= min && media <= max)) return null;
    emitir(ctx, regra, {
      mensagem: `média de ${media.toFixed(1)} palavras por frase (faixa ${min}-${max})`,
      inicio: ctx.frases[0]?.inicio ?? 0,
      trecho: `${ctx.frases.length} frases, ${ctx.metricas.palavras} palavras`,
    });
    return null;
  },

  "variacao-de-frase": (ctx, regra) => {
    const piso = regra.threshold;
    if (typeof piso !== "number") return "campo `threshold` ausente";
    // Abaixo do n mínimo declarado no tom, o desvio é ruído e a regra não opina:
    // em n=12 (tamanho de um Short) o bootstrap mede 10.2% de falso positivo
    // contra 4.1% em n=20. Aviso que dispara em 1 de cada 10 textos BONS treina
    // quem lê a ignorar o lint inteiro.
    // O skip é REGISTRADO: regra que some sem rastro é pior que regra que reprova.
    // Se o contrato vier sem `n_minimo_frases`, a regra não roda — ver `lintTexto`.
    const nMin = regra.n_minimo_frases;
    if (typeof nMin === "number" && ctx.frases.length < nMin) {
      ctx.puladas.push({
        id: regra.id,
        motivo: `amostra de ${ctx.frases.length} frases abaixo do mínimo de ${nMin}; desvio medido ${ctx.metricas.desvio.toFixed(2)} não é conclusivo`,
      });
      return null;
    }

    const { desvio } = ctx.metricas;
    if (ctx.frases.length < 2 || desvio >= piso) return null;
    emitir(ctx, regra, {
      mensagem: `desvio-padrão de ${desvio.toFixed(2)} palavras (mínimo ${piso})`,
      inicio: ctx.frases[0].inicio,
      trecho: `comprimentos: ${ctx.metricas.comprimentos.join(" / ")}`,
    });
    return null;
  },

  "abertura-nao-pergunta": (ctx, regra) => {
    const primeira = ctx.frases[0];
    if (!primeira || primeira.terminador !== "?") return null;
    emitir(ctx, regra, {
      mensagem: "a primeira frase é uma pergunta",
      inicio: primeira.inicio,
      fim: primeira.fim,
      trecho: truncar(primeira.texto),
    });
    return null;
  },

  "segunda-pessoa": (ctx, regra) => {
    const limiar = regra.threshold_palavras_por_ocorrencia;
    if (typeof limiar !== "number") {
      return "campo `threshold_palavras_por_ocorrencia` ausente";
    }
    // os pronomes vêm do próprio `check` do tom: "contagem de 'você'/'te'/..."
    const termos = [...String(regra.check ?? "").matchAll(/'([^']+)'/g)].map(
      (m) => m[1],
    );
    if (!termos.length) return "nenhum pronome citado no campo `check`";

    const n = ocorrencias(ctx.prosa, termos).length;
    const razao = n ? ctx.metricas.palavras / n : Infinity;
    ctx.metricas.segundaPessoa = {
      ocorrencias: n,
      palavrasPorOcorrencia: razao,
    };
    if (razao <= limiar) return null;
    emitir(ctx, regra, {
      mensagem: n
        ? `1 ocorrência a cada ${razao.toFixed(1)} palavras (máximo ${limiar})`
        : `nenhuma ocorrência de ${termos.map((t) => `"${t}"`).join("/")} em ${ctx.metricas.palavras} palavras`,
      inicio: ctx.frases[0]?.inicio ?? 0,
      trecho: `${n} ocorrência(s) em ${ctx.metricas.palavras} palavras`,
    });
    return null;
  },
};

// ---------------------------------------------------------------- API

/**
 * Roda as hard_rules de um tom já resolvido sobre um texto.
 * Não aborta e não decide: devolve dados. Quem bloqueia é o chamador.
 */
export function lintTexto(
  src: string,
  tone: ToneSpec | null | undefined,
): ToneLintResult {
  const prosa = mascararNaoProsa(src);
  const frases = separarFrases(prosa);
  const comprimentos = frases.map((f) => f.palavras);
  const palavras = comprimentos.reduce((a, b) => a + b, 0);

  const metricas: ToneMetrics = {
    palavras,
    frases: frases.length,
    comprimentos,
    maiorFrase: comprimentos.length ? Math.max(...comprimentos) : 0,
    media: frases.length ? palavras / frases.length : 0,
    desvio: desvioPadrao(comprimentos),
    segundaPessoa: null,
    densidadeToneWords: palavras
      ? (ocorrencias(prosa, tone?.tone_words ?? []).length / palavras) * 100
      : 0,
  };

  const ctx: Ctx = {
    src,
    prosa,
    tone,
    frases,
    metricas,
    inicios: indexarLinhas(src),
    violacoes: [],
    puladas: [],
  };

  const naoImplementadas: ToneRuleSkip[] = [];
  const regras = Array.isArray(tone?.hard_rules) ? tone.hard_rules : [];
  regras.forEach((bruta, indice) => {
    if (!bruta?.id) return;
    const regra: RegraComIndice = { ...bruta, indice };
    const impl = REGRAS[regra.id];
    if (!impl) {
      naoImplementadas.push({ id: regra.id, motivo: "sem implementação" });
      return;
    }
    // Amostra mínima ausente no spec = regra estatística não roda. O contrato do
    // Pitwall é editável por LLM: um `n_minimo_frases` que caiu no caminho faria
    // `variacao-de-frase` voltar a reprovar ~10% dos textos bons em silêncio.
    if (
      regra.id === "variacao-de-frase" &&
      typeof regra.n_minimo_frases !== "number"
    ) {
      ctx.puladas.push({
        id: regra.id,
        motivo:
          "campo `n_minimo_frases` ausente no tom; sem amostra mínima declarada o desvio-padrão não é conclusivo e a regra não opina",
      });
      return;
    }
    const problema = impl(ctx, regra);
    if (problema) naoImplementadas.push({ id: regra.id, motivo: problema });
  });

  ctx.violacoes.sort((a, b) => a.offset - b.offset || a.id.localeCompare(b.id));
  return {
    violacoes: ctx.violacoes,
    metricas,
    // as margens saem junto porque só fazem sentido depois das regras rodarem:
    // `segundaPessoa` só existe em `metricas` após a regra que a mede
    margens: margens(tone, metricas),
    naoImplementadas,
    puladas: ctx.puladas,
  };
}

export const temBloqueio = (violacoes: readonly ToneViolation[]): boolean =>
  violacoes.some((v) => v.bloqueante);

/** Valor medido vs limiar de cada regra estatística — a folga de calibração. */
export function margens(
  tone: ToneSpec | null | undefined,
  metricas: ToneMetrics,
): ToneMargin[] {
  const regra = (id: string): ToneHardRule | undefined =>
    (Array.isArray(tone?.hard_rules) ? tone.hard_rules : []).find(
      (r) => r?.id === id,
    );
  const out: ToneMargin[] = [];

  const curta = regra("frase-curta");
  if (typeof curta?.threshold === "number") {
    out.push({
      id: "frase-curta",
      medido: metricas.maiorFrase,
      limiar: `<= ${curta.threshold}`,
      folga: curta.threshold - metricas.maiorFrase,
    });
  }

  const media = regra("media-de-frase");
  if (
    typeof media?.threshold_min === "number" &&
    typeof media.threshold_max === "number"
  ) {
    out.push({
      id: "media-de-frase",
      medido: Number(metricas.media.toFixed(2)),
      limiar: `${media.threshold_min}..${media.threshold_max}`,
      folga: Math.min(
        metricas.media - media.threshold_min,
        media.threshold_max - metricas.media,
      ),
    });
  }

  const variacao = regra("variacao-de-frase");
  if (typeof variacao?.threshold === "number") {
    out.push({
      id: "variacao-de-frase",
      medido: Number(metricas.desvio.toFixed(2)),
      limiar: `>= ${variacao.threshold}`,
      folga: metricas.desvio - variacao.threshold,
      // a folga continua informativa, mas sem n suficiente ela não julga nada
      aplicada:
        typeof variacao.n_minimo_frases === "number" &&
        metricas.frases >= variacao.n_minimo_frases,
    });
  }

  const segunda = regra("segunda-pessoa");
  if (
    typeof segunda?.threshold_palavras_por_ocorrencia === "number" &&
    metricas.segundaPessoa
  ) {
    const r = metricas.segundaPessoa.palavrasPorOcorrencia;
    out.push({
      id: "segunda-pessoa",
      medido: Number.isFinite(r) ? Number(r.toFixed(2)) : Infinity,
      limiar: `<= ${segunda.threshold_palavras_por_ocorrencia}`,
      folga: segunda.threshold_palavras_por_ocorrencia - r,
    });
  }

  if (typeof tone?.densidade_tone_words_min_por_100_palavras === "number") {
    const min = tone.densidade_tone_words_min_por_100_palavras;
    out.push({
      id: "densidade-tone-words (informativo)",
      medido: Number(metricas.densidadeToneWords.toFixed(2)),
      limiar: `>= ${min}`,
      folga: metricas.densidadeToneWords - min,
    });
  }

  return out;
}
