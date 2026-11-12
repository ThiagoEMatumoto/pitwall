import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Os stores importam @/lib/ipc, que lê window.api no module-eval.
const killSpy = vi.fn(() => Promise.resolve())
const setChildEndedSpy = vi.fn((_input: { sessionId: string; ended: boolean }) =>
  Promise.resolve(null),
)
// O status que o main devolve no clique. Vazio = a sessão não veio na resposta.
const listLiveGlobalSpy = vi.fn((): Promise<unknown[]> => Promise.resolve([]))
const spies: Record<string, (...args: never[]) => unknown> = {
  kill: killSpy,
  setChildEnded: setChildEndedSpy,
  listLiveGlobal: listLiveGlobalSpy,
}
Object.assign(window, {
  api: new Proxy(
    {},
    {
      get: () =>
        new Proxy({}, { get: (_t, prop) => spies[prop as string] ?? (() => Promise.resolve()) }),
    },
  ),
})

const { useAppStore } = await import('@/store/appStore')
const { useToastStore } = await import('@/features/notifications/toast-store')
const { useSessionGraphStore } = await import('@/features/sessions/session-graph-store')
const { closeChildTab, confirmEndChild, endSessionAsked, isLinkedChild } =
  await import('./end-child')
type ActivePane = import('@/store/appStore').ActivePane
type Session = import('../../../shared/types/ipc').Session
type LiveSessionInfo = import('../../../shared/types/ipc').LiveSessionInfo
type SessionGraphNode = import('../../../shared/types/session-graph').SessionGraphNode

function makePane(sessionId: string, over: Partial<ActivePane> = {}): ActivePane {
  return {
    paneId: `pane-${sessionId}`,
    session: { id: sessionId, ccSessionId: `cc-${sessionId}`, title: null } as unknown as Session,
    repo: null,
    projectName: null,
    projectIcon: null,
    projectColor: null,
    mode: 'terminal',
    ...over,
  }
}

function makeLive(sessionId: string, status: LiveSessionInfo['status']): LiveSessionInfo {
  return { id: sessionId, ccSessionId: `cc-${sessionId}`, status } as unknown as LiveSessionInfo
}

// "É filha" é o hierarchyMotherId do grafo (escrito no main por session-graph.ts,
// a partir de readHierarchyLinks): os dois campos que a régua do renderer lê.
function linkAsChild(childSessionId: string, motherSessionId: string): void {
  useSessionGraphStore.setState({
    graph: {
      nodes: [
        { sessionId: childSessionId, hierarchyMotherId: motherSessionId },
        { sessionId: motherSessionId, hierarchyMotherId: null },
      ] as unknown as SessionGraphNode[],
      lanes: [],
      edges: [],
    },
  })
}

function seed(sessionId: string, status: LiveSessionInfo['status']): void {
  useAppStore.setState({
    panes: [makePane(sessionId)],
    liveSessions: [makeLive(sessionId, status)],
  })
}

// O Encerrar da filha espera o main responder antes de decidir a pergunta.
const mainAnswered = () => vi.advanceTimersByTimeAsync(0)

let confirmSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  vi.useFakeTimers()
  killSpy.mockClear()
  setChildEndedSpy.mockClear()
  listLiveGlobalSpy.mockReset()
  listLiveGlobalSpy.mockImplementation(() => Promise.resolve([]))
  confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
  useAppStore.setState({ panes: [], liveSessions: [] })
  useToastStore.setState({ toasts: [] })
  useSessionGraphStore.setState({ graph: { nodes: [], lanes: [], edges: [] } })
})

afterEach(() => {
  vi.runAllTimers()
  vi.useRealTimers()
  confirmSpy.mockRestore()
})

describe('confirmEndChild', () => {
  it.each(['working', 'starting'] as const)(
    'filha %s: pergunta e respeita a resposta',
    (status) => {
      const ask = vi.fn(() => false)
      expect(confirmEndChild(makeLive('f', status), true, ask)).toBe(false)
      expect(ask).toHaveBeenCalledTimes(1)
      expect(confirmEndChild(makeLive('f', status), true, () => true)).toBe(true)
    },
  )

  it.each(['idle', 'waiting', 'ended'] as const)('filha %s: encerra sem perguntar', (status) => {
    const ask = vi.fn(() => false)
    expect(confirmEndChild(makeLive('f', status), true, ask)).toBe(true)
    expect(ask).not.toHaveBeenCalled()
  })

  it('sessão comum trabalhando e filha sem status vivo: sem pergunta', () => {
    const ask = vi.fn(() => false)
    expect(confirmEndChild(makeLive('s', 'working'), false, ask)).toBe(true)
    expect(confirmEndChild(null, true, ask)).toBe(true)
    expect(ask).not.toHaveBeenCalled()
  })
})

describe('isLinkedChild', () => {
  it('segue o grafo: filha sim; mãe e sessão fora do grafo não', () => {
    linkAsChild('filha', 'mae')
    expect(isLinkedChild('filha')).toBe(true)
    expect(isLinkedChild('mae')).toBe(false)
    expect(isLinkedChild('outra')).toBe(false)
  })
})

describe('endSessionAsked', () => {
  it('filha trabalhando e o usuário recusa: nada acontece', async () => {
    linkAsChild('filha', 'mae')
    seed('filha', 'working')
    confirmSpy.mockReturnValue(false)

    endSessionAsked('filha')
    await mainAnswered()

    expect(confirmSpy).toHaveBeenCalledTimes(1)
    expect(useAppStore.getState().panes).toHaveLength(1)
    expect(useToastStore.getState().toasts).toHaveLength(0)
    expect(setChildEndedSpy).not.toHaveBeenCalled()
    vi.runAllTimers()
    expect(killSpy).not.toHaveBeenCalled()
  })

  it('filha trabalhando e o usuário confirma: encerra com Desfazer e marca', async () => {
    linkAsChild('filha', 'mae')
    seed('filha', 'working')

    endSessionAsked('filha')
    await mainAnswered()

    expect(confirmSpy).toHaveBeenCalledTimes(1)
    expect(useAppStore.getState().panes).toHaveLength(0)
    expect(useToastStore.getState().toasts[0]).toMatchObject({
      title: 'Filha encerrada · segue vinculada à mãe',
      actionLabel: 'Desfazer',
    })
    expect(setChildEndedSpy).toHaveBeenCalledWith({ sessionId: 'filha', ended: true })
  })

  it('sessão comum trabalhando: encerra sem perguntar, com o toast de sempre', () => {
    seed('comum', 'working')

    endSessionAsked('comum')

    expect(confirmSpy).not.toHaveBeenCalled()
    expect(listLiveGlobalSpy).not.toHaveBeenCalled()
    expect(useToastStore.getState().toasts[0]?.title).toBe('Sessão encerrada')
  })

  it('renderer diz idle e o main diz working: pergunta', async () => {
    linkAsChild('filha', 'mae')
    seed('filha', 'idle')
    listLiveGlobalSpy.mockImplementation(() => Promise.resolve([makeLive('filha', 'working')]))
    confirmSpy.mockReturnValue(false)

    endSessionAsked('filha')
    await mainAnswered()

    expect(confirmSpy).toHaveBeenCalledTimes(1)
    expect(useAppStore.getState().panes).toHaveLength(1)
    expect(setChildEndedSpy).not.toHaveBeenCalled()
  })

  it('renderer diz working e o main diz idle: encerra sem perguntar', async () => {
    linkAsChild('filha', 'mae')
    seed('filha', 'working')
    listLiveGlobalSpy.mockImplementation(() => Promise.resolve([makeLive('filha', 'idle')]))

    endSessionAsked('filha')
    await mainAnswered()

    expect(confirmSpy).not.toHaveBeenCalled()
    expect(useAppStore.getState().panes).toHaveLength(0)
    expect(setChildEndedSpy).toHaveBeenCalledWith({ sessionId: 'filha', ended: true })
  })

  it.each(['working', 'idle'] as const)(
    'o main não responde (IPC rejeita): decide pelo renderer (%s)',
    async (status) => {
      linkAsChild('filha', 'mae')
      seed('filha', status)
      listLiveGlobalSpy.mockImplementation(() => Promise.reject(new Error('ipc')))

      endSessionAsked('filha')
      await mainAnswered()

      expect(confirmSpy).toHaveBeenCalledTimes(status === 'working' ? 1 : 0)
      expect(setChildEndedSpy).toHaveBeenCalledWith({ sessionId: 'filha', ended: true })
    },
  )

  it.each(['working', 'idle'] as const)(
    'a sessão não vem na resposta do main: decide pelo renderer (%s)',
    async (status) => {
      linkAsChild('filha', 'mae')
      seed('filha', status)
      listLiveGlobalSpy.mockImplementation(() =>
        Promise.resolve([makeLive('outra', status === 'working' ? 'idle' : 'working')]),
      )

      endSessionAsked('filha')
      await mainAnswered()

      expect(confirmSpy).toHaveBeenCalledTimes(status === 'working' ? 1 : 0)
      expect(setChildEndedSpy).toHaveBeenCalledWith({ sessionId: 'filha', ended: true })
    },
  )

  it('dois cliques com a consulta em voo: uma pergunta e um encerramento', async () => {
    linkAsChild('filha', 'mae')
    seed('filha', 'idle')
    const answers: Array<(list: unknown[]) => void> = []
    listLiveGlobalSpy.mockImplementation(
      () => new Promise<unknown[]>((resolve) => answers.push(resolve)),
    )

    endSessionAsked('filha')
    endSessionAsked('filha')
    for (const answer of answers) answer([makeLive('filha', 'working')])
    await mainAnswered()

    expect(listLiveGlobalSpy).toHaveBeenCalledTimes(1)
    expect(confirmSpy).toHaveBeenCalledTimes(1)
    expect(setChildEndedSpy).toHaveBeenCalledTimes(1)
    expect(useToastStore.getState().toasts).toHaveLength(1)
  })

  it.each(['responde', 'rejeita'] as const)(
    'clique depois que o main %s e o usuário recusa: pergunta de novo',
    async (outcome) => {
      linkAsChild('filha', 'mae')
      seed('filha', 'working')
      listLiveGlobalSpy.mockImplementation(() =>
        outcome === 'responde'
          ? Promise.resolve([makeLive('filha', 'working')])
          : Promise.reject(new Error('ipc')),
      )
      confirmSpy.mockReturnValue(false)

      endSessionAsked('filha')
      await mainAnswered()
      endSessionAsked('filha')
      await mainAnswered()

      expect(confirmSpy).toHaveBeenCalledTimes(2)
      expect(setChildEndedSpy).not.toHaveBeenCalled()
    },
  )
})

describe('closeChildTab (X da aba de uma filha)', () => {
  it('filha viva: encerra de verdade (kill depois da janela), não só fecha a aba', async () => {
    linkAsChild('filha', 'mae')
    seed('filha', 'idle')

    closeChildTab('pane-filha')
    await mainAnswered()

    expect(useAppStore.getState().panes).toHaveLength(0)
    expect(useToastStore.getState().toasts[0]?.title).toBe(
      'Filha encerrada · segue vinculada à mãe',
    )
    vi.runAllTimers()
    expect(killSpy).toHaveBeenCalledWith('filha')
  })

  it('aba dormindo não tem processo: fecha a aba, sem kill e sem marca', () => {
    linkAsChild('filha', 'mae')
    useAppStore.setState({ panes: [makePane('filha', { dormant: true })], liveSessions: [] })

    closeChildTab('pane-filha')

    expect(useAppStore.getState().panes).toHaveLength(0)
    expect(useToastStore.getState().toasts[0]?.title).toBe('Aba fechada')
    expect(setChildEndedSpy).not.toHaveBeenCalled()
    vi.runAllTimers()
    expect(killSpy).not.toHaveBeenCalled()
  })
})
