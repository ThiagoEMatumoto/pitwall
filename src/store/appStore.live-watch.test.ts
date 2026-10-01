import { describe, expect, it, vi } from 'vitest'

// appStore lê window.api no module-eval: o mock precisa existir antes do import.
type ExitHandler = (e: { sessionId: string; exitCode: number }) => void
let exitHandler: ExitHandler | null = null
const live = vi.fn()
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
              if (ns === 'sessions' && prop === 'onExit')
                return (h: ExitHandler) => {
                  exitHandler = h
                  return () => {
                    exitHandler = null
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

const { useAppStore } = await import('./appStore')

const session = (id: string) => ({ id, ccSessionId: `cc-${id}` })

describe('startLiveWatch', () => {
  // Regressão: filha do dock (sem aba) que saía sozinha ficava em liveSessions —
  // e no mapa como "encerrada" — porque só mutações do store refaziam o snapshot.
  it('refaz o snapshot quando qualquer PTY sai', async () => {
    live.mockResolvedValueOnce([session('a'), session('b')])
    await useAppStore.getState().startLiveWatch()
    expect(useAppStore.getState().liveSessions.map((s) => s.id)).toEqual(['a', 'b'])

    live.mockResolvedValueOnce([session('a')])
    exitHandler?.({ sessionId: 'b', exitCode: 0 })
    await vi.waitFor(() =>
      expect(useAppStore.getState().liveSessions.map((s) => s.id)).toEqual(['a']),
    )

    useAppStore.getState().stopLiveWatch()
    expect(exitHandler).toBeNull()
  })
})
