import type { IssueLevel, LoopIssue } from '../../../shared/feature-loop'

// A issue de duplicata precisa carregar o candidato pra UI conseguir dizer
// "possível duplicata de «X»" e LEVAR até ele — a mensagem sozinha nomeia o
// candidato mas não dá o id. `LoopIssue` (shared) é o shape mínimo; a extensão
// mora aqui porque shared/ não é editável nesta frente.
export interface FeatureIssue extends LoopIssue {
  candidateId?: string
  candidateTitle?: string
}

// A suspeita como o backend a expõe (features.duplicate_of resolvido:
// `{ candidateId, title, score }`). Dois nomes de id porque o serviço do main
// usa `candidateId` e o LoopInput usa `featureId` pro mesmo ponteiro.
export interface DuplicateSuspectLike {
  candidateId?: string
  featureId?: string
  title?: string | null
}

export const DUPLICATE_SUSPECT = 'duplicate_suspect'

// "Sem OKR" não é um code de issuesOf() — hoje é uma derivação de
// objectiveLinkCount === 0 (mesmo dado do badge da lista). A faixa sintetiza a
// issue no cliente, mas cede a vez se o backend já emitir um code da família.
export const OKR_MISSING = 'okr_missing'
const OKR_CODES = new Set([OKR_MISSING, 'objective_link_missing', 'no_objective_link'])

export type IssueAction = 'open-candidate' | 'edit-pulse' | 'edit-objective' | 'link-okr' | null

const LEVEL_ORDER: Record<IssueLevel, number> = { error: 0, warn: 1, info: 2 }

// Cor por nível — tokens do design system, mesma receita do LIVENESS_META.
export const ISSUE_LEVEL_META: Record<IssueLevel, { label: string; color: string }> = {
  error: { label: 'erro', color: 'var(--color-danger)' },
  warn: { label: 'atenção', color: 'var(--color-warning)' },
  info: { label: 'nota', color: 'var(--color-info)' },
}

// error → warn → info, preservando a ordem original dentro do nível (o
// issuesOf já emite numa sequência pensada; a faixa não a embaralha).
export function sortIssues(issues: readonly FeatureIssue[]): FeatureIssue[] {
  return [...issues].sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level])
}

// Candidato da issue de duplicata: primeiro os campos da própria issue,
// depois a suspeita que veio junto do snapshot. Sem id não há ação — a faixa
// mostra a mensagem e cala em vez de oferecer um link que não navega.
export function duplicateCandidate(
  issue: FeatureIssue,
  suspect?: DuplicateSuspectLike | null,
): { id: string; title: string } | null {
  if (issue.code !== DUPLICATE_SUSPECT) return null
  const id = issue.candidateId ?? suspect?.candidateId ?? suspect?.featureId ?? ''
  if (id === '') return null
  const title = (issue.candidateTitle ?? suspect?.title ?? '')?.trim()
  return { id, title: title || 'outra feature' }
}

// A suspeita anexada ao snapshot do loop (campo que o backend da Fase 4
// acrescenta ao FeatureLoopSnapshot). Lida por cast pelo mesmo motivo do
// feature-pin: a UI programa contra a assinatura antes de ela existir.
export function readDuplicateSuspect(snapshot: unknown): DuplicateSuspectLike | null {
  const suspect = (snapshot as { duplicateSuspect?: DuplicateSuspectLike | null } | null)
    ?.duplicateSuspect
  return suspect ?? null
}

export function issueAction(code: string): IssueAction {
  if (code === DUPLICATE_SUSPECT) return 'open-candidate'
  if (code === 'pulse_missing' || code === 'pulse_too_long') return 'edit-pulse'
  if (code === 'objective_missing' || code === 'objective_too_long') return 'edit-objective'
  if (OKR_CODES.has(code)) return 'link-okr'
  return null
}

// Acrescenta a issue de "sem OKR" quando o vínculo falta e o backend ainda não
// falou sobre isso. Sem OKR a feature fica fora do rollup — é higiene, não
// erro: nível info.
export function withOkrIssue(
  issues: readonly FeatureIssue[],
  objectiveLinkCount: number,
): FeatureIssue[] {
  if (objectiveLinkCount > 0) return [...issues]
  if (issues.some((i) => OKR_CODES.has(i.code))) return [...issues]
  return [
    ...issues,
    {
      level: 'info',
      code: OKR_MISSING,
      message: 'Sem vínculo com objetivo/KR: a feature fica fora do rollup dos OKRs.',
    },
  ]
}

// Ponteiro de duplicata já persistido na projeção da feature
// (features.duplicate_of). Quando ele chega junto da lista, a fila de triagem
// não precisa sondar o loop feature a feature.
export function duplicateOfFeature(feature: unknown): string | null {
  const value = (feature as { duplicateOf?: string | null } | null)?.duplicateOf
  return typeof value === 'string' && value !== '' ? value : null
}

// ---- Fila de triagem (filtro "Rascunhos") ----

export interface TriageInput {
  id: string
  origin: string
}

// A fila junta os dois modos de a feature nascer solta: criada por um agente
// (origin 'auto') ou marcada como possível duplicata. Antes o filtro mostrava
// só auto-criadas SEM registro — a duplicata de uma feature ativa nunca
// aparecia em lugar nenhum, que é exatamente a queixa original.
export function selectTriage<T extends TriageInput>(
  features: T[],
  suspectIds: ReadonlySet<string>,
): T[] {
  return features.filter((f) => f.origin === 'auto' || suspectIds.has(f.id))
}
