import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  BrowserWindow: { getAllWindows: () => [] },
}))
vi.mock('../services/db', () => ({ getDb: vi.fn() }))
vi.mock('../services/pty-manager', () => ({ ptyManager: { runningIds: () => [] } }))
vi.mock('../services/session-activity', () => ({
  buildSessionsFileIndex: () => new Map(),
  isPidAlive: () => true,
  mapStatus: () => 'idle',
}))
vi.mock('../services/task-store', () => ({ affectedObjectiveIds: () => [] }))

import { broadcast } from '../services/notify'
import { GRAPH_PUSH_DELAY_MS, watchSessionGraph } from './session-graph'

describe('watchSessionGraph', () => {
  let stop: () => void = () => {}
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    stop()
    vi.useRealTimers()
  })

  it('uma rajada de mudanças vira um push só, ~300ms depois', () => {
    const push = vi.fn()
    stop = watchSessionGraph(push)

    broadcast('handoff:updated', {})
    broadcast('repo-deps:updated', {})
    broadcast('session:activity:global', [])
    broadcast('pty:exit', { sessionId: 's' })
    expect(push).not.toHaveBeenCalled()

    vi.advanceTimersByTime(GRAPH_PUSH_DELAY_MS)
    expect(push).toHaveBeenCalledTimes(1)
  })

  it('pulso, foco e status da feature reconstroem o card (feature:updated, loop:updated)', () => {
    const push = vi.fn()
    stop = watchSessionGraph(push)
    broadcast('loop:updated', { featureId: 'f1' })
    vi.advanceTimersByTime(GRAPH_PUSH_DELAY_MS)
    broadcast('feature:updated', { id: 'f1' })
    vi.advanceTimersByTime(GRAPH_PUSH_DELAY_MS)
    expect(push).toHaveBeenCalledTimes(2)
  })

  it('canais que não mexem no grafo não disparam (nem o próprio push)', () => {
    const push = vi.fn()
    stop = watchSessionGraph(push)

    broadcast('task:updated', {})
    broadcast('pty:data', 'x')
    broadcast('session-graph:updated', {})
    broadcast('session:activity', {})
    vi.advanceTimersByTime(GRAPH_PUSH_DELAY_MS * 3)
    expect(push).not.toHaveBeenCalled()
  })

  it('atividade contínua não mata o push de fome (coalesce, não reinicia o timer)', () => {
    const push = vi.fn()
    stop = watchSessionGraph(push)

    for (let t = 0; t < 1000; t += 100) {
      broadcast('session:activity:global', [])
      vi.advanceTimersByTime(100)
    }
    expect(push.mock.calls.length).toBeGreaterThanOrEqual(3)
  })

  it('parar o watch cancela o push pendente', () => {
    const push = vi.fn()
    stop = watchSessionGraph(push)
    broadcast('handoff:updated', {})
    stop()
    vi.advanceTimersByTime(GRAPH_PUSH_DELAY_MS * 2)
    broadcast('handoff:updated', {})
    vi.advanceTimersByTime(GRAPH_PUSH_DELAY_MS * 2)
    expect(push).not.toHaveBeenCalled()
  })
})
