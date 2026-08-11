import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// repo-pull importa db/notify/git-auth, que tocam electron no topo (mesmo
// mock do repo-pull.test.ts). Remotes file:// não passam por needsAuth (só
// http[s]), então `gh` nunca entra em jogo aqui — os testes são 100% locais.
vi.mock('electron', () => ({
  app: { getPath: () => tmpdir(), getVersion: () => '0.0.0-test' },
  BrowserWindow: { getAllWindows: () => [] },
}))

import { pullRepo } from './repo-pull'

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

// Monta: origin bare (main com 1 commit) → clone de trabalho. Avança
// origin/main com um 2º commit e dá checkout numa feature branch no clone
// ANTES de puxar o avanço — reproduz o cenário do bug (usuário parado numa
// feature branch enquanto a default do remote segue adiante).
function setupRepos(dir: string): { originPath: string; clonePath: string } {
  const originPath = join(dir, 'origin.git')
  const clonePath = join(dir, 'clone')
  const seedPath = join(dir, 'seed')

  git(dir, 'init', '--bare', '-b', 'main', originPath)

  git(dir, 'clone', originPath, seedPath)
  git(seedPath, 'config', 'user.email', 'test@example.com')
  git(seedPath, 'config', 'user.name', 'Test')
  writeFileSync(join(seedPath, 'file.txt'), 'v1')
  git(seedPath, 'add', 'file.txt')
  git(seedPath, 'commit', '-m', 'init')
  git(seedPath, 'push', 'origin', 'main')

  git(dir, 'clone', originPath, clonePath)
  git(clonePath, 'config', 'user.email', 'test@example.com')
  git(clonePath, 'config', 'user.name', 'Test')

  // Origin avança DEPOIS do clone — o clone local ainda está no commit v1.
  writeFileSync(join(seedPath, 'file.txt'), 'v2')
  git(seedPath, 'commit', '-am', 'advance main')
  git(seedPath, 'push', 'origin', 'main')

  // Checkout numa feature branch a partir do main local (ainda em v1) — nunca
  // fez fetch do avanço acima. Publica + rastreia upstream (cenário comum:
  // branch já empurrada) pra que o `pull --ff-only` da branch atual tenha
  // tracking info em vez de falhar por "no tracking information".
  git(clonePath, 'checkout', '-b', 'feat/x')
  git(clonePath, 'push', '-u', 'origin', 'feat/x')

  return { originPath, clonePath }
}

describe('pullRepo (integração — repos git temporários)', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'repo-pull-test-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('atualiza a default (main) via fetch sem tocar a feature branch em checkout', async () => {
    const { originPath, clonePath } = setupRepos(dir)
    const originMain = git(originPath, 'rev-parse', 'main')
    const featBefore = git(clonePath, 'rev-parse', 'feat/x')

    const result = await pullRepo({
      repoId: 'r1',
      label: 'clone',
      path: clonePath,
      remoteUrl: originPath,
      defaultBranch: 'main',
    })

    // (a) o remote-tracking ref avançou — é ELE que `git worktree add ...
    // origin/main` consome.
    expect(git(clonePath, 'rev-parse', 'refs/remotes/origin/main')).toBe(originMain)
    // (b) o ref local `main` avançou e alcançou o origin.
    expect(git(clonePath, 'rev-parse', 'main')).toBe(originMain)
    // (c) a feature branch (checkout atual) ficou intocada.
    expect(git(clonePath, 'rev-parse', 'feat/x')).toBe(featBefore)
    expect(git(clonePath, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('feat/x')
    // (d) `branches` reflete os dois resultados (o fetch bem-sucedido é silencioso).
    expect(result.branches).toHaveLength(2)
    expect(result.branches?.find((b) => b.branch === 'main')?.status).toBe('pulled')
    expect(result.branches?.find((b) => b.branch === 'main')?.behind).toBe(0)
    expect(result.branches?.find((b) => b.branch === 'feat/x')?.status).toBe('up-to-date')
    expect(result.status).toBe('pulled')
  })

  it('working tree suja: default ainda avança via fetch, branch atual é pulada', async () => {
    const { originPath, clonePath } = setupRepos(dir)
    const originMain = git(originPath, 'rev-parse', 'main')
    const featBefore = git(clonePath, 'rev-parse', 'feat/x')
    // Suja a working tree (mudança não commitada) na feature branch em checkout.
    writeFileSync(join(clonePath, 'file.txt'), 'dirty')

    const result = await pullRepo({
      repoId: 'r1',
      label: 'clone',
      path: clonePath,
      remoteUrl: originPath,
      defaultBranch: 'main',
    })

    expect(git(clonePath, 'rev-parse', 'refs/remotes/origin/main')).toBe(originMain)
    expect(git(clonePath, 'rev-parse', 'main')).toBe(originMain)
    expect(git(clonePath, 'rev-parse', 'feat/x')).toBe(featBefore)
    expect(result.branches?.find((b) => b.branch === 'main')?.status).toBe('pulled')
    const featOutcome = result.branches?.find((b) => b.branch === 'feat/x')
    expect(featOutcome?.status).toBe('skipped')
    expect(featOutcome?.detail).toBe('dirty')
  })

  // Cenário do `leia` (67 commits atrás): o usuário está NA branch default com a
  // working tree suja. Antes do fix nenhum fetch acontecia — pullDefaultBranch só
  // roda quando def !== current, e pullCurrentBranch pulava por dirty. Agora o
  // `fetch origin` incondicional refresca origin/main mesmo assim.
  it('na branch default com working tree suja: origin/main avança, ref local fica parado', async () => {
    const { originPath, clonePath } = setupRepos(dir)
    const originMain = git(originPath, 'rev-parse', 'main')
    git(clonePath, 'checkout', 'main')
    const mainBefore = git(clonePath, 'rev-parse', 'main')
    expect(mainBefore).not.toBe(originMain)
    writeFileSync(join(clonePath, 'file.txt'), 'dirty')

    const result = await pullRepo({
      repoId: 'r1',
      label: 'clone',
      path: clonePath,
      remoteUrl: originPath,
      defaultBranch: 'main',
    })

    // O remote-tracking ref ficou fresco...
    expect(git(clonePath, 'rev-parse', 'refs/remotes/origin/main')).toBe(originMain)
    // ...e nada do trabalho local foi destruído: ref local parado e diff intacto.
    expect(git(clonePath, 'rev-parse', 'main')).toBe(mainBefore)
    expect(readFileSync(join(clonePath, 'file.txt'), 'utf8')).toBe('dirty')
    expect(git(clonePath, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main')

    expect(result.branches).toHaveLength(1)
    const mainOutcome = result.branches?.[0]
    expect(mainOutcome?.branch).toBe('main')
    expect(mainOutcome?.status).toBe('skipped')
    expect(mainOutcome?.detail).toBe('dirty')
    expect(mainOutcome?.behind).toBe(1)
  })

  // Cenário do `legal-core` (35 commits atrás): a default está em checkout numa
  // worktree VINCULADA e LIMPA. `status.current` só enxerga a principal (feat/x)
  // e o `fetch origin main:main` é recusado pelo git — antes o repo acumulava
  // atraso PRA SEMPRE. Agora o fast-forward roda dentro da própria worktree.
  it('default em worktree vinculada limpa: fast-forward aplicado na worktree', async () => {
    const { originPath, clonePath } = setupRepos(dir)
    const originMain = git(originPath, 'rev-parse', 'main')
    const mainBefore = git(clonePath, 'rev-parse', 'main')
    expect(mainBefore).not.toBe(originMain)
    const wtPath = join(dir, 'wt-main')
    git(clonePath, 'worktree', 'add', wtPath, 'main')
    expect(git(clonePath, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('feat/x')

    const result = await pullRepo({
      repoId: 'r1',
      label: 'clone',
      path: clonePath,
      remoteUrl: originPath,
      defaultBranch: 'main',
    })

    // O ref local de main alcançou o origin E a working tree da worktree
    // vinculada recebeu o conteúdo novo (o FF rodou lá dentro, não só no ref).
    expect(git(clonePath, 'rev-parse', 'refs/remotes/origin/main')).toBe(originMain)
    expect(git(clonePath, 'rev-parse', 'main')).toBe(originMain)
    expect(readFileSync(join(wtPath, 'file.txt'), 'utf8')).toBe('v2')
    // A worktree principal seguiu intocada, na feature branch.
    expect(git(clonePath, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('feat/x')

    const mainOutcome = result.branches?.find((b) => b.branch === 'main')
    expect(mainOutcome?.status).toBe('pulled')
    expect(mainOutcome?.behind).toBe(0)
    expect(result.status).not.toBe('error')
  })

  it('default em worktree vinculada SUJA: skip, working tree preservada', async () => {
    const { originPath, clonePath } = setupRepos(dir)
    const originMain = git(originPath, 'rev-parse', 'main')
    const mainBefore = git(clonePath, 'rev-parse', 'main')
    const wtPath = join(dir, 'wt-main')
    git(clonePath, 'worktree', 'add', wtPath, 'main')
    writeFileSync(join(wtPath, 'file.txt'), 'dirty')

    const result = await pullRepo({
      repoId: 'r1',
      label: 'clone',
      path: clonePath,
      remoteUrl: originPath,
      defaultBranch: 'main',
    })

    expect(git(clonePath, 'rev-parse', 'refs/remotes/origin/main')).toBe(originMain)
    expect(git(clonePath, 'rev-parse', 'main')).toBe(mainBefore)
    expect(readFileSync(join(wtPath, 'file.txt'), 'utf8')).toBe('dirty')

    const mainOutcome = result.branches?.find((b) => b.branch === 'main')
    expect(mainOutcome?.status).toBe('skipped')
    expect(mainOutcome?.detail).toBe('checked-out-elsewhere-dirty')
    expect(mainOutcome?.behind).toBe(1)
    expect(result.status).not.toBe('error')
  })

  it('default em worktree vinculada DIVERGIDA (commits locais): skip', async () => {
    const { originPath, clonePath } = setupRepos(dir)
    const wtPath = join(dir, 'wt-main')
    git(clonePath, 'worktree', 'add', wtPath, 'main')
    git(wtPath, 'commit', '--allow-empty', '-m', 'local work')
    const mainBefore = git(clonePath, 'rev-parse', 'main')

    const result = await pullRepo({
      repoId: 'r1',
      label: 'clone',
      path: clonePath,
      remoteUrl: originPath,
      defaultBranch: 'main',
    })

    // O commit local sobreviveu — nada foi mesclado nem descartado.
    expect(git(clonePath, 'rev-parse', 'main')).toBe(mainBefore)

    const mainOutcome = result.branches?.find((b) => b.branch === 'main')
    expect(mainOutcome?.status).toBe('skipped')
    expect(mainOutcome?.detail).toBe('checked-out-elsewhere-diverged')
    expect(result.status).not.toBe('error')
  })

  // origin/HEAD obsoleto (aponta pra branch que o remote não tem mais): antes
  // passava reto e toda run errava. Agora o valor é validado e re-resolvido.
  it('origin/HEAD apontando pra branch morta é re-resolvido antes do pull', async () => {
    const { originPath, clonePath } = setupRepos(dir)
    const originMain = git(originPath, 'rev-parse', 'main')
    git(clonePath, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/ghost')

    const result = await pullRepo({
      repoId: 'r1',
      label: 'clone',
      path: clonePath,
      remoteUrl: originPath,
      defaultBranch: 'main',
    })

    expect(git(clonePath, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD')).toBe('origin/main')
    expect(git(clonePath, 'rev-parse', 'main')).toBe(originMain)
    expect(result.branches?.find((b) => b.branch === 'ghost')).toBeUndefined()
    expect(result.status).not.toBe('error')
  })
})
