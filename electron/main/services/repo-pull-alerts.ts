import type { BranchPullOutcome, PullRepoResult } from '../../../shared/types/ipc'

// Um repo travado no auto-pull era só uma linha no histórico do job: legal-core
// ficou 12 dias (480 commits) atrás sem ninguém ver. Aqui decidimos quando isso
// vira notificação: o MESMO repo com problema em N runs seguidas.
export const STUCK_RUN_THRESHOLD = 3

// Pulos que são trabalho do usuário em andamento (árvore suja, commits locais)
// não alertam: ele sabe que está ali. Alertam os estruturais (HEAD destacado,
// mesmo sujo, porque não se resolve sozinho; sem upstream; operação git parada;
// colisão de untracked) quando deixam o checkout para trás.
const ACTIVE_WORK = new Set([
  'dirty',
  'diverged',
  'checked-out-elsewhere-dirty',
  'checked-out-elsewhere-diverged',
])

function isActiveWork(detail: string | undefined): boolean {
  return ACTIVE_WORK.has(detail ?? '')
}

function stuckBranch(result: PullRepoResult): BranchPullOutcome | undefined {
  return (result.branches ?? []).find(
    (b) => b.status === 'skipped' && (b.behind ?? 0) > 0 && !isActiveWork(b.detail),
  )
}

export function isStuck(result: PullRepoResult): boolean {
  return result.status === 'error' || stuckBranch(result) !== undefined
}

export interface StuckRepo {
  repoId: string
  label: string
  reason: string
  behind?: number
}

// `runs` vem da mais nova para a mais antiga (ordem de listPullRuns). Alerta só
// os repos cuja sequência de runs travadas, contada a partir da mais nova, é
// EXATAMENTE o limiar: notifica uma vez ao cruzar e não repete enquanto o
// problema persiste; depois de uma run boa a contagem recomeça do zero. Sem
// estado próprio: o histórico persistido é a fonte, então reiniciar o app não
// duplica nem perde o aviso.
export function reposToAlert(
  runs: Array<{ results: PullRepoResult[] }>,
  threshold = STUCK_RUN_THRESHOLD,
): StuckRepo[] {
  const [latest] = runs
  if (!latest || runs.length < threshold) return []
  const out: StuckRepo[] = []
  for (const result of latest.results) {
    if (!isStuck(result)) continue
    let streak = 0
    for (const run of runs) {
      const same = run.results.find((r) => r.repoId === result.repoId)
      if (!same || !isStuck(same)) break
      streak++
    }
    if (streak !== threshold) continue
    const branch = stuckBranch(result)
    out.push({
      repoId: result.repoId,
      label: result.label,
      reason: branch?.detail ?? result.detail ?? result.status,
      behind: branch?.behind,
    })
  }
  return out
}

export function formatStuckAlert(repos: StuckRepo[]): { title: string; body: string } {
  const title =
    repos.length === 1
      ? `Auto-pull travado em ${repos[0].label}`
      : `Auto-pull travado em ${repos.length} repos`
  const body = repos
    .map((r) => {
      const behind = r.behind ? `, ${r.behind} commits atrás` : ''
      return `${r.label}: ${r.reason.split('\n')[0].slice(0, 120)}${behind}`
    })
    .join(' · ')
  return { title, body: `${body} (${STUCK_RUN_THRESHOLD} runs seguidas)` }
}
