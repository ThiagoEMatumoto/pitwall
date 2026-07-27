import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { simpleGit } from 'simple-git'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// git-remote importa db/notify, que tocam electron no topo.
vi.mock('electron', () => ({
  app: { getPath: () => tmpdir(), getVersion: () => '0.0.0-test' },
  BrowserWindow: { getAllWindows: () => [] },
}))

import { readDefaultBranch } from './git-remote'

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

describe('readDefaultBranch', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'git-remote-test-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('resolve a default via origin/HEAD', async () => {
    const origin = join(dir, 'origin.git')
    const clone = join(dir, 'clone')
    git(dir, 'init', '--bare', '-b', 'main', origin)
    git(dir, 'clone', origin, 'seed')
    const seed = join(dir, 'seed')
    git(seed, 'config', 'user.email', 'test@example.com')
    git(seed, 'config', 'user.name', 'Test')
    writeFileSync(join(seed, 'file.txt'), 'v1')
    git(seed, 'add', 'file.txt')
    git(seed, 'commit', '-m', 'init')
    git(seed, 'push', 'origin', 'main')
    git(dir, 'clone', origin, clone)

    expect(await readDefaultBranch(simpleGit(clone))).toBe('main')
  })

  // O fallback antigo (`rev-parse --abbrev-ref HEAD`) gravava a branch em
  // CHECKOUT como default — foi assim que rows do DB ficaram com 'feat/*'.
  it('sem origin/HEAD resolvido: null, nunca a branch em checkout', async () => {
    const repo = join(dir, 'solo')
    git(dir, 'init', '-b', 'main', repo)
    git(repo, 'config', 'user.email', 'test@example.com')
    git(repo, 'config', 'user.name', 'Test')
    writeFileSync(join(repo, 'file.txt'), 'v1')
    git(repo, 'add', 'file.txt')
    git(repo, 'commit', '-m', 'init')
    git(repo, 'checkout', '-b', 'feat/scaffold')

    expect(await readDefaultBranch(simpleGit(repo))).toBeNull()
  })
})
