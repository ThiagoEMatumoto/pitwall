import { tmpdir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'

// repo-pull importa db/notify/git-auth, que tocam electron no topo. Mockamos o
// mínimo; classifyPullEligibility é puro e não usa nada disso.
vi.mock('electron', () => ({
  app: { getPath: () => tmpdir(), getVersion: () => '0.0.0-test' },
  BrowserWindow: { getAllWindows: () => [] },
}))

import {
  classifyPullEligibility,
  deriveOverallStatus,
  isUntrackedCollision,
  parseCheckedOutBranches,
} from './repo-pull'

// Como o simple-git representa cada arquivo em `status.files`: os dois dígitos
// do short format do git. Untracked é '??' — e o parser do simple-git empurra
// TODA linha que não seja '##'/'!!' pra `files`, então untracked aparece lá
// junto com not_added.
const untracked = () => ({ index: '?', working_dir: '?' })
const modified = () => ({ index: ' ', working_dir: 'M' })
const stagedAdd = () => ({ index: 'A', working_dir: ' ' })

describe('classifyPullEligibility', () => {
  it('dirty quando há arquivos tracked modificados', () => {
    expect(classifyPullEligibility({ ahead: 0, files: [modified()] })).toBe('dirty')
  })

  it('dirty tem prioridade sobre diverged', () => {
    expect(
      classifyPullEligibility({ ahead: 3, files: [modified(), modified()] }),
    ).toBe('dirty')
  })

  it('diverged quando há commits locais adiante e a tree está limpa', () => {
    expect(classifyPullEligibility({ ahead: 2, files: [] })).toBe('diverged')
  })

  it('eligible quando limpo e sem commits adiante', () => {
    expect(classifyPullEligibility({ ahead: 0, files: [] })).toBe('eligible')
  })

  // O bug: untracked entram em `status.files`, então lixo de scratch
  // (.playwright-mcp/, PNGs) marcava o repo como sujo pra sempre e ele nunca
  // era atualizado.
  it('eligible quando o único "sujo" são arquivos untracked', () => {
    expect(
      classifyPullEligibility({
        ahead: 0,
        // ex.: .playwright-mcp/, PNG de scratch
        files: [untracked(), untracked()],
      }),
    ).toBe('eligible')
  })

  it('dirty quando há untracked E um arquivo tracked modificado', () => {
    expect(
      classifyPullEligibility({ ahead: 0, files: [untracked(), modified()] }),
    ).toBe('dirty')
  })

  it('diverged (não eligible) quando só há untracked mas há commits locais adiante', () => {
    expect(classifyPullEligibility({ ahead: 1, files: [untracked()] })).toBe('diverged')
  })

  it('dirty quando o arquivo novo já foi staged (deixou de ser untracked)', () => {
    expect(
      classifyPullEligibility({ ahead: 0, files: [stagedAdd()] }),
    ).toBe('dirty')
  })
})

describe('isUntrackedCollision', () => {
  it('reconhece a recusa do merge por untracked que seria sobrescrito', () => {
    const msg = [
      'error: The following untracked working tree files would be overwritten by merge:',
      '\tnovo.txt',
      'Please move or remove them before you merge.',
      'Aborting',
    ].join('\n')
    expect(isUntrackedCollision(msg)).toBe(true)
  })

  it('reconhece a variante de checkout', () => {
    expect(
      isUntrackedCollision(
        'error: The following untracked working tree files would be overwritten by checkout:',
      ),
    ).toBe(true)
  })

  it('não confunde com um non-fast-forward comum', () => {
    expect(isUntrackedCollision('fatal: Not possible to fast-forward, aborting.')).toBe(false)
  })
})

describe('deriveOverallStatus', () => {
  it('skipped quando não há branches (nada foi tentado)', () => {
    expect(deriveOverallStatus([])).toEqual({ status: 'skipped', detail: undefined })
  })

  it('skipped quando todas as branches foram puladas', () => {
    const result = deriveOverallStatus([
      { branch: 'feat/x', status: 'skipped', detail: 'dirty' },
    ])
    expect(result.status).toBe('skipped')
    expect(result.detail).toBe('feat/x: skipped(dirty)')
  })

  it('up-to-date quando nada avançou mas algo estava em dia', () => {
    const result = deriveOverallStatus([
      { branch: 'main', status: 'up-to-date' },
      { branch: 'feat/x', status: 'skipped', detail: 'diverged' },
    ])
    expect(result.status).toBe('up-to-date')
  })

  it('pulled quando pelo menos uma branch avançou', () => {
    const result = deriveOverallStatus([
      { branch: 'main', status: 'pulled' },
      { branch: 'feat/x', status: 'skipped', detail: 'dirty' },
    ])
    expect(result.status).toBe('pulled')
    expect(result.detail).toBe('main: pulled · feat/x: skipped(dirty)')
  })

  it('error tem prioridade sobre pulled/up-to-date quando misto', () => {
    const result = deriveOverallStatus([
      { branch: 'main', status: 'pulled' },
      { branch: 'feat/x', status: 'error', detail: 'boom' },
    ])
    expect(result.status).toBe('error')
    expect(result.detail).toBe('main: pulled · feat/x: error(boom)')
  })
})

describe('parseCheckedOutBranches', () => {
  // Cenário do bug: a worktree PRINCIPAL está numa feature branch e a default
  // (main) está em checkout numa VINCULADA — `git status` só enxerga a primeira.
  it('pega a branch da worktree principal e das vinculadas', () => {
    const porcelain = [
      'worktree /home/u/repo',
      'HEAD 1111111111111111111111111111111111111111',
      'branch refs/heads/feat/x',
      '',
      'worktree /home/u/repo/.worktrees/main',
      'HEAD 2222222222222222222222222222222222222222',
      'branch refs/heads/main',
      '',
    ].join('\n')

    expect(parseCheckedOutBranches(porcelain)).toEqual(
      new Map([
        ['feat/x', '/home/u/repo'],
        ['main', '/home/u/repo/.worktrees/main'],
      ]),
    )
  })

  it('ignora blocos detached (não têm linha branch)', () => {
    const porcelain = [
      'worktree /home/u/repo',
      'HEAD 1111111111111111111111111111111111111111',
      'branch refs/heads/main',
      '',
      'worktree /home/u/repo/.worktrees/wip',
      'HEAD 3333333333333333333333333333333333333333',
      'detached',
      '',
    ].join('\n')

    expect(parseCheckedOutBranches(porcelain)).toEqual(new Map([['main', '/home/u/repo']]))
  })

  it('set vazio quando não há nenhuma branch em checkout', () => {
    expect(parseCheckedOutBranches('')).toEqual(new Map())
  })
})
