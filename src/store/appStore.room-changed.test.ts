import { describe, expect, it, vi } from 'vitest'

// appStore lê window.api no module-eval: o mock precisa existir antes do import.
// Payload igual ao do main: room-mother.ts manda { featureId }, feature-room.ts
// manda { featureId: null }. Nenhum evento de sessão nova chega pelo stream.
type RoomHandler = (p: { featureId: string | null }) => void
let roomHandler: RoomHandler | null = null
const mainLive: Array<{ id: string; ccSessionId: string }> = [{ id: 'a', ccSessionId: 'cc-a' }]
const live = vi.fn(() => Promise.resolve([...mainLive]))
Object.assign(window, {
  api: new Proxy(
    {},
    {
      get: (_t, ns) =>
        new Proxy(
          {},
          {
            get: (_t2, prop) => {
              if (ns === 'sessions' && prop === 'listLiveGlobal') return live
              if (ns === 'room' && prop === 'onChanged')
                return (h: RoomHandler) => {
                  roomHandler = h
                  return () => {
                    roomHandler = null
                  }
                }
              if (typeof prop === 'string' && prop.startsWith('on')) return () => () => {}
              return () => Promise.resolve()
            },
          },
        ),
    },
  ),
})

const { useAppStore, ROOM_REFRESH_DEBOUNCE_MS } = await import('./appStore')

describe('startLiveWatch + room:changed', () => {
  // Regressão: a mãe criada por room:start-mother (fora da ação do store) não
  // entrava em liveSessions, e o Peek fechava na hora.
  it('refaz o snapshot (com debounce) quando a Room muda', async () => {
    vi.useFakeTimers()
    try {
      await useAppStore.getState().startLiveWatch()
      expect(useAppStore.getState().liveSessions.map((s) => s.id)).toEqual(['a'])
      live.mockClear()

      mainLive.push({ id: 'mae', ccSessionId: 'cc-mae' })
      roomHandler?.({ featureId: 'f1' })
      roomHandler?.({ featureId: null })
      roomHandler?.({ featureId: 'f1' })
      expect(live).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(ROOM_REFRESH_DEBOUNCE_MS)
      expect(live).toHaveBeenCalledTimes(1)
      expect(useAppStore.getState().liveSessions.map((s) => s.id)).toEqual(['a', 'mae'])

      useAppStore.getState().stopLiveWatch()
      expect(roomHandler).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })
})
