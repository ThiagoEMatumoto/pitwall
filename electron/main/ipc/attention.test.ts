import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  BrowserWindow: { getAllWindows: () => [] },
}))
vi.mock('../services/task-store', () => ({ affectedObjectiveIds: () => [] }))
// O cálculo não é o assunto aqui: o watcher e o pusher recebem compute injetado.
vi.mock('../services/attention/attention-service', () => ({
  computeAttention: () => [],
  attentionCounters: () => ({}),
}))

import { broadcast } from '../services/notify'
import { tuiMenuWatch } from '../services/tui-menu-watch'
import { ATTENTION_PUSH_DELAY_MS, createAttentionPusher, watchAttention } from './attention'
import type { AttentionItem } from '../../../shared/types/attention'

describe('watchAttention', () => {
  let stop: () => void = () => {}
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    stop()
    vi.useRealTimers()
  })

  it('5 handoff:updated dentro de 300ms viram 1 push', () => {
    const push = vi.fn()
    stop = watchAttention(push)
    for (let i = 0; i < 5; i++) {
      broadcast('handoff:updated', {})
      vi.advanceTimersByTime(50)
    }
    expect(push).not.toHaveBeenCalled()
    vi.advanceTimersByTime(ATTENTION_PUSH_DELAY_MS)
    expect(push).toHaveBeenCalledTimes(1)
  })

  it('atividade global, pty:exit e troca de feature agendam push', () => {
    const push = vi.fn()
    stop = watchAttention(push)
    for (const ch of ['session:activity:global', 'pty:exit', 'session:feature-changed']) {
      broadcast(ch, {})
      vi.advanceTimersByTime(ATTENTION_PUSH_DELAY_MS)
    }
    expect(push).toHaveBeenCalledTimes(3)
  })

  it("o menu da TUI (tuiMenuWatch 'change') agenda um push", () => {
    const push = vi.fn()
    stop = watchAttention(push)
    tuiMenuWatch.emit('change', 's1')
    vi.advanceTimersByTime(ATTENTION_PUSH_DELAY_MS)
    expect(push).toHaveBeenCalledTimes(1)
  })

  it('o próprio attention:changed não realimenta; parar desliga tudo', () => {
    const push = vi.fn()
    stop = watchAttention(push)
    broadcast('attention:changed', [])
    vi.advanceTimersByTime(ATTENTION_PUSH_DELAY_MS * 3)
    expect(push).not.toHaveBeenCalled()
    stop()
    broadcast('handoff:updated', {})
    tuiMenuWatch.emit('change', 's1')
    vi.advanceTimersByTime(ATTENTION_PUSH_DELAY_MS * 3)
    expect(push).not.toHaveBeenCalled()
    expect(tuiMenuWatch.listenerCount('change')).toBe(0)
  })
})

describe('createAttentionPusher', () => {
  it('só envia quando a lista muda', () => {
    let items: AttentionItem[] = []
    const send = vi.fn()
    const push = createAttentionPusher(() => items, send)
    push()
    expect(send).toHaveBeenCalledTimes(1)
    push()
    expect(send).toHaveBeenCalledTimes(1)
    items = [{ kind: 'session_menu', dedupKey: 'x' } as AttentionItem]
    push()
    push()
    expect(send).toHaveBeenCalledTimes(2)
  })
})
