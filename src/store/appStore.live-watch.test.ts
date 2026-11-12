import { describe, expect, it, vi } from 'vitest'
import type { GlobalActivityBatch } from '../../shared/types/ipc'

// appStore lê window.api no module-eval: o mock precisa existir antes do import.
type ExitHandler = (e: { sessionId: string; exitCode: number }) => void
let exitHandler: ExitHandler | null = null
type RenamedHandler = (e: { sessionId: string; title: string | null }) => void
let renamedHandler: RenamedHandler | null = null
type ActivityHandler = (batch: GlobalActivityBatch) => void
let activityHandler: ActivityHandler | null = null
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
              if (ns === 'sessions' && prop === 'onRenamed')
                return (h: RenamedHandler) => {
                  renamedHandler = h
                  return () => {
                    renamedHandler = null
                  }
                }
              if (ns === 'sessions' && prop === 'onGlobalActivity')
                return (h: ActivityHandler) => {
                  activityHandler = h
                  return () => {
                    activityHandler = null
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
const { liveSessionLabel } = await import('../features/session-switcher/session-label')

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

  // Regressão B2: o rename manual só chegava à aba/header; a barra e o Ctrl+K
  // (liveSessionLabel sobre liveSessions) ficavam no auto-título até o refetch.
  it('session:renamed atualiza o rótulo da lista viva na hora, e limpar volta ao auto-título', async () => {
    live.mockResolvedValueOnce([
      {
        ...session('m'),
        name: 'cli-name',
        title: null,
        titleSource: null,
        autoTitle: 'Teste de título',
        repo: null,
      },
    ])
    await useAppStore.getState().startLiveWatch()
    const label = () => liveSessionLabel(useAppStore.getState().liveSessions[0])
    expect(label()).toBe('Teste de título')

    renamedHandler?.({ sessionId: 'm', title: 'Meu nome' })
    expect(label()).toBe('Meu nome')

    renamedHandler?.({ sessionId: 'm', title: null })
    expect(label()).toBe('Teste de título')

    useAppStore.getState().stopLiveWatch()
    expect(renamedHandler).toBeNull()
  })

  // O batch global chega a cada tick do watch, quase sempre sem novidade: trocar
  // a referência de liveSessions aí re-renderizava todos os assinantes da lista.
  it('batch global idêntico não notifica nenhum assinante do store', async () => {
    live.mockResolvedValueOnce([session('a'), session('b')])
    await useAppStore.getState().startLiveWatch()
    // Mesmas chaves que o emitGlobalBatch do main empurra (session-activity.ts).
    const batch: GlobalActivityBatch = [
      {
        ccSessionId: 'cc-a',
        status: 'working',
        lastActivityAt: 1_000,
        lastText: 'respondendo',
        tokens: { output: 12, context: 100 },
        attentionReason: undefined,
      },
      { ccSessionId: 'cc-b', status: 'idle', lastActivityAt: 2_000 },
    ]
    const notified = vi.fn()
    const off = useAppStore.subscribe(notified)

    activityHandler?.(structuredClone(batch))
    expect(notified).toHaveBeenCalledTimes(1)
    const settled = useAppStore.getState().liveSessions
    expect(settled.map((s) => s.status)).toEqual(['working', 'idle'])

    activityHandler?.(structuredClone(batch))
    expect(notified).toHaveBeenCalledTimes(1)
    expect(useAppStore.getState().liveSessions).toBe(settled)

    activityHandler?.(structuredClone(batch.map((b) => ({ ...b, status: 'waiting' as const }))))
    expect(notified).toHaveBeenCalledTimes(2)

    off()
    useAppStore.getState().stopLiveWatch()
    expect(activityHandler).toBeNull()
  })
})
