import { describe, expect, it, vi } from 'vitest'

// handoffsStore importa @/lib/ipc, que lê window.api no module-eval. As funções
// puras testadas aqui não tocam a API, mas o import precisa de um stub mínimo.
// Stub ANTES do import dinâmico do store (top-level await garante a ordem).
vi.stubGlobal('window', {
  ...globalThis.window,
  api: new Proxy({}, { get: () => new Proxy({}, { get: () => () => undefined }) }),
})

const { childSessionIds, pendingHandoffs, permissionModeFor } = await import('./handoffsStore')
type Handoff = import('../../shared/types/ipc').Handoff
type HandoffMode = import('../../shared/types/ipc').HandoffMode
type HandoffStatus = import('../../shared/types/ipc').HandoffStatus

function makeHandoff(over: Partial<Handoff> = {}): Handoff {
  return {
    id: 'h1',
    motherSessionId: null,
    targetRepoId: 'repo1',
    targetRepoLabel: 'repo-label',
    childSessionId: null,
    featureId: null,
    task: 'task',
    contextJson: null,
    composedPrompt: 'prompt',
    status: 'pending',
    mode: 'interactive',
    currentStep: null,
    stepUpdatedAt: null,
    summary: null,
    error: null,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  }
}

describe('permissionModeFor', () => {
  it('plan → plan', () => {
    expect(permissionModeFor('plan')).toBe('plan')
  })

  it('auto-edits → acceptEdits', () => {
    expect(permissionModeFor('auto-edits')).toBe('acceptEdits')
  })

  it('interactive → undefined (sem permissionMode, comportamento legado)', () => {
    expect(permissionModeFor('interactive')).toBeUndefined()
  })

  it('modo desconhecido cai no default undefined', () => {
    expect(permissionModeFor('whatever' as HandoffMode)).toBeUndefined()
  })
})

describe('childSessionIds', () => {
  it('inclui a filha de um handoff running', () => {
    const ids = childSessionIds([makeHandoff({ status: 'running', childSessionId: 'sess-1' })])
    expect(ids.has('sess-1')).toBe(true)
    expect(ids.size).toBe(1)
  })

  it('ignora handoffs terminais (done/failed/rejected liberam a sessão)', () => {
    const terminal: HandoffStatus[] = ['done', 'failed', 'rejected']
    for (const status of terminal) {
      const ids = childSessionIds([makeHandoff({ status, childSessionId: 'sess-x' })])
      expect(ids.has('sess-x')).toBe(false)
    }
  })

  it('ignora handoffs ativos sem childSessionId (filha ainda não spawnada)', () => {
    const ids = childSessionIds([makeHandoff({ status: 'approved', childSessionId: null })])
    expect(ids.size).toBe(0)
  })

  // A INVARIANTE de visibilidade: esconder a filha da strip/switcher só se paga
  // porque o Crew Dock a mostra — e o dispensado não está no dock. Sem esta
  // cláusula, um card dispensado com filha viva não teria superfície nenhuma.
  it('ignora handoff DISPENSADO, mesmo vivo (o dock não o mostra; a strip precisa mostrar)', () => {
    const ids = childSessionIds([
      makeHandoff({ id: 'a', status: 'running', childSessionId: 's1', dismissedAt: 123 }),
      makeHandoff({ id: 'b', status: 'needs_input', childSessionId: 's2', dismissedAt: 123 }),
      makeHandoff({ id: 'c', status: 'running', childSessionId: 's3' }),
    ])
    expect([...ids]).toEqual(['s3'])
  })

  it('coleta múltiplas filhas ativas', () => {
    const ids = childSessionIds([
      makeHandoff({ id: 'a', status: 'running', childSessionId: 's1' }),
      makeHandoff({ id: 'b', status: 'approved', childSessionId: 's2' }),
      makeHandoff({ id: 'c', status: 'done', childSessionId: 's3' }),
    ])
    expect([...ids].sort()).toEqual(['s1', 's2'])
  })
})

describe('pendingHandoffs', () => {
  it('filtra só os pending', () => {
    const list = [
      makeHandoff({ id: 'a', status: 'pending' }),
      makeHandoff({ id: 'b', status: 'running' }),
    ]
    expect(pendingHandoffs(list).map((h) => h.id)).toEqual(['a'])
  })
})
