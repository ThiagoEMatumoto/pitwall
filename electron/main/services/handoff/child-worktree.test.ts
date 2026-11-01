// Repo git REAL em tmpdir: o worktree automático é git de verdade (branch, base,
// check-ignore), nada mockado.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { childSlug, ensureChildWorkspace } from './child-worktree'
import { composeHandoffPrompt } from './compose-prompt'

function sh(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()
}

let base: string
let origin: string
let repo: string

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'child-wt-')))
  origin = join(base, 'origin.git')
  repo = join(base, 'repo')
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin])
  execFileSync('git', ['clone', '-q', origin, repo], { stdio: 'ignore' })
  sh(repo, 'config', 'user.email', 't@t')
  sh(repo, 'config', 'user.name', 't')
  writeFileSync(join(repo, '.gitignore'), '.worktrees/\n')
  sh(repo, 'add', '.gitignore')
  sh(repo, 'commit', '-q', '-m', 'init')
  sh(repo, 'push', '-q', 'origin', 'main')
  sh(repo, 'remote', 'set-head', 'origin', 'main')
})

afterEach(() => {
  rmSync(base, { recursive: true, force: true })
})

describe('ensureChildWorkspace', () => {
  it('checkout na main → cria worktree próprio a partir de origin/main', () => {
    const ws = ensureChildWorkspace({
      workDir: repo,
      alias: 'Mauricio Child Autonomy',
      handoffId: 'abcd1234-ef00-0000-0000-000000000000',
    })
    expect(ws.created).toBe(true)
    expect(ws.branch).toBe('child/mauricio-child-autonomy-abcd1234')
    expect(ws.workDir).toBe(join(repo, '.worktrees', 'child-mauricio-child-autonomy'))
    expect(ws.warning).toBeUndefined()
    expect(sh(ws.workDir, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(ws.branch)
    expect(sh(ws.workDir, 'rev-parse', 'HEAD')).toBe(sh(repo, 'rev-parse', 'origin/main'))
    // A raiz continua na main, intocada.
    expect(sh(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main')
  })

  it('branch de trabalho → não cria nada e usa o work_dir como está', () => {
    sh(repo, 'switch', '-q', '-c', 'feat/x')
    const ws = ensureChildWorkspace({ workDir: repo, alias: 'a', handoffId: 'h1' })
    expect(ws).toEqual({ workDir: repo, branch: 'feat/x', created: false })
  })

  it('diretório fora de git → work_dir original, sem aviso', () => {
    const plain = join(base, 'plain')
    execFileSync('mkdir', [plain])
    expect(ensureChildWorkspace({ workDir: plain, alias: 'a', handoffId: 'h1' })).toEqual({
      workDir: plain,
      branch: null,
      created: false,
    })
  })

  it('pasta do worktree já existe → sufixa com o shortid', () => {
    const first = ensureChildWorkspace({ workDir: repo, alias: 'dup', handoffId: '11111111-x' })
    const second = ensureChildWorkspace({ workDir: repo, alias: 'dup', handoffId: '22222222-x' })
    expect(first.created && second.created).toBe(true)
    expect(second.workDir).toBe(join(repo, '.worktrees', 'child-dup-22222222'))
  })

  it('.worktrees não ignorado → cria e avisa', () => {
    writeFileSync(join(repo, '.gitignore'), '')
    const ws = ensureChildWorkspace({ workDir: repo, alias: 'b', handoffId: 'h2' })
    expect(ws.created).toBe(true)
    expect(ws.warning).toMatch(/\.worktrees\/ não está no \.gitignore/)
  })

  it('falha do git (branch já existe) → work_dir original com aviso', () => {
    sh(repo, 'branch', 'child/c-h3')
    const ws = ensureChildWorkspace({ workDir: repo, alias: 'c', handoffId: 'h3' })
    expect(ws.created).toBe(false)
    expect(ws.workDir).toBe(repo)
    expect(ws.warning).toMatch(/Não foi possível criar um worktree próprio/)
    expect(existsSync(join(repo, '.worktrees', 'child-c'))).toBe(false)
  })

  it('briefing com o workspace real diz a branch, o worktree e libera push/PR', () => {
    const ws = ensureChildWorkspace({ workDir: repo, alias: 'd', handoffId: 'h4' })
    const prompt = composeHandoffPrompt({
      targetRepoLabel: 'repo',
      targetRepoPath: repo,
      task: 't',
      edges: [],
      handoffId: 'h4',
      alias: 'd',
      mode: 'auto-edits',
      workspace: ws,
    })
    expect(prompt).toContain(`worktree próprio: ${ws.workDir}`)
    expect(prompt).toContain(`git push -u origin ${ws.branch}`)
    expect(prompt).toContain('gh pr create')
    expect(prompt).toContain('child/*')
  })
})

describe('childSlug', () => {
  it('normaliza o alias', () => {
    expect(childSlug('Ágata / UI--fix!')).toBe('gata-ui-fix')
    expect(childSlug('***')).toBe('child')
  })
})
