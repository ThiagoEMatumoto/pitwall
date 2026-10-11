import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ScopeOomEvent } from '../../shared/types/ipc'

// appStore lê window.api no module-eval: o mock precisa existir antes do import.
type OomHandler = (e: ScopeOomEvent) => void
let oomHandler: OomHandler | null = null
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
              if (ns === 'sessions' && prop === 'onOom')
                return (h: OomHandler) => {
                  oomHandler = h
                  return () => {
                    oomHandler = null
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
const { useToastStore } = await import('@/features/notifications/toast-store')

describe('sessions:oom → toast', () => {
  afterEach(() => {
    useAppStore.getState().stopLiveWatch()
    useToastStore.setState({ toasts: [] })
  })

  async function watching(): Promise<OomHandler> {
    live.mockResolvedValueOnce([{ id: 's1', ccSessionId: 'cc-s1', title: 'refactor auth' }])
    await useAppStore.getState().startLiveWatch()
    expect(oomHandler).not.toBeNull()
    return oomHandler!
  }

  it('claude vivo: avisa que um processo foi encerrado e a conversa continua', async () => {
    const handler = await watching()
    handler({ sessionId: 's1', maxGB: 14, claudeAlive: true })
    expect(useToastStore.getState().toasts.map((t) => t.title)).toEqual([
      'um processo da sessão refactor auth passou de 14 GB e foi encerrado; a conversa continua',
    ])
  })

  it('claude morto: a sessão foi encerrada por memória', async () => {
    const handler = await watching()
    handler({ sessionId: 's1', maxGB: 14, claudeAlive: false })
    expect(useToastStore.getState().toasts.map((t) => t.title)).toEqual([
      'sessão refactor auth encerrada por memória — retome',
    ])
  })

  it('para de escutar no stopLiveWatch', async () => {
    await watching()
    useAppStore.getState().stopLiveWatch()
    expect(oomHandler).toBeNull()
  })
})
