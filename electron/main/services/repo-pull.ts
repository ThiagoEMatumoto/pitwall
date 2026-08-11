import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { SimpleGit, StatusResult } from 'simple-git'
import { getDb } from './db'
import { authArgs, netGit } from './git-auth'
import { readDefaultBranch, readOriginUrl } from './git-remote'
import type { BranchPullOutcome, PullRepoResult } from '../../../shared/types/ipc'

// Máximo de pulls simultâneos: limita rede/CPU ao atualizar muitos repos sem
// serializar tudo. Mesmo teto do clone.
const PULL_CONCURRENCY = 3

interface RepoRow {
  id: string
  label: string
  path: string
  remote_url: string | null
  default_branch: string | null
}

interface PullTarget {
  repoId: string
  label: string
  path: string
  remoteUrl: string | null
  defaultBranch: string | null
}

// Campos do `simple-git .status()` de que a classificação precisa. Mantido
// mínimo pra o teste stubar sem montar um StatusResult inteiro.
export interface PullStatusInput {
  ahead: number
  files: unknown[]
}

export type PullEligibility = 'dirty' | 'diverged' | 'eligible'

// Puro e testável: dado o status do repo, decide se é seguro dar um pull
// fast-forward. `dirty` (working tree com mudanças que impediriam o FF) tem
// prioridade sobre `diverged` (commits locais ainda não empurrados). Só
// `eligible` (limpo e sem commits locais adiante) é puxado.
export function classifyPullEligibility(status: PullStatusInput): PullEligibility {
  if (status.files.length > 0) return 'dirty'
  if (status.ahead > 0) return 'diverged'
  return 'eligible'
}

function listPullTargets(): PullTarget[] {
  const rows = getDb()
    .prepare('SELECT id, label, path, remote_url, default_branch FROM repos WHERE path IS NOT NULL')
    .all() as RepoRow[]
  const out: PullTarget[] = []
  for (const row of rows) {
    if (!existsSync(row.path)) continue
    out.push({
      repoId: row.id,
      label: row.label,
      path: row.path,
      remoteUrl: row.remote_url,
      defaultBranch: row.default_branch,
    })
  }
  return out
}

// `fetch origin --prune` SEM refspec de destino, primeiro passo de todo pull.
// Refresca TODOS os remote-tracking refs de uma vez (origin/main, origin/staging,
// ...) — é o que `git worktree add ... origin/main` consome, e o que o
// `fetch origin def:def` de pullDefaultBranch não cobre (ele só toca a default,
// e nem chega a rodar quando a default está em checkout). Não mexe em working
// tree nem em refs locais, então roda incondicionalmente: repo sujo ou divergente
// também. Devolve null no sucesso — o breakdown por-branch continua sendo sobre
// branches, só a falha precisa aparecer lá.
async function fetchRemote(git: SimpleGit, url: string): Promise<BranchPullOutcome | null> {
  try {
    await git.raw([...authArgs(url), 'fetch', 'origin', '--prune'])
    return null
  } catch (err) {
    return { branch: 'origin', status: 'error', detail: (err as Error).message }
  }
}

// Quantos commits o ref local está atrás do remote-tracking, medido DEPOIS do
// fetch e do fast-forward (branch puxada → 0; pulada → o atraso real).
// undefined quando um dos refs não existe.
async function countBehind(git: SimpleGit, branch: string): Promise<number | undefined> {
  try {
    const out = await git.raw([
      'rev-list',
      '--count',
      `refs/heads/${branch}..refs/remotes/origin/${branch}`,
    ])
    const n = Number(out.trim())
    return Number.isFinite(n) ? n : undefined
  } catch {
    return undefined
  }
}

async function withBehind(git: SimpleGit, outcome: BranchPullOutcome): Promise<BranchPullOutcome> {
  const behind = await countBehind(git, outcome.branch)
  return behind === undefined ? outcome : { ...outcome, behind }
}

// Existe `refs/remotes/origin/<branch>` no disco? Confiável porque o
// `fetch origin --prune` de pullRepo acabou de rodar: branch apagada no remote
// já sumiu do namespace remote-tracking. A resposta vem do STDOUT (o sha), não
// do throw: com `--quiet` o git sai 1 sem escrever nada em stderr, e o
// simple-git não trata isso como erro.
async function remoteBranchExists(git: SimpleGit, branch: string): Promise<boolean> {
  try {
    const sha = await git.raw(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`])
    return sha.trim().length > 0
  } catch {
    return false
  }
}

// Branch default derivada do DISCO, não do DB, e sempre validada contra o
// namespace remote-tracking. `origin/HEAD` pode não estar resolvido localmente
// (clone antigo, repo adicionado à mão) ou estar obsoleto (aponta pra branch que
// o remote já apagou/renomeou); nos dois casos `set-head -a` pergunta ao remote
// e (re)escreve o ref — gated pela existência de origin, e a rede já está quente
// do fetch acima. Null quando nem depois do re-resolve a branch existe: melhor
// não puxar nada do que errar toda run e gravar o valor morto no DB.
async function resolveDefaultBranch(git: SimpleGit, url: string): Promise<string | null> {
  const def = await readDefaultBranch(git)
  if (def && (await remoteBranchExists(git, def))) return def
  if (!url) return null
  try {
    await git.raw([...authArgs(url), 'remote', 'set-head', 'origin', '-a'])
  } catch {
    // O simple-git trata stderr não-vazio como falha, e o set-head reporta a
    // correção por stderr ("'origin/HEAD' has changed from 'x'..."). Quem decide
    // é a releitura do ref abaixo, não o throw.
  }
  const healed = await readDefaultBranch(git)
  if (healed && (await remoteBranchExists(git, healed))) return healed
  return null
}

// Puro e testável: branches em checkout segundo `git worktree list --porcelain`
// (a principal e todas as vinculadas). Cada bloco traz uma linha
// `branch refs/heads/<x>`; blocos detached não têm essa linha e ficam de fora.
export function parseCheckedOutBranches(porcelain: string): Set<string> {
  const prefix = 'branch refs/heads/'
  const out = new Set<string>()
  for (const line of porcelain.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.startsWith(prefix)) out.add(trimmed.slice(prefix.length))
  }
  return out
}

// Set vazio no catch: metadata de worktree corrompida não pode derrubar o ciclo
// — no pior caso voltamos ao comportamento antigo (tentar o fetch e receber a
// recusa do git).
async function listCheckedOutBranches(git: SimpleGit): Promise<Set<string>> {
  try {
    return parseCheckedOutBranches(await git.raw(['worktree', 'list', '--porcelain']))
  } catch {
    return new Set()
  }
}

// Pull ff-only da branch em checkout (mantém o comportamento original: um
// remote divergente FALHA em vez de mesclar; repo sujo/com commits locais é
// pulado, nunca destruído).
async function pullCurrentBranch(
  git: SimpleGit,
  current: string,
  status: PullStatusInput,
  url: string,
): Promise<BranchPullOutcome> {
  const eligibility = classifyPullEligibility(status)
  if (eligibility !== 'eligible') return { branch: current, status: 'skipped', detail: eligibility }
  try {
    const before = (await git.revparse(['HEAD'])).trim()
    await git.raw([...authArgs(url), 'pull', '--ff-only'])
    const after = (await git.revparse(['HEAD'])).trim()
    return { branch: current, status: before === after ? 'up-to-date' : 'pulled' }
  } catch (err) {
    return { branch: current, status: 'error', detail: (err as Error).message }
  }
}

// Fast-forward do ref local da branch default SEM checkout: `fetch origin
// def:def` escreve direto no ref, sem tocar a working tree. Só é chamada quando
// a default NÃO está em checkout em nenhuma worktree (garantido pelo caller, que
// checa `current` e `listCheckedOutBranches`) — senão o git recusa com
// "refusing to fetch into branch ... checked out at".
// Se a default ainda não existe localmente, `before` falha (try/catch) e
// contamos como `pulled`. Se o remote divergiu do ref local, o fetch recusa o
// non-fast-forward e caímos no catch externo como `error` — seguro, nunca
// destrói (a working tree não é tocada de qualquer forma).
async function pullDefaultBranch(git: SimpleGit, url: string, def: string): Promise<BranchPullOutcome> {
  let before: string | null = null
  try {
    before = (await git.revparse([def])).trim()
  } catch {
    before = null // ref local da default ainda não existe
  }
  try {
    await git.raw([...authArgs(url), 'fetch', 'origin', `${def}:${def}`])
    if (before === null) return { branch: def, status: 'pulled' }
    const after = (await git.revparse([def])).trim()
    return { branch: def, status: before === after ? 'up-to-date' : 'pulled' }
  } catch (err) {
    return { branch: def, status: 'error', detail: (err as Error).message }
  }
}

function summarizeBranch(b: BranchPullOutcome): string {
  return b.detail ? `${b.branch}: ${b.status}(${b.detail})` : `${b.branch}: ${b.status}`
}

// Puro e testável: agrega o breakdown por-branch num status único de repo.
// Prioridade: error (algo falhou) > pulled (algo avançou) > up-to-date (tudo em
// dia) > skipped (nada foi tentado, ex. repo detached sem default resolvida).
export function deriveOverallStatus(
  branches: BranchPullOutcome[],
): { status: PullRepoResult['status']; detail?: string } {
  const detail = branches.map(summarizeBranch).join(' · ') || undefined
  if (branches.some((b) => b.status === 'error')) return { status: 'error', detail }
  if (branches.some((b) => b.status === 'pulled')) return { status: 'pulled', detail }
  if (branches.some((b) => b.status === 'up-to-date')) return { status: 'up-to-date', detail }
  return { status: 'skipped', detail }
}

// Pull de UM repo em três unidades de trabalho: o `fetch origin` incondicional
// (refresca TODOS os remote-tracking refs — é o que as worktrees consomem), o
// fast-forward da branch em checkout (via `pull`) e o do ref local da default
// (via `fetch def:def`, sem checkout, quando diverge da atual). Nunca destrói
// trabalho: repos sujos/divergentes são pulados nas unidades de fast-forward, e
// o fetch não toca working tree nem refs locais.
export async function pullRepo(target: PullTarget): Promise<PullRepoResult> {
  const base = { repoId: target.repoId, label: target.label, path: target.path }
  if (!existsSync(join(target.path, '.git'))) {
    return { ...base, status: 'skipped', detail: 'sem .git' }
  }
  try {
    const git = netGit(target.path)

    // A URL do remote decide se o credential-helper do gh entra (http[s]) ou não
    // (file://). Preferimos a origin real do disco; caímos pro remote_url do DB.
    const url = (await readOriginUrl(target.path)).remoteUrl ?? target.remoteUrl ?? ''

    const branches: BranchPullOutcome[] = []
    // Antes de qualquer leitura de estado. Sem origin (repo local-only) não há o
    // que buscar.
    if (url) {
      const failure = await fetchRemote(git, url)
      if (failure) branches.push(failure)
    }

    const status: StatusResult = await git.status()
    const current = status.current
    const resolvedDef = await resolveDefaultBranch(git, url)
    // Auto-heal do DB: a row podia ter uma feature branch como "default", gravada
    // pelo fallback ruim de readDefaultBranch (removido).
    if (resolvedDef && resolvedDef !== target.defaultBranch) {
      getDb()
        .prepare('UPDATE repos SET default_branch = ? WHERE id = ?')
        .run(resolvedDef, target.repoId)
    }
    // O fallback do DB também passa pela validação: uma default morta gravada
    // numa run antiga não pode voltar a ser usada.
    const dbDef = target.defaultBranch
    const def = resolvedDef ?? (dbDef && (await remoteBranchExists(git, dbDef)) ? dbDef : null)

    if (current) {
      branches.push(await withBehind(git, await pullCurrentBranch(git, current, status, url)))
    }
    if (def && def !== current) {
      // A default pode estar em checkout numa worktree VINCULADA (status.current
      // só enxerga a principal). Nesse caso `fetch origin def:def` é recusado
      // pelo git; avançar o ref exigiria mexer na working tree do usuário, então
      // reportamos o skip e deixamos o atraso visível via `behind`.
      const checkedOutElsewhere = (await listCheckedOutBranches(git)).has(def)
      const outcome: BranchPullOutcome = checkedOutElsewhere
        ? { branch: def, status: 'skipped', detail: 'checked-out-elsewhere' }
        : await pullDefaultBranch(git, url, def)
      branches.push(await withBehind(git, outcome))
    }

    const { status: overall, detail } = deriveOverallStatus(branches)
    return { ...base, status: overall, detail, branches }
  } catch (err) {
    return { ...base, status: 'error', detail: (err as Error).message }
  }
}

// Progresso emitido antes de cada pull (índice 1-based / total + label).
export interface PullProgress {
  index: number
  total: number
  label: string
}

// Puxa todos os repos com path existente, concorrência limitada. Chama
// onProgress antes de iniciar cada pull (toast sequencial). Retorna o resumo.
export async function pullAllRepos(
  onProgress?: (p: PullProgress) => void,
): Promise<PullRepoResult[]> {
  const targets = listPullTargets()
  const total = targets.length
  const results: PullRepoResult[] = new Array(total)

  let next = 0
  async function worker(): Promise<void> {
    while (true) {
      const i = next++
      if (i >= total) return
      const target = targets[i]
      onProgress?.({ index: i + 1, total, label: target.label })
      results[i] = await pullRepo(target)
    }
  }

  const workers = Array.from({ length: Math.min(PULL_CONCURRENCY, total) }, () => worker())
  await Promise.all(workers)
  return results
}

// Pull de um único repo resolvido por id OU por path (usado pelo handler
// repos:pull-one e pelo item de menu por-repo).
export async function pullOneRepo(selector: {
  repoId?: string
  path?: string
}): Promise<PullRepoResult> {
  const db = getDb()
  const row = selector.repoId
    ? (db
        .prepare('SELECT id, label, path, remote_url, default_branch FROM repos WHERE id = ?')
        .get(selector.repoId) as RepoRow | undefined)
    : (db
        .prepare('SELECT id, label, path, remote_url, default_branch FROM repos WHERE path = ?')
        .get(selector.path) as RepoRow | undefined)
  if (!row) throw new Error('repo não encontrado')
  return pullRepo({
    repoId: row.id,
    label: row.label,
    path: row.path,
    remoteUrl: row.remote_url,
    defaultBranch: row.default_branch,
  })
}
