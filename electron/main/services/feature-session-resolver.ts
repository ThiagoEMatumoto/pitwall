// PURO: "qual feature é esta sessão?" enquanto ela roda. O auto-registro do fim
// de sessão (FeatureMemory.resolveFeature) responde no exit e pode CRIAR feature;
// aqui é só-match e contínuo: reexecuta quando a branch do transcript ou o cwd
// mudam, com os mesmos sinais (findFeatureByRepoBranch, fuzzy com o limiar de
// vínculo) mais o worktree registrado em feature_repos. Nunca cria feature.
import {
  FUZZY_LINK_THRESHOLD,
  fuzzyScore,
  normalizeBranch,
} from './feature-heuristics'

export type FeatureMatchBy = 'branch' | 'worktree' | 'fuzzy'

export interface FeatureMatch {
  featureId: string
  by: FeatureMatchBy
}

// Branch ATUAL da sessão: a última vista na cauda do transcript, inclusive
// main/develop. Não é o critério do digest (pickWorkBranch, a última
// não-protegida): aqui a pergunta é "onde a sessão está agora", e voltar para a
// main precisa soltar o vínculo que a feat/* tinha posto — com pickWorkBranch a
// feat/* antiga seguia na cauda e o card nunca soltava a sessão.
export function branchFromTail(tail: string): string | null {
  let current: string | null = null
  for (const m of tail.matchAll(/"gitBranch"\s*:\s*"([^"]*)"/g)) {
    const b = normalizeBranch(m[1])
    if (b) current = b
  }
  return current
}

export interface WorktreeRow {
  featureId: string
  // Já resolvido para absoluto.
  worktreePath: string
  // Raiz do repo: worktree_path igual a ela não identifica feature nenhuma (o
  // auto-registro grava a raiz como "worktree" de toda feature criada na main).
  repoPath: string
}

const trimSlash = (p: string) => p.replace(/\/+$/, '')

// cwd dentro de um worktree registrado → aquela feature (o mais específico vence).
export function matchWorktree(cwd: string | null, rows: WorktreeRow[]): string | null {
  if (!cwd) return null
  const here = trimSlash(cwd)
  let best: { featureId: string; len: number } | null = null
  for (const r of rows) {
    const wt = trimSlash(r.worktreePath)
    if (!wt || wt === trimSlash(r.repoPath)) continue
    if (here !== wt && !here.startsWith(`${wt}/`)) continue
    if (!best || wt.length > best.len) best = { featureId: r.featureId, len: wt.length }
  }
  return best?.featureId ?? null
}

// Melhor título acima do limiar de VÍNCULO (o do meio só serve pra suspeita no
// auto-registro, que aqui não existe).
export function matchFuzzy(
  prompt: string | null,
  features: Array<{ id: string; title: string }>,
): string | null {
  if (!prompt) return null
  let best: { id: string; score: number } | null = null
  for (const f of features) {
    const score = fuzzyScore(prompt, f.title)
    if (!best || score > best.score) best = { id: f.id, score }
  }
  return best && best.score >= FUZZY_LINK_THRESHOLD ? best.id : null
}

export interface MatchSignals {
  byBranch: string | null
  byWorktree: string | null
  byFuzzy: string | null
}

// Worktree é o sinal mais forte (o diretório É da feature), depois a branch,
// por último o fuzzy do 1º prompt.
export function pickMatch(s: MatchSignals): FeatureMatch | null {
  if (s.byWorktree) return { featureId: s.byWorktree, by: 'worktree' }
  if (s.byBranch) return { featureId: s.byBranch, by: 'branch' }
  if (s.byFuzzy) return { featureId: s.byFuzzy, by: 'fuzzy' }
  return null
}

export type ContinuousDecision = { action: 'keep' } | { action: 'set'; featureId: string | null }

// sessions.feature_source (migration 053): quem pôs o vínculo atual.
export const MANUAL_FEATURE_SOURCE = 'manual'
const RESOLVER_PREFIX = 'resolver:'

export function resolverSource(by: FeatureMatchBy): string {
  return `${RESOLVER_PREFIX}${by}`
}

// O vínculo atual é DESTE resolvedor (e por qual sinal)? Qualquer outra origem
// — manual, spawn com feature, herança da mãe, legado — não é.
export function ownedFromSource(
  featureId: string | null,
  source: string | null,
): FeatureMatch | null {
  if (!featureId || !source?.startsWith(RESOLVER_PREFIX)) return null
  const by = source.slice(RESOLVER_PREFIX.length)
  return by === 'branch' || by === 'worktree' || by === 'fuzzy' ? { featureId, by } : null
}

// `owned`: o vínculo atual foi posto POR ESTE resolvedor (e como). Vínculo que
// ele não pôs — spawn com feature, herança da mãe, o auto-registro — nunca é
// trocado pela heurística. `manual`: o usuário escolheu ("Mover para feature…",
// inclusive "Sem feature") — nem uma sessão sem feature é vinculada de novo.
export function decideContinuous(args: {
  current: string | null
  owned: FeatureMatch | null
  match: FeatureMatch | null
  manual?: boolean
}): ContinuousDecision {
  const { current, owned, match, manual } = args
  if (manual) return { action: 'keep' }
  const ours = !!current && owned?.featureId === current
  if (current && !ours) return { action: 'keep' }
  if (match)
    return match.featureId === current
      ? { action: 'keep' }
      : { action: 'set', featureId: match.featureId }
  // O sinal que nos fez vincular sumiu (trocou de branch/cwd para algo sem
  // feature): solta. O fuzzy não depende de branch/cwd — fica.
  if (ours && owned!.by !== 'fuzzy') return { action: 'set', featureId: null }
  return { action: 'keep' }
}

// Filha nasce na frente da mãe quando quem a despachou não escolheu outra.
export function inheritFeatureId(
  explicit: string | null | undefined,
  motherFeatureId: string | null | undefined,
): string | null {
  return explicit || motherFeatureId || null
}
