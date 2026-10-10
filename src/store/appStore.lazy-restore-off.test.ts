import { afterEach, beforeEach, describe, expect, it } from 'vitest'

// Lazy restore é opt-in (sessions.lazyRestore). Com a pref ausente/desligada o
// renderer tem que restaurar como a main: todas as panes sobem (resume com
// transcript, spawn sem), re-attach às PTYs vivas, open_panes com todas, e nada de
// plano, espelho de dormant ou wake pedido pelo main.

// appStore lê window.api no module-eval: o mock precisa existir antes do import.
const repo = { id: 'r1', label: 'infra', path: '/tmp/infra' }
const snap = (cc: string, paneId: string) => ({
  ccSessionId: cc,
  repo,
  projectName: 'Infra',
  projectIcon: null,
  projectColor: null,
  paneId,
})
const liveItem = {
  id: 'live-1',
  ccSessionId: 'cc-live',
  provider: 'claude',
  name: 'infra',
  title: null,
  repo,
  projectName: 'Infra',
  projectIcon: null,
  projectColor: null,
  lastActivityAt: 1,
}
const bootSnaps = [
  snap('cc-live', 'pane-live'),
  snap('cc-a', 'pane-a'),
  snap('cc-b', 'pane-b'),
  snap('cc-nojsonl', 'pane-nojsonl'),
]

const calls = {
  resume: [] as string[],
  spawn: 0,
  savePanes: [] as { paneId: string; ccSessionId: string }[][],
  restorePlan: 0,
  dormantSync: 0,
  wakeResult: [] as unknown[],
  prefsGet: [] as string[],
}
let prefValue: unknown = undefined
let wakeHandler: ((r: { requestId: string; ccSessionId: string }) => void) | null = null

const sessionsImpl: Record<string, (...args: never[]) => unknown> = {
  listLiveGlobal: () => Promise.resolve([liveItem]),
  isResumable: (cc: string) => Promise.resolve(cc !== 'cc-nojsonl'),
  resume: (input: { ccSessionId: string }) => {
    calls.resume.push(input.ccSessionId)
    return Promise.resolve({
      session: {
        id: `sess-${input.ccSessionId}`,
        ccSessionId: input.ccSessionId,
        repoId: 'r1',
        title: null,
        status: 'running',
        paneId: null,
        startedAt: 1,
      },
      reattached: false,
    })
  },
  spawn: () => {
    calls.spawn += 1
    return Promise.resolve({ id: 'sess-fresh', ccSessionId: 'cc-fresh', status: 'running' })
  },
  restorePlan: () => {
    calls.restorePlan += 1
    return Promise.resolve({ mode: 'eager', eagerCcSessionIds: [] })
  },
  dormantSync: (list: unknown[]) => {
    calls.dormantSync += 1
    return Promise.resolve(list)
  },
  wakeResult: (r: unknown) => {
    calls.wakeResult.push(r)
    return Promise.resolve()
  },
  onWakeRequest: (h: typeof wakeHandler) => {
    wakeHandler = h
    return () => {
      wakeHandler = null
    }
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
              if (ns === 'prefs' && prop === 'get')
                return (key: string) => {
                  calls.prefsGet.push(key)
                  return Promise.resolve(prefValue)
                }
              if (ns === 'workspace' && prop === 'getBootState')
                return () =>
                  Promise.resolve({
                    openPanes: bootSnaps,
                    cleanShutdown: true,
                    restoreAttempts: 0,
                    dockLayout: null,
                  })
              if (ns === 'workspace' && prop === 'savePanes')
                return (snaps: { paneId: string; ccSessionId: string }[]) => {
                  calls.savePanes.push(snaps)
                  return Promise.resolve()
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

const waitPersist = () => new Promise((r) => setTimeout(r, 600))

beforeEach(async () => {
  calls.resume = []
  calls.spawn = 0
  calls.savePanes = []
  calls.restorePlan = 0
  calls.dormantSync = 0
  calls.wakeResult = []
  calls.prefsGet = []
  prefValue = undefined
  useAppStore.setState({ panes: [], lazyRestore: null, restoreComplete: false })
  await useAppStore.getState().startLiveWatch()
})

afterEach(() => {
  useAppStore.getState().stopLiveWatch()
})

describe('restore com a pref desligada (default)', () => {
  it('igual à main: todas as panes vivas, resume/open como antes, open_panes intacto', async () => {
    await useAppStore.getState().restoreWorkspace()
    await waitPersist()

    expect(calls.prefsGet).toContain('sessions.lazyRestore')
    expect(useAppStore.getState().lazyRestore).toBe(false)
    // A viva re-attacha; as com transcript fazem resume; a sem JSONL vira spawn.
    expect(calls.resume.sort()).toEqual(['cc-a', 'cc-b'])
    expect(calls.spawn).toBe(1)
    const panes = useAppStore.getState().panes
    expect(panes.map((p) => p.paneId).sort()).toEqual(bootSnaps.map((s) => s.paneId).sort())
    expect(panes.filter((p) => p.dormant)).toEqual([])
    expect(panes.find((p) => p.paneId === 'pane-live')?.session.id).toBe('live-1')
    expect(
      calls.savePanes
        .at(-1)!
        .map((s) => s.paneId)
        .sort(),
    ).toEqual(bootSnaps.map((s) => s.paneId).sort())
    // Nada da maquinaria do lazy restore.
    expect(calls.restorePlan).toBe(0)
    expect(calls.dormantSync).toBe(0)
  })

  it('valor não booleano (legado) também é desligado', async () => {
    prefValue = 'lazy'
    await useAppStore.getState().restoreSnapshots(bootSnaps, null)

    expect(useAppStore.getState().lazyRestore).toBe(false)
    expect(useAppStore.getState().panes.filter((p) => p.dormant)).toEqual([])
    expect(calls.restorePlan).toBe(0)
  })

  it('pedido de wake do main não acorda nada', async () => {
    await useAppStore.getState().restoreSnapshots(bootSnaps, null)
    useAppStore.setState({ restoreComplete: true })
    calls.resume = []

    wakeHandler!({ requestId: 'w1', ccSessionId: 'cc-a' })
    await new Promise((r) => setTimeout(r, 0))

    expect(calls.resume).toEqual([])
    expect(calls.wakeResult).toEqual([
      { requestId: 'w1', sessionId: null, error: 'lazy-restore-off' },
    ])
  })
})
