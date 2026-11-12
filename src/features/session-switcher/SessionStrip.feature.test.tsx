import { fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LiveSessionInfo } from '../../../shared/types/ipc'

const navigateToFeature = vi.fn()
vi.mock('@/lib/nav', () => ({
  navigateToFeature: (id: string) => navigateToFeature(id),
  navigateToObjective: vi.fn(),
  navigateToTask: vi.fn(),
  navigateToProject: vi.fn(),
  navigateToDiagram: vi.fn(),
}))
vi.mock('@/lib/ipc', () => ({
  featuresApi: { get: vi.fn(), listWithStats: vi.fn().mockResolvedValue([]) },
  sessionsApi: { listByFeature: vi.fn().mockResolvedValue([]) },
  prefsApi: { get: vi.fn().mockResolvedValue(null), set: vi.fn() },
  sessionGraphApi: { onUpdated: () => () => {}, get: () => new Promise(() => {}) },
  motherPinsApi: {
    list: () => Promise.resolve([]),
    onUpdated: () => () => {},
    onRestart: () => () => {},
  },
}))

const sessions: LiveSessionInfo[] = []
// Vivas sem aba (filhas no dock): estão no snapshot do store, fora das visíveis.
const background: LiveSessionInfo[] = []
const openSession = vi.fn()
vi.mock('./useGlobalSessions', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useVisibleLiveSessions: () => sessions,
  useEndedSessions: () => null,
}))
vi.mock('./useWaitingCount', () => ({ useWaitingCount: () => 0 }))
// Pins têm persistência própria (prefs assíncronas) e nada a ver com a marca.
const pinnedIds: string[] = []
const togglePin = vi.fn()
vi.mock('./strip-pins-store', () => ({
  useStripPinsStore: (sel: (s: unknown) => unknown) =>
    sel({
      pinnedIds,
      loaded: true,
      load: vi.fn().mockResolvedValue(undefined),
      togglePin,
      prune: vi.fn().mockResolvedValue(undefined),
    }),
}))
vi.mock('@/store/appStore', () => ({
  pendingEndSessionIds: () => new Set<string>(),
  useAppStore: (sel: (s: unknown) => unknown) =>
    sel({
      liveSessions: background.length > 0 ? [...sessions, ...background] : sessions,
      panes: [],
      focusPaneId: vi.fn(),
      focusOrOpenSession: openSession,
    }),
}))
// O Encerrar da barra passa pelo pedido com confirmação (end-child), não direto
// pelo store.
const endSessionAsked = vi.fn()
vi.mock('@/features/handoffs/end-child', () => ({
  endSessionAsked: (sessionId: string) => endSessionAsked(sessionId),
}))

const { SessionStrip } = await import('./SessionStrip')
const { useSessionFeatureStore } = await import('@/store/sessionFeatureStore')
const { useSessionGraphStore } = await import('@/features/sessions/session-graph-store')
const { useMotherPinsStore } = await import('@/features/sessions/mother-pins-store')
const { useFocusFilterStore } = await import('@/lib/focus-filter-store')

function makeSession(over: Partial<LiveSessionInfo> = {}): LiveSessionInfo {
  return {
    id: 's-1',
    ccSessionId: 'cc-1',
    name: 'sessão viva',
    title: null,
    status: 'idle',
    lastActivityAt: Date.now(),
    repo: { id: 'r1', label: 'claude-manager', path: '/repo' },
    projectName: 'pitwall',
    projectIcon: null,
    projectColor: null,
    ...over,
  } as LiveSessionInfo
}

beforeAll(() => {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
})

beforeEach(() => {
  navigateToFeature.mockClear()
  openSession.mockClear()
  togglePin.mockClear()
  sessions.length = 0
  background.length = 0
  pinnedIds.length = 0
  useSessionFeatureStore.setState({
    bySessionId: { 's-1': 'f-42' },
    featureTitles: { 'f-42': 'Extração TRF4' },
    hydrated: true,
    hydrate: vi.fn().mockResolvedValue(undefined),
  })
})

describe('SessionStrip — marca da feature', () => {
  it('mostra a marca da sessão vinculada e navega sem focar a sessão', () => {
    sessions.push(makeSession())
    render(<SessionStrip onOpenSwitcher={() => {}} />)

    const chip = screen.getByTestId('session-feature-chip')
    fireEvent.mouseDown(chip)
    fireEvent.click(chip)

    expect(navigateToFeature).toHaveBeenCalledWith('f-42')
    expect(openSession).not.toHaveBeenCalled()
  })

  it('sessão sem feature não ganha marca', () => {
    sessions.push(makeSession({ id: 's-solta' }))
    render(<SessionStrip onOpenSwitcher={() => {}} />)
    expect(screen.queryByTestId('session-feature-chip')).not.toBeInTheDocument()
  })
})

function node(sessionId: string, over: Record<string, unknown> = {}) {
  return { sessionId, ccSessionId: `cc-${sessionId}`, hierarchyMotherId: null, ...over }
}

describe('SessionStrip — mães e filhas', () => {
  it('filha logo depois da mãe, recuada; mãe marcada abre a seção "Mães"', () => {
    sessions.push(
      makeSession({ id: 'filha', ccSessionId: 'cc-filha', name: 'filha' }),
      makeSession({ id: 'outra', ccSessionId: 'cc-outra', name: 'outra' }),
      makeSession({ id: 'mae', ccSessionId: 'cc-mae', name: 'mae' }),
    )
    useSessionGraphStore.setState({
      graph: {
        nodes: [node('mae'), node('outra'), node('filha', { hierarchyMotherId: 'mae' })] as never,
        lanes: [],
        edges: [],
      },
    })
    useMotherPinsStore.setState({ keys: ['cc-mae'], loaded: true })
    // Todas as sessões: com o filtro "Mães + quem precisa de mim" a filha quieta sai.
    useFocusFilterStore.setState({ enabled: false, loaded: true, load: async () => {} } as never)
    render(<SessionStrip onOpenSwitcher={() => {}} />)
    const chips = [...document.querySelectorAll<HTMLElement>('[data-strip-chip]')]
    expect(chips.map((c) => c.textContent?.match(/mae|filha|outra/)?.[0])).toEqual([
      'mae',
      'filha',
      'outra',
    ])
    expect(chips[1].dataset.depth).toBe('1')
    expect(chips[0].dataset.pinnedMother).toBe('true')
    expect(screen.getByTestId('strip-mothers-section')).toHaveTextContent('Mães')
  })
})

describe('SessionStrip — filhas em segundo plano', () => {
  const named = (id: string, over: Partial<LiveSessionInfo> = {}) =>
    makeSession({ id, ccSessionId: `cc-${id}`, name: id, ...over })

  function setup(nodes: ReturnType<typeof node>[], focusOnly: boolean) {
    useSessionGraphStore.setState({ graph: { nodes: nodes as never, lanes: [], edges: [] } })
    useMotherPinsStore.setState({ keys: [], loaded: true })
    useFocusFilterStore.setState({
      enabled: focusOnly,
      loaded: true,
      load: async () => {},
    } as never)
    render(<SessionStrip onOpenSwitcher={() => {}} />)
  }
  const barOrder = () =>
    [
      ...document.querySelectorAll<HTMLElement>(
        '[data-strip-chip], [data-testid="strip-background-children"]',
      ),
    ].map((c) => c.textContent?.match(/mae|outra|com-aba|2º plano/)?.[0])

  it('chip agregado logo depois da mãe; o item do menu abre a aba da filha', () => {
    sessions.push(named('mae'), named('outra'))
    background.push(named('helena-auth', { status: 'waiting' }))
    setup([node('mae'), node('outra'), node('helena-auth', { hierarchyMotherId: 'mae' })], false)

    const chip = screen.getByTestId('strip-background-children')
    expect(chip).toHaveTextContent('↳ 1 em 2º plano')
    expect(chip.dataset.waiting).toBe('true')
    expect(barOrder()).toEqual(['mae', '2º plano', 'outra'])

    fireEvent.click(chip)
    fireEvent.click(screen.getByText('helena-auth · aguardando você'))
    expect(openSession).toHaveBeenCalledWith(background[0])
  })

  it('filtro de foco ligado: o chip conta só as sem aba, o "+N" só as com aba', () => {
    sessions.push(named('mae'), named('com-aba'))
    background.push(named('helena-auth'))
    setup(
      [
        node('mae'),
        node('com-aba', { hierarchyMotherId: 'mae' }),
        node('helena-auth', { hierarchyMotherId: 'mae' }),
      ],
      true,
    )

    expect(barOrder()).toEqual(['mae', '2º plano'])
    const chip = screen.getByTestId('strip-background-children')
    expect(chip).toHaveTextContent('↳ 1 em 2º plano')
    expect(chip.dataset.waiting).toBeUndefined()
    expect(screen.getByTestId('session-strip-focus-toggle')).toHaveTextContent('+1')
  })

  it('mãe fora da barra: o grupo fica no fim, mesmo sem nenhuma aba', () => {
    background.push(named('helena-auth'))
    setup([node('helena-auth', { hierarchyMotherId: 'mae' })], false)

    expect(screen.getByTestId('strip-background-children')).toHaveTextContent('↳ 1 em 2º plano')
    expect(screen.queryByText(/Nenhuma sessão viva/)).not.toBeInTheDocument()
  })

  it('sem filha em segundo plano não há chip', () => {
    sessions.push(named('mae'))
    setup([node('mae')], false)
    expect(screen.queryByTestId('strip-background-children')).not.toBeInTheDocument()
  })

  // jsdom não tem layout: a barra mede pelos retângulos [left, right] dados aqui,
  // na ordem do DOM (chips de sessão e chips agregados).
  function stubRects(rects: {
    bar: [number, number]
    chips: [number, number][]
    background: [number, number][]
  }) {
    const spy = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(function (this: HTMLElement) {
        const at = (list: [number, number][], selector: string) =>
          list[[...document.querySelectorAll(selector)].indexOf(this)]
        const [left, right] =
          this.dataset.testid === 'session-strip-scroll'
            ? rects.bar
            : (at(rects.chips, '[data-strip-chip]') ??
              at(rects.background, '[data-testid="strip-background-children"]') ?? [0, 0])
        return { left, right, width: right - left } as DOMRect
      })
    return () => spy.mockRestore()
  }

  describe('barra transbordando', () => {
    let restore = () => {}
    afterEach(() => restore())

    it('mãe cortada some inteira: o chip agregado some junto', () => {
      restore = stubRects({
        bar: [100, 600],
        chips: [
          [60, 150],
          [260, 380],
        ],
        background: [[154, 250]],
      })
      sessions.push(named('mae'), named('outra'))
      background.push(named('helena-auth'))
      setup([node('mae'), node('outra'), node('helena-auth', { hierarchyMotherId: 'mae' })], false)

      const [mae] = document.querySelectorAll<HTMLElement>('[data-strip-chip]')
      expect(mae.dataset.clippedHidden).toBe('true')
      const chip = screen.getByTestId('strip-background-children')
      expect(chip.dataset.clippedHidden).toBe('true')
      expect(chip).not.toBeVisible()
      // A mãe e a filha que sumiu com o chip agregado.
      expect(screen.getByTestId('session-strip-more')).toHaveTextContent('+2')
    })

    // `visibility: visible` num descendente vence o `hidden` herdado do chip: com
    // o ponteiro parado em cima na hora do corte, a faixa de ações (Encerrar
    // inclusive) reaparecia solta e clicável, de uma sessão que não está à vista.
    it('chip cortado não revela as ações do hover', () => {
      restore = stubRects({
        bar: [100, 600],
        chips: [
          [60, 150],
          [260, 380],
        ],
        background: [],
      })
      sessions.push(named('mae'), named('outra'))
      setup([node('mae'), node('outra')], false)

      const [cut, shown] = [...document.querySelectorAll<HTMLElement>('[data-strip-chip]')].map(
        (chip) => ({
          chip,
          classes: chip
            .querySelector<HTMLElement>('[data-testid="strip-chip-actions"]')!
            .className.split(/\s+/),
        }),
      )
      expect(cut.chip.dataset.clippedHidden).toBe('true')
      expect(cut.classes).toContain('invisible')
      expect(cut.classes).not.toContain('group-hover:visible')
      expect(cut.classes).not.toContain('group-focus-within:visible')

      expect(shown.chip.dataset.clippedHidden).toBeUndefined()
      expect(shown.classes).toContain('group-hover:visible')
      expect(shown.classes).toContain('group-focus-within:visible')
    })

    it('mãe cortada some, mas o chip agregado com filha aguardando fica', () => {
      restore = stubRects({
        bar: [100, 600],
        chips: [
          [60, 150],
          [260, 380],
        ],
        background: [[154, 250]],
      })
      sessions.push(named('mae'), named('outra'))
      background.push(named('helena-auth', { status: 'waiting' }))
      setup([node('mae'), node('outra'), node('helena-auth', { hierarchyMotherId: 'mae' })], false)

      const chip = screen.getByTestId('strip-background-children')
      expect(chip.dataset.clippedHidden).toBeUndefined()
      expect(chip).toBeVisible()
      // Só a mãe: a filha continua à vista no chip agregado.
      expect(screen.getByTestId('session-strip-more')).toHaveTextContent('+1')
    })

    it('chip agregado cortado com a mãe inteira na barra: as filhas entram no "+N"', () => {
      restore = stubRects({ bar: [0, 500], chips: [[300, 420]], background: [[424, 520]] })
      sessions.push(named('mae'))
      background.push(named('helena-auth'), named('caio-db'))
      setup(
        [
          node('mae'),
          node('helena-auth', { hierarchyMotherId: 'mae' }),
          node('caio-db', { hierarchyMotherId: 'mae' }),
        ],
        false,
      )

      expect(screen.getByTestId('session-strip-more')).toHaveTextContent('+2')
    })
  })
})

describe('SessionStrip — clique no chip', () => {
  function renderShortChip() {
    sessions.push(makeSession({ id: 's-curta', ccSessionId: 'cc-curta', name: 'pw' }))
    useSessionGraphStore.setState({ graph: { nodes: [], lanes: [], edges: [] } })
    useMotherPinsStore.setState({ keys: [], loaded: true })
    useFocusFilterStore.setState({ enabled: false, loaded: true, load: async () => {} } as never)
    render(<SessionStrip onOpenSwitcher={() => {}} />)
    const chip = document.querySelector<HTMLElement>('[data-strip-chip]')!
    const actions = screen.getByLabelText('Encerrar o processo desta sessão').parentElement!
    return { chip, actions }
  }

  // Nome curto: com o ponteiro em cima, as ações do hover cobriam o nome inteiro
  // e o clique entre os ícones delas não chegava ao botão.
  it('clique fora dos botões de ação abre a sessão, uma vez só', () => {
    const { chip, actions } = renderShortChip()

    for (const target of [actions, chip, screen.getByText('pw')]) {
      openSession.mockClear()
      fireEvent.click(target)
      expect(openSession).toHaveBeenCalledTimes(1)
      expect(openSession).toHaveBeenCalledWith(sessions[0])
    }
  })

  it('botão de ação não abre a sessão', () => {
    renderShortChip()

    fireEvent.click(screen.getByLabelText('Encerrar o processo desta sessão'))
    fireEvent.click(screen.getByLabelText('Fixar no início da barra'))
    expect(openSession).not.toHaveBeenCalled()
    expect(endSessionAsked).toHaveBeenCalledWith('s-curta')
  })

  // jsdom não tem layout. O que dá para travar é o contrato de CSS que faz o chip
  // reservar o próprio começo: as ações ficam em fluxo e com largura mesmo
  // invisíveis, na mesma célula de grid do conteúdo, afastadas da ponta esquerda.
  it('as ações do hover reservam lugar no chip em vez de flutuar sobre ele', () => {
    const { chip, actions } = renderShortChip()

    const classes = actions.className.split(/\s+/)
    expect(chip.className.split(/\s+/)).toContain('grid')
    expect(classes).toContain('invisible')
    expect(classes).not.toContain('absolute')
    expect(classes).not.toContain('hidden')
    expect(parseFloat(actions.style.marginLeft)).toBeGreaterThan(0)
  })
})

describe('SessionStrip — chip fixado', () => {
  // O indicador de fixado dividia a célula do grid com as ações do hover, que
  // ficam por cima: o ponteiro indo desafixar acertava "Marcar como mãe" (nome
  // curto) ou "Encerrar" (nome longo). jsdom não tem layout: o que dá para travar
  // é o indicador numa coluna só dele e a faixa de ações contida na dela.
  it('o indicador de fixado fica fora da célula das ações do hover', () => {
    sessions.push(
      makeSession({ id: 's-fixa', ccSessionId: 'cc-fixa', name: 'pw' }),
      makeSession({ id: 's-solta', ccSessionId: 'cc-solta', name: 'px' }),
    )
    pinnedIds.push('s-fixa')
    useSessionGraphStore.setState({ graph: { nodes: [], lanes: [], edges: [] } })
    useMotherPinsStore.setState({ keys: [], loaded: true })
    useFocusFilterStore.setState({ enabled: false, loaded: true, load: async () => {} } as never)
    render(<SessionStrip onOpenSwitcher={() => {}} />)

    const [pinned, loose] = [...document.querySelectorAll<HTMLElement>('[data-strip-chip]')].map(
      (chip) => ({ chip, actions: within(chip).getByTestId('strip-chip-actions') }),
    )
    const unpin = within(pinned.chip).getByLabelText('Desafixar do início da barra')
    const unpinCell = [...pinned.chip.children].find((child) => child.contains(unpin))!
    const pinnedClasses = pinned.actions.className.split(/\s+/)

    expect(pinned.actions).not.toContainElement(unpin)
    expect(within(pinned.chip).queryByLabelText('Fixar no início da barra')).not.toBeInTheDocument()
    expect(unpinCell.className.split(/\s+/)).toContain('col-start-2')
    expect(pinnedClasses).toContain('col-start-1')
    // Sem margem negativa a faixa termina na própria coluna, antes do indicador.
    expect(pinnedClasses.filter((name) => name.startsWith('-mr-'))).toEqual([])

    // Sem fixar, a faixa segue até a borda do chip e leva o botão de fixar.
    expect(loose.actions.className.split(/\s+/)).toContain('-mr-2.5')
    expect(within(loose.actions).getByLabelText('Fixar no início da barra')).toBeInTheDocument()

    fireEvent.click(unpin)
    expect(togglePin).toHaveBeenCalledWith('s-fixa')
    expect(openSession).not.toHaveBeenCalled()
  })
})
