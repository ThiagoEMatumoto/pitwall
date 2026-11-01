import { afterEach, beforeEach, describe, expect, it } from 'vitest'

// "Tornar mãe" relança a conversa (kill + resume = sessions.id novo). O main avisa
// 'relaunching' ANTES do kill: a pane fica no lugar (o pty:exit, código 129, não a
// fecha) e adota a sessão relançada no MESMO paneId quando chega 'restarted'.

const repo = { id: 'r1', label: 'infra', path: '/tmp/infra' }

const calls = {
  resume: [] as { repoId: string | null; ccSessionId: string }[],
  dormantSync: [] as { ccSessionId: string; paneId: string }[][],
  kill: [] as string[],
  paneCheck: [] as { requestId: string; paneId: string | null }[],
  paneClosed: [] as string[],
}
type HibernatedEvent = { sessionId: string; ccSessionId: string; paneId: string | null }
let hibernatedHandler: ((e: HibernatedEvent) => void) | null = null
let paneCheckHandler:
  ((r: { requestId: string; sessionId: string; ccSessionId: string }) => void) | null = null
let liveList: unknown[] = []
const exitHandlers = new Set<(e: { sessionId: string; exitCode: number | null }) => void>()

const sessionsImpl: Record<string, (...args: never[]) => unknown> = {
  listLiveGlobal: () => Promise.resolve(liveList),
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
  onPaneCheckRequest: (h: typeof paneCheckHandler) => {
    paneCheckHandler = h
    return () => {
      paneCheckHandler = null
    }
  },
  paneCheckResult: (r: { requestId: string; paneId: string | null }) => {
    calls.paneCheck.push(r)
    return Promise.resolve()
  },
  paneClosed: (id: string) => {
    calls.paneClosed.push(id)
    return Promise.resolve()
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

const { useAppStore, holdPaneForRelaunch, adoptRelaunchedSession } = await import('./appStore')
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
  liveList = []
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

describe('relance da promoção a mãe', () => {
  it('o exit da filha não fecha a aba e a sessão nova entra no mesmo paneId', async () => {
    holdPaneForRelaunch('sess-a', 'cc-a')
    for (const h of exitHandlers) h({ sessionId: 'sess-a', exitCode: 129 })
    await flush()

    expect(exitAction('sess-a', undefined)).toBe('keep')
    expect(useAppStore.getState().panes.map((p) => p.paneId)).toEqual(['pane-a', 'pane-b'])
    expect(useToastStore.getState().toasts).toEqual([])

    adoptRelaunchedSession(liveSession('sess-mae', 'cc-a'))
    const panes = useAppStore.getState().panes
    expect(panes.map((p) => p.paneId)).toEqual(['pane-a', 'pane-b'])
    expect(panes[0].session.id).toBe('sess-mae')
    expect(panes[0].dormant).toBeUndefined()
    expect(panes[1].session.id).toBe('sess-b')
  })

  it('sessão sem aba: nada muda', () => {
    holdPaneForRelaunch('sess-x', 'cc-x')
    adoptRelaunchedSession(liveSession('sess-y', 'cc-x'))
    expect(useAppStore.getState().panes.map((p) => p.session.id)).toEqual(['sess-a', 'sess-b'])
  })
})
