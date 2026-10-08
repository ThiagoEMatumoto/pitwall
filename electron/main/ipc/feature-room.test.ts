import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  BrowserWindow: { getAllWindows: () => [] },
}))
vi.mock('../services/task-store', () => ({ affectedObjectiveIds: () => [] }))
// O snapshot não é o assunto aqui: só o watcher.
vi.mock('../services/feature-room-service', () => ({ roomSnapshot: () => null }))

import { broadcast } from '../services/notify'
import { ROOM_PUSH_DELAY_MS, watchRoom } from './feature-room'

describe('watchRoom', () => {
  let stop: () => void = () => {}
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    stop()
    vi.useRealTimers()
  })

  it('N handoff:* dentro de 300ms viram 1 push; room: não realimenta', () => {
    const push = vi.fn()
    stop = watchRoom(push)
    for (let i = 0; i < 5; i++) {
      broadcast('handoff:updated', {})
      vi.advanceTimersByTime(50)
    }
    expect(push).not.toHaveBeenCalled()
    vi.advanceTimersByTime(ROOM_PUSH_DELAY_MS)
    expect(push).toHaveBeenCalledTimes(1)

    broadcast('room:changed', { featureId: null })
    vi.advanceTimersByTime(ROOM_PUSH_DELAY_MS * 2)
    expect(push).toHaveBeenCalledTimes(1)

    for (const ch of ['feature:updated', 'loop:updated']) {
      broadcast(ch, {})
      vi.advanceTimersByTime(ROOM_PUSH_DELAY_MS)
    }
    expect(push).toHaveBeenCalledTimes(3)
  })
})
