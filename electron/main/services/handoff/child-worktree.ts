// Worktree próprio da filha que escreve. Sem isto, uma filha despachada para um
// repo sem worktree de feature caía na RAIZ do repo — em geral na main — e o
// guard global de worktree (~/.claude/scripts/worktree-guard.sh) devolvia "ask"
// em todo Edit/Write: a filha "sem escrita" que o usuário aprovava na mão.
//
// Síncrono de propósito: o handler do session_handoff (e o create-manual) são
// síncronos e o work_dir precisa existir ANTES do compose (o briefing diz à filha
// onde ela está) e do INSERT (é a chave da posse). Sem `git fetch` aqui: rede
// travaria o main; o remote-tracking ref vem do auto-pull do app.
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { PROTECTED_BRANCHES } from '../spawn-flags'
import { canonicalDir } from '../work-dir'

export interface ChildWorkspace {
  // cwd efetivo da filha (worktree novo, ou o work_dir original se não criou).
  workDir: string
  // Branch em checkout no workDir; null fora de repo git.
  branch: string | null
  created: boolean
  // Falha ao criar ou .worktrees/ não ignorado: vai pro briefing da filha.
  warning?: string
}

const GIT_TIMEOUT_MS = 60_000

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    timeout: GIT_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  }).trim()
}

function tryGit(cwd: string, args: string[]): string | null {
  try {
    return git(cwd, args)
  } catch {
    return null
  }
}

export function isProtectedBranch(branch: string | null): boolean {
  return branch !== null && (PROTECTED_BRANCHES as readonly string[]).includes(branch)
}

export function childSlug(alias: string): string {
  const slug = alias
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '')
  return slug || 'child'
}

// Raiz do checkout PRINCIPAL (o worktree novo nasce em <principal>/.worktrees,
// mesmo quando o work_dir já é outro worktree linkado numa protegida).
function mainRepoRoot(dir: string): string | null {
  const common = tryGit(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  if (common && basename(common) === '.git') return dirname(common)
  return tryGit(dir, ['rev-parse', '--show-toplevel'])
}

// origin/<default> (origin/HEAD), senão origin/<branch atual>, senão HEAD.
function baseRef(dir: string, branch: string): string {
  const originHead = tryGit(dir, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'])
  if (originHead) return originHead
  if (tryGit(dir, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`])) {
    return `origin/${branch}`
  }
  return 'HEAD'
}

// Decide e, se preciso, cria o worktree da filha. Nunca lança: qualquer falha
// devolve o work_dir original com `warning` (comportamento anterior).
export function ensureChildWorkspace(args: {
  workDir: string
  alias: string
  handoffId: string
}): ChildWorkspace {
  const { workDir } = args
  const branch = tryGit(workDir, ['rev-parse', '--abbrev-ref', 'HEAD'])
  if (!isProtectedBranch(branch)) return { workDir, branch, created: false }

  const root = mainRepoRoot(workDir)
  if (!root) return { workDir, branch, created: false }
  const shortId = args.handoffId.replace(/-/g, '').slice(0, 8)
  const slug = childSlug(args.alias)
  const newBranch = `child/${slug}-${shortId}`
  let path = join(root, '.worktrees', `child-${slug}`)
  if (existsSync(path)) path = `${path}-${shortId}`
  try {
    git(root, ['worktree', 'add', '-b', newBranch, path, baseRef(workDir, branch!)])
  } catch (err) {
    const detail =
      err instanceof Error
        ? (err as Error & { stderr?: string }).stderr || err.message
        : String(err)
    return {
      workDir,
      branch,
      created: false,
      warning: `Não foi possível criar um worktree próprio (${String(detail).trim().split('\n')[0]}). Você está na branch protegida ${branch}: edições podem pedir confirmação e push nela é bloqueado.`,
    }
  }
  const ignored = tryGit(root, ['check-ignore', '-q', '.worktrees/x']) !== null
  return {
    workDir: canonicalDir(path),
    branch: newBranch,
    created: true,
    ...(ignored
      ? {}
      : {
          warning: `.worktrees/ não está no .gitignore de ${root}: não faça \`git add\` de .worktrees na branch principal.`,
        }),
  }
}
