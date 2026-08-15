import type {
  AllowedFactScope,
  ContentContractStatus,
  ContentGateKind,
  ContentGateRun,
  ContentGateSeverity,
  ForbiddenFactStatus,
} from '../../../shared/types/ipc'

// Labels e cores da área de Conteúdo. Tokens de tema (var(--color-*)), mesmo
// vocabulário visual de dossier-labels/JobsArea — nada de cor literal.

export const GATE_KIND_LABEL: Record<ContentGateKind, string> = {
  'tone-lint': 'Tom',
  'forbidden-facts': 'Fatos proibidos',
  scope: 'Escopo',
  'scope-checklist': 'Checklist de escopo',
  'delivery-limit': 'Limite de entrega',
  'positive-evidence': 'Evidência positiva',
}

// Analítico roda sozinho sobre o material; atestação depende de respostas no
// payload. A distinção aparece na UI porque um gate de atestação sem resposta
// reprova por omissão, não por defeito do material.
export const GATE_KIND_NATURE: Record<ContentGateKind, 'analítico' | 'atestação'> = {
  'tone-lint': 'analítico',
  'forbidden-facts': 'analítico',
  scope: 'analítico',
  'delivery-limit': 'analítico',
  'scope-checklist': 'atestação',
  'positive-evidence': 'atestação',
}

// Resultado legível de um run. 'blocked' não é um `ContentGateStatus`: é
// 'failed' com achado bloqueante — a distinção existe porque bloqueante
// significa NÃO ENTREGÁVEL, enquanto reprovar só por aviso é recuperável.
export type GateOutcome = 'passed' | 'failed' | 'blocked' | 'skipped' | 'error'

export const GATE_OUTCOME_LABEL: Record<GateOutcome, string> = {
  passed: 'Passou',
  failed: 'Reprovou',
  blocked: 'Bloqueante',
  skipped: 'Pulado',
  error: 'Erro',
}

// Só o bloqueante usa `danger`: reprovar por aviso é recuperável (tom de
// atenção, mesmo critério do interrupted/missed em JobsArea) e 'error' é falha
// de execução do gate — nunca pode ser lido como aprovação, daí o warning.
export const GATE_OUTCOME_COLOR: Record<GateOutcome, string> = {
  passed: 'var(--color-success)',
  failed: 'var(--color-warning)',
  blocked: 'var(--color-danger)',
  skipped: 'var(--color-text-dim)',
  error: 'var(--color-warning)',
}

export function gateOutcome(run: Pick<ContentGateRun, 'status' | 'blockingCount'>): GateOutcome {
  if (run.status === 'skipped') return 'skipped'
  if (run.status === 'error') return 'error'
  // Bloqueante ganha de tudo: um run com achado bloqueante não é entregável,
  // mesmo que o status tivesse sido gravado como 'passed'.
  if (run.blockingCount > 0) return 'blocked'
  return run.status === 'passed' ? 'passed' : 'failed'
}

export const GATE_SEVERITY_LABEL: Record<ContentGateSeverity, string> = {
  bloqueante: 'Bloqueante',
  aviso: 'Aviso',
}

export const GATE_SEVERITY_COLOR: Record<ContentGateSeverity, string> = {
  bloqueante: 'var(--color-danger)',
  aviso: 'var(--color-warning)',
}

export const CONTRACT_STATUS_LABEL: Record<ContentContractStatus, string> = {
  draft: 'Rascunho',
  active: 'Vigente',
  archived: 'Arquivado',
}

export const CONTRACT_STATUS_COLOR: Record<ContentContractStatus, string> = {
  draft: 'var(--color-text-dim)',
  active: 'var(--color-success)',
  archived: 'var(--color-text-dim)',
}

export const ALLOWED_SCOPE_LABEL: Record<AllowedFactScope, string> = {
  afirmavel: 'Afirmável',
  condicional: 'Condicional',
  'somente-com-fonte': 'Só com fonte',
}

export const FORBIDDEN_STATUS_LABEL: Record<ForbiddenFactStatus, string> = {
  proibido: 'Proibido',
  liberado: 'Liberado',
  'confirmado-falso': 'Confirmado falso',
}

// 'liberado' é o único que saiu da proibição depois de checado contra fonte
// primária; os outros dois continuam barrando o material.
export const FORBIDDEN_STATUS_COLOR: Record<ForbiddenFactStatus, string> = {
  proibido: 'var(--color-danger)',
  liberado: 'var(--color-success)',
  'confirmado-falso': 'var(--color-danger)',
}
