import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
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
// mínimo pra o teste stubar sem montar um StatusResult inteiro. `index` e
// `working_dir` são os dois dígitos do short format do git (compatível com
// FileStatusResult, onde eles são obrigatórios).
export interface PullStatusFile {
  index?: string
  working_dir?: string
}

export interface PullStatusInput {
  ahead: number
  files: PullStatusFile[]
}

export type PullEligibility = 'dirty' | 'diverged' | 'eligible'

// `status.files` do simple-git NÃO é só o que está tracked: o parser empurra
// pra lá toda linha do `status --porcelain` que não seja '##'/'!!', inclusive
// os '??' (que também vão pra `not_added`). Untracked não impede um
// fast-forward — o git só recusa se um deles fosse ser SOBRESCRITO, caso
// tratado no catch do merge (isUntrackedCollision).
function isUntracked(file: PullStatusFile): boolean {
  return file.index === '?' && file.working_dir === '?'
}

// Puro e testável: dado o status do repo, decide se é seguro dar um pull
// fast-forward. `dirty` (mudanças em arquivos TRACKED, que impediriam o FF) tem
// prioridade sobre `diverged` (commits locais ainda não empurrados). Só
// `eligible` (sem mudança tracked e sem commits locais adiante) é puxado —
// artefato untracked (.playwright-mcp/, PNG de scratch) não conta como sujo,
// senão o repo nunca voltaria a ser atualizado.
export function classifyPullEligibility(status: PullStatusInput): PullEligibility {
  if (status.files.some((file) => !isUntracked(file))) return 'dirty'
  if (status.ahead > 0) return 'diverged'
  return 'eligible'
}

// O preço de deixar untracked passar pela elegibilidade: o git aborta o
// merge/checkout quando um arquivo untracked LOCAL seria sobrescrito por um
// arquivo vindo do remote. É recusa preventiva (nada foi tocado), não falha —
// vira `skipped` legível em vez de `error` genérico. A frase abaixo vem do
// próprio git (unpack-trees.c, "The following untracked working tree files
// would be overwritten by %s") e é estável há anos; o verbo final varia
// (merge/checkout), por isso não entra no match.
export function isUntrackedCollision(message: string): boolean {
  return /untracked working tree files would be overwritten/i.test(message)
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

// Puro e testável: branch em checkout -> path da worktree que a tem, segundo
// `git worktree list --porcelain` (a principal e todas as vinculadas). Cada
// bloco abre com `worktree <path>` e traz uma linha `branch refs/heads/<x>`;
// blocos detached não têm essa linha e ficam de fora. O path importa porque o
// fast-forward da default precisa rodar DENTRO da worktree que a segura.
export function parseCheckedOutBranches(porcelain: string): Map<string, string> {
  const branchPrefix = 'branch refs/heads/'
  const worktreePrefix = 'worktree '
  const out = new Map<string, string>()
  let path: string | null = null
  for (const line of porcelain.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.startsWith(worktreePrefix)) path = trimmed.slice(worktreePrefix.length)
    else if (trimmed.startsWith(branchPrefix) && path) {
      out.set(trimmed.slice(branchPrefix.length), path)
    }
  }
  return out
}

// Map vazio no catch: metadata de worktree corrompida não pode derrubar o ciclo
// — no pior caso voltamos ao comportamento antigo (tentar o fetch e receber a
// recusa do git).
async function listCheckedOutBranches(git: SimpleGit): Promise<Map<string, string>> {
  try {
    return parseCheckedOutBranches(await git.raw(['worktree', 'list', '--porcelain']))
  } catch {
    return new Map()
  }
}

// Branch em checkout no diretório principal, ou null com HEAD destacado. Não
// usamos `status.current` do simple-git: destacado ele devolve a string "HEAD",
// que passava por nome de branch e fazia o `pull --ff-only` falhar a cada run.
async function readCurrentBranch(git: SimpleGit): Promise<string | null> {
  try {
    const ref = (await git.raw(['symbolic-ref', '--quiet', '--short', 'HEAD'])).trim()
    return ref || null
  } catch {
    return null
  }
}

// Marcadores de operação git em andamento. Durante um bisect o HEAD fica
// destacado num ancestral com árvore limpa — exatamente o perfil que seria
// reanexado — e reanexar quebraria a operação do usuário.
const GIT_OP_MARKERS = [
  'BISECT_LOG',
  'rebase-merge',
  'rebase-apply',
  'MERGE_HEAD',
  'CHERRY_PICK_HEAD',
  'REVERT_HEAD',
  'sequencer',
]

// `--git-path` porque numa worktree vinculada esses arquivos ficam em
// .git/worktrees/<nome>/, não em .git/.
export async function hasGitOperationInProgress(
  git: SimpleGit,
  repoPath: string,
): Promise<boolean> {
  for (const marker of GIT_OP_MARKERS) {
    const rel = (await git.raw(['rev-parse', '--git-path', marker])).trim()
    if (existsSync(resolve(repoPath, rel))) return true
  }
  return false
}

// Não usar `merge-base --is-ancestor`: a resposta dele é só o exit code (1 sem
// stderr), e o simple-git não trata isso como erro — o "não é ancestral" virava
// "é", e um commit fora de qualquer branch seria abandonado no checkout.
async function isAncestor(git: SimpleGit, ancestor: string, descendant: string): Promise<boolean> {
  const sha = await revParse(git, ancestor)
  if (!sha) return false
  try {
    return (await git.raw(['merge-base', ancestor, descendant])).trim() === sha
  } catch {
    return false
  }
}

async function countCommits(git: SimpleGit, range: string): Promise<number | undefined> {
  try {
    const n = Number((await git.raw(['rev-list', '--count', range])).trim())
    return Number.isFinite(n) ? n : undefined
  } catch {
    return undefined
  }
}

async function revParse(git: SimpleGit, ref: string): Promise<string | null> {
  try {
    return (await git.revparse([ref])).trim()
  } catch {
    return null
  }
}

// HEAD destacado no diretório principal: devolve à default quando isso não
// perde nada — árvore limpa (untracked não conta), sem operação git em
// andamento, e HEAD ancestral de origin/<def> (nenhum commit só existe aqui).
// Com a default em checkout noutra worktree o git recusa `checkout <def>`, então
// destacamos em origin/<def>. Roda DEPOIS do fast-forward da default, por isso
// exige o ref local igual a origin/<def>: assim o checkout nunca volta no tempo.
async function reattachDetachedHead(
  git: SimpleGit,
  repoPath: string,
  status: PullStatusInput,
  def: string | null,
  defElsewhere: boolean,
): Promise<BranchPullOutcome> {
  const skip = (detail: string, behind?: number): BranchPullOutcome =>
    behind === undefined
      ? { branch: 'HEAD', status: 'skipped', detail }
      : { branch: 'HEAD', status: 'skipped', detail, behind }
  if (!def) return skip('detached-no-default')
  const remoteRef = `refs/remotes/origin/${def}`
  const behind = await countCommits(git, `HEAD..${remoteRef}`)
  if (await hasGitOperationInProgress(git, repoPath)) return skip('git-op-in-progress', behind)
  if (classifyPullEligibility(status) === 'dirty') return skip('detached-dirty', behind)
  if (!(await isAncestor(git, 'HEAD', remoteRef))) return skip('detached-unique-commits', behind)

  const from = ((await revParse(git, 'HEAD')) ?? '').slice(0, 7)
  if (!defElsewhere && (await revParse(git, def)) !== (await revParse(git, remoteRef))) {
    return skip('detached-default-not-synced', behind)
  }
  const args = defElsewhere ? ['checkout', '--detach', remoteRef] : ['checkout', def]
  const to = defElsewhere ? `origin/${def}` : def
  try {
    await git.raw(args)
    return { branch: 'HEAD', status: 'reattached', detail: `${from}→${to}`, behind: 0 }
  } catch (err) {
    const message = (err as Error).message
    if (isUntrackedCollision(message)) return skip('untracked-collision', behind)
    return { branch: 'HEAD', status: 'error', detail: message, behind }
  }
}

// Branch sem upstream: o `pull --ff-only` falharia com "There is no tracking
// information". Se o remote tem uma branch de mesmo nome, ela é o upstream
// óbvio; sem ela não há de onde puxar e o repo é pulado com motivo legível.
async function ensureUpstream(
  git: SimpleGit,
  current: string,
  status: StatusResult,
): Promise<{ status: StatusResult; upstreamSet: boolean } | null> {
  if (status.tracking) return { status, upstreamSet: false }
  if (!(await remoteBranchExists(git, current))) return null
  await git.raw(['branch', `--set-upstream-to=origin/${current}`, current])
  // Reler: sem tracking o `ahead` vinha 0 e esconderia commits locais.
  return { status: await git.status(), upstreamSet: true }
}

// Pull ff-only da branch em checkout (mantém o comportamento original: um
// remote divergente FALHA em vez de mesclar; repo sujo/com commits locais é
// pulado, nunca destruído).
async function pullCurrentBranch(
  git: SimpleGit,
  current: string,
  initialStatus: StatusResult,
  url: string,
): Promise<BranchPullOutcome> {
  let upstream: Awaited<ReturnType<typeof ensureUpstream>>
  try {
    upstream = await ensureUpstream(git, current, initialStatus)
  } catch (err) {
    return { branch: current, status: 'error', detail: (err as Error).message }
  }
  if (!upstream) return { branch: current, status: 'skipped', detail: 'no-upstream' }
  const eligibility = classifyPullEligibility(upstream.status)
  if (eligibility !== 'eligible') return { branch: current, status: 'skipped', detail: eligibility }
  try {
    const before = (await git.revparse(['HEAD'])).trim()
    await git.raw([...authArgs(url), 'pull', '--ff-only'])
    const after = (await git.revparse(['HEAD'])).trim()
    const outcome: BranchPullOutcome = {
      branch: current,
      status: before === after ? 'up-to-date' : 'pulled',
    }
    return upstream.upstreamSet ? { ...outcome, detail: 'upstream-set' } : outcome
  } catch (err) {
    const message = (err as Error).message
    if (isUntrackedCollision(message)) {
      return { branch: current, status: 'skipped', detail: 'untracked-collision' }
    }
    return { branch: current, status: 'error', detail: message }
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
async function pullDefaultBranch(
  git: SimpleGit,
  url: string,
  def: string,
): Promise<BranchPullOutcome> {
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

// Fast-forward da default DENTRO da worktree vinculada que a tem em checkout.
// Um worktree é só outro checkout: vale a MESMA barra de elegibilidade do
// diretório principal (limpo + sem commits locais adiante), via
// classifyPullEligibility. O skip carrega `checked-out-elsewhere-<motivo>` pra
// deixar claro que o impedimento está em OUTRO diretório. O merge é contra o
// remote-tracking ref — o `fetch origin --prune` de pullRepo já rodou, então
// aqui não há rede nem credencial em jogo.
async function pullDefaultInWorktree(
  worktreePath: string,
  def: string,
): Promise<BranchPullOutcome> {
  const wtGit = netGit(worktreePath)
  let status: PullStatusInput
  try {
    status = await wtGit.status()
  } catch {
    // Worktree órfã/prunable (path sumiu do disco): comportamento antigo.
    return { branch: def, status: 'skipped', detail: 'checked-out-elsewhere' }
  }
  const eligibility = classifyPullEligibility(status)
  if (eligibility !== 'eligible') {
    return { branch: def, status: 'skipped', detail: `checked-out-elsewhere-${eligibility}` }
  }
  try {
    const before = (await wtGit.revparse(['HEAD'])).trim()
    await wtGit.raw(['merge', '--ff-only', `refs/remotes/origin/${def}`])
    const after = (await wtGit.revparse(['HEAD'])).trim()
    return { branch: def, status: before === after ? 'up-to-date' : 'pulled' }
  } catch (err) {
    const message = (err as Error).message
    if (isUntrackedCollision(message)) {
      return { branch: def, status: 'skipped', detail: 'checked-out-elsewhere-untracked-collision' }
    }
    return { branch: def, status: 'error', detail: message }
  }
}

function summarizeBranch(b: BranchPullOutcome): string {
  return b.detail ? `${b.branch}: ${b.status}(${b.detail})` : `${b.branch}: ${b.status}`
}

// Puro e testável: agrega o breakdown por-branch num status único de repo.
// Prioridade: error (algo falhou) > pulled (algo avançou) > up-to-date (tudo em
// dia) > skipped (nada foi tentado, ex. repo detached sem default resolvida).
export function deriveOverallStatus(branches: BranchPullOutcome[]): {
  status: PullRepoResult['status']
  detail?: string
} {
  const detail = branches.map(summarizeBranch).join(' · ') || undefined
  if (branches.some((b) => b.status === 'error')) return { status: 'error', detail }
  if (branches.some((b) => b.status === 'pulled' || b.status === 'reattached')) {
    return { status: 'pulled', detail }
  }
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
    const current = await readCurrentBranch(git)
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
    let defElsewhere = false
    if (def && def !== current) {
      // A default pode estar em checkout numa worktree VINCULADA (status.current
      // só enxerga a principal). Nesse caso `fetch origin def:def` é recusado
      // pelo git, e o avanço tem que acontecer LÁ — com o mesmo critério de
      // segurança do diretório principal. Suja/divergida continua pulada, com o
      // atraso visível via `behind`.
      const worktreePath = (await listCheckedOutBranches(git)).get(def)
      defElsewhere = Boolean(worktreePath)
      const outcome: BranchPullOutcome = worktreePath
        ? await pullDefaultInWorktree(worktreePath, def)
        : await pullDefaultBranch(git, url, def)
      branches.push(await withBehind(git, outcome))
    }
    if (!current) {
      branches.push(await reattachDetachedHead(git, target.path, status, def, defElsewhere))
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
