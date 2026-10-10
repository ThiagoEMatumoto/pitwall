import { afterEach, beforeEach, describe, expect, it } from 'vitest'

// Hibernação no renderer (H4): o main emite sessions:hibernated ANTES do pty:exit.
// A pane vira dormant no lugar (mesmo paneId) com dormantReason 'hibernated', entra
// no dormantSync, e o pty:exit seguinte não a fecha nem gera toast.

const repo = { id: 'r1', label: 'infra', path: '/tmp/infra' }

const calls = {
  resume: [] as { repoId: string | null; ccSessionId: string }[],
  dormantSync: [] as { ccSessionId: string; paneId: string }[][],
  kill: [] as string[],
}
let hibernatedHandler: ((e: { sessionId: string; ccSessionId: string }) => void) | null = null
const exitHandlers = new Set<(e: { sessionId: string; exitCode: number | null }) => void>()

const sessionsImpl: Record<string, (...args: never[]) => unknown> = {
  listLiveGlobal: () => Promise.resolve([]),
  resume: (input: { repoId: string | null; ccSessionId: string }) => {
    calls.resume.push(input)
    return Promise.resolve({
      session: { ...liveSession('sess-new', input.ccSessionId) },
      reattached: false,
    })
  },
  kill: (id: string) => {
    calls.kill.push(id)
    return Promise.resolve()
  },
  dormantSync: (list: { ccSessionId: string; paneId: string }[]) => {
    calls.dormantSync.push(list)
    return Promise.resolve(list)
  },
  onHibernated: (h: typeof hibernatedHandler) => {
    hibernatedHandler = h
    return () => {
      hibernatedHandler = null
    }
  },
  onExit: (h: (e: { sessionId: string; exitCode: number | null }) => void) => {
    exitHandlers.add(h)
    return () => exitHandlers.delete(h)
  },
}

Object.assign(window, {
  api: new Proxy(
    {},
    {
      get: (_t, ns) =>
        new Proxy(
          {},
          {
            get: (_t2, prop) => {
              const impl =
                ns === 'sessions' && typeof prop === 'string' ? sessionsImpl[prop] : undefined
              if (impl) return impl
              if (typeof prop === 'string' && prop.startsWith('on')) return () => () => {}
              return () => Promise.resolve()
            },
          },
        ),
    },
  ),
})

const { useAppStore, isHibernatedSession } = await import('./appStore')
const { exitAction } = await import('@/features/sessions/hibernate-exit')
const { useToastStore } = await import('@/features/notifications/toast-store')
type ActivePane = import('./appStore').ActivePane

const flush = () => new Promise((r) => setTimeout(r, 0))

function liveSession(id: string, cc: string): ActivePane['session'] {
  return {
    id,
    repoId: 'r1',
    ccSessionId: cc,
    title: 'deploy infra',
    titleSource: null,
    paneId: null,
    status: 'running',
    startedAt: 1,
    endedAt: null,
    provider: 'claude',
  }
}

function livePane(paneId: string, id: string, cc: string): ActivePane {
  return {
    paneId,
    session: liveSession(id, cc),
    repo: repo as ActivePane['repo'],
    projectName: 'Infra',
    projectIcon: null,
    projectColor: null,
    mode: 'terminal',
  }
}

function emitExit(sessionId: string) {
  for (const h of exitHandlers) h({ sessionId, exitCode: 0 })
}

beforeEach(async () => {
  calls.resume = []
  calls.dormantSync = []
  calls.kill = []
  useToastStore.setState({ toasts: [] })
  useAppStore.setState({
    panes: [livePane('pane-a', 'sess-a', 'cc-a'), livePane('pane-b', 'sess-b', 'cc-b')],
    focusPaneId: 'pane-a',
    restoreComplete: true,
    lazyRestore: true,
  })
  await useAppStore.getState().startLiveWatch()
  await flush()
})

afterEach(() => {
  useAppStore.getState().stopLiveWatch()
  exitHandlers.clear()
})

describe('sessions:hibernated', () => {
  it('a pane vira dormant "hibernated" no mesmo paneId e entra no dormantSync', async () => {
    expect(hibernatedHandler).not.toBeNull()
    hibernatedHandler!({ sessionId: 'sess-a', ccSessionId: 'cc-a' })
    await flush()

    const panes = useAppStore.getState().panes
    expect(panes.map((p) => p.paneId)).toEqual(['pane-a', 'pane-b'])
    const [a, b] = panes
    expect(a.dormant).toBe(true)
    expect(a.dormantReason).toBe('hibernated')
    expect(a.session.id).toBe('dormant:cc-a')
    expect(a.session.ccSessionId).toBe('cc-a')
    expect(a.session.title).toBe('deploy infra')
    expect(b.dormant).toBeUndefined()
    expect(calls.dormantSync.at(-1)).toEqual([
      expect.objectContaining({ ccSessionId: 'cc-a', paneId: 'pane-a' }),
    ])
  })

  it('o pty:exit seguinte não fecha a pane nem gera toast; o Terminal da aba fica', async () => {
    hibernatedHandler!({ sessionId: 'sess-a', ccSessionId: 'cc-a' })
    emitExit('sess-a')
    await flush()

    expect(useAppStore.getState().panes.map((p) => p.paneId)).toEqual(['pane-a', 'pane-b'])
    expect(useToastStore.getState().toasts).toEqual([])
    expect(isHibernatedSession('sess-a')).toBe(true)
    // A decisão que o Terminal toma no exit, com o estado que o evento real deixou.
    expect(exitAction('sess-a', undefined)).toBe('keep')
    expect(exitAction('sess-a', 'modal')).toBe('close')
    expect(exitAction('sess-b', undefined)).toBe('toast-and-close')
  })

  it('acordar pelo clique: mesmo wake da PR 3, mesmo paneId, sem o rótulo de hibernada', async () => {
    hibernatedHandler!({ sessionId: 'sess-a', ccSessionId: 'cc-a' })
    emitExit('sess-a')
    const id = await useAppStore.getState().wakeDormantPane('pane-a')

    expect(id).toBe('sess-new')
    expect(calls.resume).toEqual([{ repoId: 'r1', ccSessionId: 'cc-a' }])
    const a = useAppStore.getState().panes.find((p) => p.paneId === 'pane-a')!
    expect(a.dormant).toBeUndefined()
    expect(a.dormantReason).toBeUndefined()
    expect(a.session.id).toBe('sess-new')
  })

  it('sessão sem pane (background): nada muda no store', async () => {
    const before = useAppStore.getState().panes
    hibernatedHandler!({ sessionId: 'sess-bg', ccSessionId: 'cc-bg' })
    await flush()

    expect(useAppStore.getState().panes).toBe(before)
  })
})
