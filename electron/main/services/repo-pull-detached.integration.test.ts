import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mesmo mock do repo-pull.integration.test.ts: remotes file:// não passam pelo
// credential-helper, os testes são 100% locais.
vi.mock('electron', () => ({
  app: { getPath: () => tmpdir(), getVersion: () => '0.0.0-test' },
  BrowserWindow: { getAllWindows: () => [] },
}))

import { pullRepo } from './repo-pull'

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

interface Fixture {
  originPath: string
  clonePath: string
  seedPath: string
}

// origin bare com main em v1 → clone → origin avança para v2 sem o clone saber.
// Por fim o clone faz o que a sessão fez em legal-core: `checkout origin/main`
// (HEAD destacado num commit antigo) e o fetch posterior traz o v2.
function setupDetached(dir: string): Fixture {
  const originPath = join(dir, 'origin.git')
  const clonePath = join(dir, 'clone')
  const seedPath = join(dir, 'seed')
  git(dir, 'init', '--bare', '-b', 'main', originPath)
  git(dir, 'clone', originPath, seedPath)
  for (const p of [seedPath]) {
    git(p, 'config', 'user.email', 'test@example.com')
    git(p, 'config', 'user.name', 'Test')
  }
  writeFileSync(join(seedPath, 'file.txt'), 'v1')
  git(seedPath, 'add', 'file.txt')
  git(seedPath, 'commit', '-m', 'v1')
  git(seedPath, 'push', 'origin', 'main')

  git(dir, 'clone', originPath, clonePath)
  git(clonePath, 'config', 'user.email', 'test@example.com')
  git(clonePath, 'config', 'user.name', 'Test')
  git(clonePath, 'checkout', '--quiet', 'origin/main')

  advanceOrigin(seedPath, 'v2')
  return { originPath, clonePath, seedPath }
}

function advanceOrigin(seedPath: string, content: string): void {
  writeFileSync(join(seedPath, 'file.txt'), content)
  git(seedPath, 'commit', '-am', content)
  git(seedPath, 'push', 'origin', 'main')
}

function pull(f: Fixture, remoteUrl: string | null = f.originPath) {
  return pullRepo({
    repoId: 'r1',
    label: 'clone',
    path: f.clonePath,
    remoteUrl,
    defaultBranch: 'main',
  })
}

function headOutcome(result: Awaited<ReturnType<typeof pull>>) {
  return result.branches?.find((b) => b.branch === 'HEAD')
}

describe('pullRepo com HEAD destacado e branch sem upstream (repos temporários)', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'repo-pull-detached-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('destacado, limpo e ancestral de origin/main: reanexa na main já atualizada', async () => {
    const f = setupDetached(dir)
    const from = git(f.clonePath, 'rev-parse', '--short=7', 'HEAD')
    // Untracked não conta como sujo.
    writeFileSync(join(f.clonePath, 'scratch.png'), 'x')

    const result = await pull(f)

    expect(git(f.clonePath, 'symbolic-ref', '--short', 'HEAD')).toBe('main')
    expect(git(f.clonePath, 'rev-parse', 'HEAD')).toBe(git(f.originPath, 'rev-parse', 'main'))
    expect(headOutcome(result)).toEqual({
      branch: 'HEAD',
      status: 'reattached',
      detail: `${from}→main`,
      behind: 0,
    })
    expect(result.status).toBe('pulled')
    expect(result.detail).toContain(`HEAD: reattached(${from}→main)`)
  })

  it('destacado com mudança local tracked: pula com detached-dirty e mostra o atraso', async () => {
    const f = setupDetached(dir)
    const headBefore = git(f.clonePath, 'rev-parse', 'HEAD')
    writeFileSync(join(f.clonePath, 'file.txt'), 'local edit')

    const result = await pull(f)

    expect(git(f.clonePath, 'rev-parse', 'HEAD')).toBe(headBefore)
    expect(git(f.clonePath, 'status', '--porcelain')).toContain('file.txt')
    expect(headOutcome(result)).toMatchObject({
      status: 'skipped',
      detail: 'detached-dirty',
      behind: 1,
    })
  })

  it('destacado com commit que não está em nenhuma branch: pula e não perde o commit', async () => {
    const f = setupDetached(dir)
    writeFileSync(join(f.clonePath, 'other.txt'), 'only here')
    git(f.clonePath, 'add', 'other.txt')
    git(f.clonePath, 'commit', '-m', 'orphan work')
    const orphan = git(f.clonePath, 'rev-parse', 'HEAD')

    const result = await pull(f)

    expect(git(f.clonePath, 'rev-parse', 'HEAD')).toBe(orphan)
    expect(headOutcome(result)).toMatchObject({
      status: 'skipped',
      detail: 'detached-unique-commits',
    })
  })

  it('default em checkout noutra worktree: destaca em origin/main', async () => {
    const f = setupDetached(dir)
    const wtPath = join(dir, 'wt-main')
    git(f.clonePath, 'worktree', 'add', wtPath, 'main')

    const result = await pull(f)

    expect(git(f.clonePath, 'rev-parse', 'HEAD')).toBe(git(f.originPath, 'rev-parse', 'main'))
    expect(() => git(f.clonePath, 'symbolic-ref', '-q', 'HEAD')).toThrow()
    expect(headOutcome(result)).toMatchObject({ status: 'reattached', behind: 0 })
    expect(headOutcome(result)?.detail).toMatch(/→origin\/main$/)
  })

  it('bisect em andamento: pula com git-op-in-progress sem tocar o HEAD', async () => {
    const f = setupDetached(dir)
    git(f.clonePath, 'fetch', 'origin')
    const v1 = git(f.clonePath, 'rev-parse', 'HEAD')
    git(f.clonePath, 'bisect', 'start', 'origin/main', v1)
    const headDuringBisect = git(f.clonePath, 'rev-parse', 'HEAD')

    const result = await pull(f)

    expect(git(f.clonePath, 'rev-parse', 'HEAD')).toBe(headDuringBisect)
    expect(headOutcome(result)).toMatchObject({ status: 'skipped', detail: 'git-op-in-progress' })
  })

  it('bisect dentro de worktree vinculada também é detectado (git-path fora de .git/)', async () => {
    const f = setupDetached(dir)
    git(f.clonePath, 'fetch', 'origin')
    const v1 = git(f.clonePath, 'rev-parse', 'HEAD')
    const wtPath = join(dir, 'wt-bisect')
    git(f.clonePath, 'worktree', 'add', '--detach', wtPath, v1)
    git(wtPath, 'bisect', 'start', 'origin/main', v1)
    const headDuringBisect = git(wtPath, 'rev-parse', 'HEAD')

    const result = await pullRepo({
      repoId: 'r2',
      label: 'wt',
      path: wtPath,
      remoteUrl: f.originPath,
      defaultBranch: 'main',
    })

    expect(git(wtPath, 'rev-parse', 'HEAD')).toBe(headDuringBisect)
    expect(headOutcome(result)).toMatchObject({ status: 'skipped', detail: 'git-op-in-progress' })
  })

  it('branch sem upstream com origin/<mesmo nome>: seta o upstream e faz o fast-forward', async () => {
    const f = setupDetached(dir)
    git(f.clonePath, 'checkout', '--quiet', 'main')
    git(f.clonePath, 'branch', '--unset-upstream')

    const result = await pull(f)

    expect(git(f.clonePath, 'rev-parse', '--abbrev-ref', 'main@{upstream}')).toBe('origin/main')
    expect(git(f.clonePath, 'rev-parse', 'HEAD')).toBe(git(f.originPath, 'rev-parse', 'main'))
    expect(result.branches?.find((b) => b.branch === 'main')).toMatchObject({
      status: 'pulled',
      detail: 'upstream-set',
      behind: 0,
    })
  })

  it('branch sem upstream e sem branch de mesmo nome no origin: pula com no-upstream', async () => {
    const f = setupDetached(dir)
    git(f.clonePath, 'checkout', '--quiet', '-b', 'local-only')

    const result = await pull(f)

    expect(result.branches?.find((b) => b.branch === 'local-only')).toMatchObject({
      status: 'skipped',
      detail: 'no-upstream',
    })
    expect(result.status).not.toBe('error')
  })

  it('repo sem remote nenhum: pula com no-upstream em vez de errar', async () => {
    const localPath = join(dir, 'local')
    git(dir, 'init', '-b', 'main', localPath)
    git(localPath, 'config', 'user.email', 'test@example.com')
    git(localPath, 'config', 'user.name', 'Test')
    writeFileSync(join(localPath, 'a.txt'), 'a')
    git(localPath, 'add', 'a.txt')
    git(localPath, 'commit', '-m', 'a')

    const result = await pullRepo({
      repoId: 'r3',
      label: 'local',
      path: localPath,
      remoteUrl: null,
      defaultBranch: null,
    })

    expect(result.branches).toEqual([{ branch: 'main', status: 'skipped', detail: 'no-upstream' }])
    expect(result.status).toBe('skipped')
  })
})
