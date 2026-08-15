import { createHash } from "node:crypto";
import * as store from "./content-contract-store";
import { runGate, type GateOutcome } from "./content-gates";
import type {
  ContentGateFinding,
  ContentGateRun,
  ContentGateSeverity,
  RunContentGateInput,
} from "../../../shared/types/ipc";

// Seam "rodar o gate E gravar a evidência", no molde de job-run-now: existe
// porque DOIS chamadores precisam exatamente da mesma sequência (a MCP tool
// content_gate_run e o handler IPC contentContracts:run-gate) e duplicá-la abriria
// espaço pra dois vereditos diferentes sobre o mesmo material.
//
// O módulo de gates continua folha (não conhece banco) e o store continua burro
// (não conhece gate): a costura é aqui. Não faz broadcast — quem chama decide o
// canal, como runJobNow faz.

/**
 * O tone-lint devolve `violacoes` (vocabulário do port do atelier) e os demais
 * gates devolvem `findings` já no formato persistido. Traduzir aqui, e não no
 * módulo de gates, mantém o port espelhando o original — e este é o único ponto
 * onde a evidência vira linha de banco.
 */
interface ToneViolationLike {
  id?: unknown;
  severidade?: unknown;
  mensagem?: unknown;
  linha?: unknown;
  coluna?: unknown;
  trecho?: unknown;
}

function severidadeDe(valor: unknown): ContentGateSeverity {
  return valor === "aviso" ? "aviso" : "bloqueante";
}

function findingsDe(details: Record<string, unknown>): ContentGateFinding[] {
  const prontos = details.findings;
  if (Array.isArray(prontos)) return prontos as ContentGateFinding[];

  const violacoes = details.violacoes;
  if (!Array.isArray(violacoes)) return [];
  return (violacoes as ToneViolationLike[]).map((v) => ({
    rule: typeof v.id === "string" ? v.id : "tone-lint",
    severity: severidadeDe(v.severidade),
    message: typeof v.mensagem === "string" ? v.mensagem : "",
    line: typeof v.linha === "number" ? v.linha : null,
    column: typeof v.coluna === "number" ? v.coluna : null,
    excerpt: typeof v.trecho === "string" ? v.trecho : null,
  }));
}

/**
 * Hash do material pra que dois runs do mesmo texto sejam reconhecíveis como o
 * mesmo material sem guardar o texto inteiro na row (delivery-limit hasheia o
 * caminho, que é o que ele recebeu — o arquivo em si não entra no banco).
 */
function hashDe(material: string): string {
  return createHash("sha256")
    .update(material, "utf8")
    .digest("hex")
    .slice(0, 16);
}

// `outcome` viaja junto com o run porque `blocking` não é derivável da row: um
// gate que não conseguiu medir sai com status 'error' e zero findings, e ainda
// assim é não-entregável. Quem responde ao modelo precisa do booleano, não de
// uma reinterpretação da contagem.
export interface GateRunResult {
  run: ContentGateRun;
  outcome: GateOutcome;
}

/**
 * Roda o gate contra a versão VIGENTE do contrato e grava a evidência. Reprovar
 * não lança: o run gravado com status 'failed' É o resultado, e quem decide o
 * que fazer com `blocking` é a sessão. Só lança quando não há contra o que rodar
 * (contrato inexistente) — aí não existe run pra gravar.
 */
export function runAndRecordGate(input: RunContentGateInput): GateRunResult {
  const contract = store.get(input.contractId);
  if (!contract)
    throw new Error(`content contract não encontrado: ${input.contractId}`);

  const outcome = runGate(input.gate, {
    contract,
    material: input.material,
    channel: input.channel ?? null,
    track: input.track ?? null,
    attestation: input.attestation ?? null,
  });

  const findings = findingsDe(outcome.details);
  const run = store.createGateRun({
    contractId: contract.id,
    // A versão vigente no momento do run, não a "mais recente" lida depois: a FK
    // composta amarra a evidência ao texto que valia quando o material foi medido.
    contractVersion: contract.version,
    gate: input.gate,
    status: outcome.status ?? (outcome.passed ? "passed" : "failed"),
    materialRef: input.materialRef ?? null,
    materialHash: hashDe(input.material),
    findings,
    evidence: outcome.evidence,
    blockingCount: findings.filter((f) => f.severity === "bloqueante").length,
    warningCount: findings.filter((f) => f.severity === "aviso").length,
  });
  return { run, outcome };
}
