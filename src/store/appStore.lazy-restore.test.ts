import { afterEach, beforeEach, describe, expect, it } from 'vitest'

// Lazy restore no renderer (D5): no boot só sobem processo as eager (plano do
// main + pane ativa do layout + sem transcript); o resto volta dormant, sem
// spawn, com o mesmo paneId. Nenhum IPC pode levar o id sintético 'dormant:'.

const repo = { id: 'r1', label: 'infra', path: '/tmp/infra' }
type Snap = {
  ccSessionId: string
  repo: typeof repo
  projectName: string
  projectIcon: null
  projectColor: null
  paneId: string
}
const snap = (cc: string, paneId: string): Snap => ({
  ccSessionId: cc,
  repo,
  projectName: 'Infra',
  projectIcon: null,
  projectColor: null,
  paneId,
})

// Layout do dockview como o api.toJSON() grava: activeGroup aponta o grupo g1,
// cuja aba ativa é pane-active.
const dockLayout = JSON.stringify({
  grid: {
    root: {
      type: 'branch',
      data: [
        {
          type: 'leaf',
          data: { id: 'g1', views: ['pane-sleep1', 'pane-active'], activeView: 'pane-active' },
        },
        { type: 'leaf', data: { id: 'g2', views: ['pane-sleep2'], activeView: 'pane-sleep2' } },
      ],
    },
    width: 100,
    height: 100,
    orientation: 'HORIZONTAL',
  },
  panels: {},
  activeGroup: 'g1',
})

const bootSnaps = [
  snap('cc-mother', 'pane-mother'),
  snap('cc-active', 'pane-active'),
  snap('cc-nojsonl', 'pane-nojsonl'),
  snap('cc-sleep1', 'pane-sleep1'),
  snap('cc-sleep2', 'pane-sleep2'),
]

const calls = {
  resume: [] as { repoId: string | null; ccSessionId: string }[],
  spawn: 0,
  savePanes: [] as Snap[][],
  dormantSync: [] as unknown[][],
  wakeResult: [] as unknown[],
  restorePlan: [] as string[][],
  // Qualquer chamada IPC que carregue um id 'dormant:' — tem que ficar vazio.
  dormantIpc: [] as string[],
}
let resumeGate: Promise<void> = Promise.resolve()
let wakeHandler: ((r: { requestId: string; ccSessionId: string }) => void) | null = null

function sessionFor(cc: string, id = `sess-${cc}`) {
  return { id, ccSessionId: cc, repoId: 'r1', title: null, status: 'running', paneId: null }
}

const sessionsImpl: Record<string, (...args: never[]) => unknown> = {
  listLiveGlobal: () => Promise.resolve([]),
  restorePlan: (ccs: string[]) => {
    calls.restorePlan.push(ccs)
    return Promise.resolve({
      mode: 'lazy',
      eagerCcSessionIds: ccs.filter((c) => c === 'cc-mother'),
    })
  },
  isResumable: (cc: string) => Promise.resolve(cc !== 'cc-nojsonl'),
  resume: async (input: { repoId: string | null; ccSessionId: string }) => {
    calls.resume.push(input)
    await resumeGate
    return sessionFor(input.ccSessionId)
  },
  spawn: () => {
    calls.spawn += 1
    return Promise.resolve(sessionFor('cc-fresh', 'sess-fresh'))
  },
  dormantSync: (list: unknown[]) => {
    calls.dormantSync.push(list)
    return Promise.resolve()
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
              return (...args: unknown[]) => {
                for (const a of args) {
                  const s = JSON.stringify(a) ?? ''
                  // dormantSync manda cc + paneId, nunca o id sintético; o resto idem.
                  if (s.includes('dormant:')) calls.dormantIpc.push(`${String(ns)}.${String(prop)}`)
                }
                if (impl) return (impl as (...a: unknown[]) => unknown)(...args)
                if (ns === 'workspace' && prop === 'savePanes') {
                  calls.savePanes.push(args[0] as Snap[])
                  return Promise.resolve()
                }
                if (ns === 'workspace' && prop === 'getBootState')
                  return Promise.resolve({
                    openPanes: bootSnaps,
                    cleanShutdown: true,
                    restoreAttempts: 0,
                    dockLayout,
                  })
                if (typeof prop === 'string' && prop.startsWith('on')) return () => {}
                return Promise.resolve()
              }
            },
          },
        ),
    },
  ),
})

const { useAppStore, activePaneIdFromLayout } = await import('./appStore')
const { wakeIfDormant } = await import('@/features/sessions/dormant-wake')

const flush = () => new Promise((r) => setTimeout(r, 0))
const waitPersist = () => new Promise((r) => setTimeout(r, 600))

function seedDormant(cc: string, paneId: string) {
  useAppStore.setState({
    panes: [
      {
        paneId,
        session: {
          id: `dormant:${cc}`,
          repoId: 'r1',
          ccSessionId: cc,
          title: null,
          titleSource: null,
          paneId,
          status: 'exited',
          startedAt: 1,
          endedAt: null,
          provider: 'claude',
        },
        repo,
        projectName: 'Infra',
        projectIcon: null,
        projectColor: null,
        mode: 'terminal',
        dormant: true,
      },
    ],
  })
}

beforeEach(() => {
  calls.resume = []
  calls.spawn = 0
  calls.savePanes = []
  calls.dormantSync = []
  calls.wakeResult = []
  calls.restorePlan = []
  resumeGate = Promise.resolve()
  useAppStore.setState({ panes: [], focusPaneId: null })
})

afterEach(() => {
  expect(calls.dormantIpc).toEqual([])
})

describe('activePaneIdFromLayout', () => {
  it('acha a aba ativa do grupo ativo na árvore do grid', () => {
    expect(activePaneIdFromLayout(dockLayout)).toBe('pane-active')
  })

  it('layout inválido ou sem activeGroup = nenhuma', () => {
    expect(activePaneIdFromLayout('{oops')).toBeNull()
    expect(activePaneIdFromLayout(JSON.stringify({ grid: { root: {} } }))).toBeNull()
    expect(activePaneIdFromLayout(null)).toBeNull()
  })
})

describe('boot lazy', () => {
  it('sobem só plano + pane ativa + sem JSONL; o resto volta dormant sem resume', async () => {
    await useAppStore.getState().restoreWorkspace()

    expect(calls.resume.map((r) => r.ccSessionId).sort()).toEqual(['cc-active', 'cc-mother'])
    expect(calls.spawn).toBe(1)
    const panes = useAppStore.getState().panes
    expect(panes.map((p) => p.paneId).sort()).toEqual(
      ['pane-active', 'pane-mother', 'pane-nojsonl', 'pane-sleep1', 'pane-sleep2'].sort(),
    )
    const dormant = panes.filter((p) => p.dormant)
    expect(dormant.map((p) => [p.paneId, p.session.id, p.session.status])).toEqual([
      ['pane-sleep1', 'dormant:cc-sleep1', 'exited'],
      ['pane-sleep2', 'dormant:cc-sleep2', 'exited'],
    ])
    // O main recebe o espelho (cc + paneId), não o id sintético.
    expect(calls.dormantSync.at(-1)).toEqual([
      { ccSessionId: 'cc-sleep1', paneId: 'pane-sleep1', title: null, repoId: 'r1' },
      { ccSessionId: 'cc-sleep2', paneId: 'pane-sleep2', title: null, repoId: 'r1' },
    ])
  })

  it('persist inclui as dormant; reboot com o snapshot salvo mantém todas as abas', async () => {
    const snaps = bootSnaps.filter((s) => s.ccSessionId !== 'cc-nojsonl')
    await useAppStore.getState().restoreSnapshots(snaps, dockLayout)
    await waitPersist()

    const saved = calls.savePanes.at(-1)!
    expect(saved.map((s) => s.paneId).sort()).toEqual(snaps.map((s) => s.paneId).sort())
    expect(saved.find((s) => s.paneId === 'pane-sleep1')?.ccSessionId).toBe('cc-sleep1')

    // Reboot: o renderer começa vazio e restaura do que foi gravado.
    useAppStore.setState({ panes: [] })
    calls.resume = []
    await useAppStore.getState().restoreSnapshots(saved, dockLayout)

    expect(
      useAppStore
        .getState()
        .panes.map((p) => p.paneId)
        .sort(),
    ).toEqual(snaps.map((s) => s.paneId).sort())
    expect(calls.resume.map((r) => r.ccSessionId).sort()).toEqual(['cc-active', 'cc-mother'])
  })
})

describe('wakeDormantPane', () => {
  it('retoma no lugar: mesmo paneId, sem dormant, sessão nova', async () => {
    seedDormant('cc-sleep1', 'pane-sleep1')

    const id = await useAppStore.getState().wakeDormantPane('pane-sleep1')

    expect(id).toBe('sess-cc-sleep1')
    expect(calls.resume).toEqual([{ repoId: 'r1', ccSessionId: 'cc-sleep1' }])
    const [pane] = useAppStore.getState().panes
    expect(pane.paneId).toBe('pane-sleep1')
    expect(pane.dormant).toBeUndefined()
    expect(pane.session.id).toBe('sess-cc-sleep1')
    // Acordou: o espelho do main fica vazio.
    expect(calls.dormantSync.at(-1)).toEqual([])
  })

  it('pedido de wake do main → wakeResult com o id novo; sem pane → error', async () => {
    await useAppStore.getState().startLiveWatch()
    seedDormant('cc-sleep2', 'pane-sleep2')

    wakeHandler!({ requestId: 'req-1', ccSessionId: 'cc-sleep2' })
    await flush()
    await flush()
    wakeHandler!({ requestId: 'req-2', ccSessionId: 'cc-ninguem' })
    await flush()

    expect(calls.wakeResult).toEqual([
      { requestId: 'req-1', sessionId: 'sess-cc-sleep2' },
      { requestId: 'req-2', sessionId: null, error: 'no-dormant-pane' },
    ])
    expect(useAppStore.getState().panes[0].dormant).toBeUndefined()
    useAppStore.getState().stopLiveWatch()
  })
})

describe('um resume só por pane dormant', () => {
  it('resumir pelo switcher e depois focar a pane (ativação) = 1 resume', async () => {
    seedDormant('cc-sleep1', 'pane-sleep1')
    let open!: () => void
    resumeGate = new Promise((r) => (open = r))

    const fromSwitcher = useAppStore
      .getState()
      .resumeSession(repo as never, 'Infra', null, null, 'cc-sleep1')
    // O switcher pede foco; o dockview ativa a aba enquanto o resume voa.
    expect(useAppStore.getState().focusPaneId).toBe('pane-sleep1')
    wakeIfDormant('pane-sleep1')
    open()
    await fromSwitcher
    // Ativação de novo depois de acordada não retoma outra vez.
    wakeIfDormant('pane-sleep1')
    await flush()

    expect(calls.resume).toHaveLength(1)
    expect(useAppStore.getState().panes).toHaveLength(1)
    expect(useAppStore.getState().panes[0].paneId).toBe('pane-sleep1')
  })

  it('focusOrOpenSession de sessão com aba dormindo acorda essa aba, sem pane nova', async () => {
    seedDormant('cc-sleep1', 'pane-sleep1')

    await useAppStore.getState().focusOrOpenSession({
      id: 'sess-cc-sleep1',
      ccSessionId: 'cc-sleep1',
    } as never)

    expect(calls.resume).toHaveLength(1)
    expect(useAppStore.getState().panes.map((p) => p.paneId)).toEqual(['pane-sleep1'])
  })
})

describe('fechar/encerrar pane dormant', () => {
  it('só remove: nenhum IPC com o id sintético', async () => {
    seedDormant('cc-sleep1', 'pane-sleep1')
    useAppStore.getState().endSession('dormant:cc-sleep1')
    expect(useAppStore.getState().panes).toHaveLength(0)

    seedDormant('cc-sleep2', 'pane-sleep2')
    useAppStore.getState().closePane('pane-sleep2')
    expect(useAppStore.getState().panes).toHaveLength(0)
    await waitPersist()
    // afterEach confere que nenhum IPC levou 'dormant:'.
  })
})
