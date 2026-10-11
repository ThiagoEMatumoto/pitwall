import { afterEach, beforeEach, describe, expect, it } from 'vitest'

// Hibernação no renderer (H4): o main emite sessions:hibernated ANTES do pty:exit.
// A pane vira dormant no lugar (mesmo paneId) com dormantReason 'hibernated', entra
// no dormantSync, e o pty:exit seguinte não a fecha nem gera toast.

const repo = { id: 'r1', label: 'infra', path: '/tmp/infra' }

const calls = {
  resume: [] as { repoId: string | null; ccSessionId: string }[],
  dormantSync: [] as { ccSessionId: string; paneId: string }[][],
  kill: [] as string[],
  paneCheck: [] as { requestId: string; paneId: string | null }[],
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
  calls.paneCheck = []
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

describe('sessions:hibernated', () => {
  it('a pane vira dormant "hibernated" no mesmo paneId e entra no dormantSync', async () => {
    expect(hibernatedHandler).not.toBeNull()
    hibernatedHandler!({ sessionId: 'sess-a', ccSessionId: 'cc-a', paneId: 'pane-a' })
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
    hibernatedHandler!({ sessionId: 'sess-a', ccSessionId: 'cc-a', paneId: 'pane-a' })
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
    hibernatedHandler!({ sessionId: 'sess-a', ccSessionId: 'cc-a', paneId: 'pane-a' })
    emitExit('sess-a')
    const id = await useAppStore.getState().wakeDormantPane('pane-a')

    expect(id).toBe('sess-new')
    expect(calls.resume).toEqual([{ repoId: 'r1', ccSessionId: 'cc-a' }])
    const a = useAppStore.getState().panes.find((p) => p.paneId === 'pane-a')!
    expect(a.dormant).toBeUndefined()
    expect(a.dormantReason).toBeUndefined()
    expect(a.session.id).toBe('sess-new')
  })

  it('a aba sumiu entre a confirmação e o exit → vira uma pane dormant "hibernated"', async () => {
    useAppStore.setState({
      liveSessions: [
        {
          id: 'sess-c',
          ccSessionId: 'cc-c',
          name: null,
          title: 'migrar banco',
          status: 'idle',
          repo: repo as ActivePane['repo'],
          projectName: 'Infra',
          projectIcon: null,
          projectColor: null,
          lastActivityAt: null,
          lastText: null,
        },
      ],
    })
    hibernatedHandler!({ sessionId: 'sess-c', ccSessionId: 'cc-c', paneId: 'pane-c' })
    emitExit('sess-c')
    await flush()

    const c = useAppStore.getState().panes.find((p) => p.session.ccSessionId === 'cc-c')!
    expect(c).toMatchObject({
      paneId: 'pane-c',
      dormant: true,
      dormantReason: 'hibernated',
      projectName: 'Infra',
      repo,
    })
    expect(c.session).toMatchObject({ id: 'dormant:cc-c', title: 'migrar banco' })
    expect(useToastStore.getState().toasts).toEqual([])
    // O main acha a pane para acordar (agent-bus, wake da mãe).
    expect(calls.dormantSync.at(-1)).toEqual([
      expect.objectContaining({ ccSessionId: 'cc-c', paneId: 'pane-c' }),
    ])
    // E o clique acorda pelo mesmo caminho.
    expect(await useAppStore.getState().wakeDormantPane('pane-c')).toBe('sess-new')
  })

  it('sem nada da sessão no store: a dormant nasce sem repo, mas existe', async () => {
    hibernatedHandler!({ sessionId: 'sess-bg', ccSessionId: 'cc-bg', paneId: null })
    await flush()
    const bg = useAppStore.getState().panes.find((p) => p.session.ccSessionId === 'cc-bg')!
    expect(bg).toMatchObject({ dormant: true, dormantReason: 'hibernated', repo: null })
  })
})

describe('sessions:pane-check-request (confirmação antes do /exit)', () => {
  it('aba acordada mostrando a PTY → devolve o paneId', () => {
    paneCheckHandler!({ requestId: 'r1', sessionId: 'sess-b', ccSessionId: 'cc-b' })
    expect(calls.paneCheck).toEqual([{ requestId: 'r1', paneId: 'pane-b' }])
  })

  it('sem aba (fechada) ou já dormindo → null', () => {
    paneCheckHandler!({ requestId: 'r2', sessionId: 'sess-x', ccSessionId: 'cc-x' })
    hibernatedHandler!({ sessionId: 'sess-a', ccSessionId: 'cc-a', paneId: 'pane-a' })
    paneCheckHandler!({ requestId: 'r3', sessionId: 'sess-a', ccSessionId: 'cc-a' })
    expect(calls.paneCheck).toEqual([
      { requestId: 'r2', paneId: null },
      { requestId: 'r3', paneId: null },
    ])
  })
})
