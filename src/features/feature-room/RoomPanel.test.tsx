import Database from 'better-sqlite3'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Painel da Room na visão de projeto, sobre o estado que os PRODUTORES escrevem:
// handoffStore em banco migrado, tela capturada do claude 2.1.286 (roomWorld →
// projectAttention → buildSessionGraph). Só window.api é dublê.
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp', getVersion: () => '0.0.0-test' },
  BrowserWindow: { getAllWindows: () => [] },
}))
let testDb: Database.Database
vi.mock('../../../electron/main/services/db', () => ({ getDb: () => testDb }))
vi.mock('@/features/sessions/Terminal', () => ({ Terminal: () => null }))
vi.mock('../../../electron/main/services/transcript-path', () => ({
  findTranscriptPath: () => null,
}))
vi.mock('../../../electron/main/services/session-activity', () => ({
  buildSessionsFileIndex: () => new Map(),
}))
vi.mock('../../../electron/main/services/live-session-states', () => ({
  liveSessionStates: () => new Map(),
}))

const api = vi.hoisted(() => ({
  attentionMenu: vi.fn(),
  attentionRespond: vi.fn(),
  send: vi.fn(),
  write: vi.fn(),
  watchTail: vi.fn(),
  unwatchTail: vi.fn(),
  watch: vi.fn(),
  subscribeTail: vi.fn(() => Promise.resolve()),
  tails: new Set<(t: unknown) => void>(),
}))
const special: Record<string, Record<string, unknown>> = {
  handoffs: { list: () => Promise.resolve(store.list()) },
  sessions: {
    attentionMenu: api.attentionMenu,
    attentionRespond: api.attentionRespond,
    write: api.write,
  },
  sendTo: { send: api.send, subscribeTail: api.subscribeTail },
  chat: {
    watch: api.watch,
    watchTail: api.watchTail,
    unwatchTail: api.unwatchTail,
    onTranscriptTail: (cb: (t: unknown) => void) => {
      api.tails.add(cb)
      return () => api.tails.delete(cb)
    },
  },
}
vi.stubGlobal(
  'window',
  Object.assign(window, {
    api: new Proxy(
      {},
      {
        get: (_t, ns: string) =>
          new Proxy(
            {},
            {
              get: (_n, m: string) =>
                special[ns]?.[m] ??
                (m.startsWith('on') ? () => () => {} : () => new Promise(() => {})),
            },
          ),
      },
    ),
  }),
)

// IntersectionObserver controlado: `hidden` diz quais tiles estão fora da tela.
const io = vi.hoisted(() => ({ hidden: new Set<string>(), observers: [] as unknown[] }))
class FakeIO {
  private cb: (e: Array<{ target: Element; isIntersecting: boolean }>) => void
  private els: Element[] = []
  constructor(cb: FakeIO['cb']) {
    this.cb = cb
    io.observers.push(this)
  }
  observe(el: Element) {
    this.els.push(el)
    this.flush()
  }
  flush() {
    this.cb(
      this.els.map((target) => ({
        target,
        isIntersecting: !io.hidden.has((target as HTMLElement).dataset.tile ?? ''),
      })),
    )
  }
  disconnect() {
    this.els = []
  }
  unobserve() {}
}
vi.stubGlobal('IntersectionObserver', FakeIO)

const store = await import('../../../electron/main/services/handoff-store')
const harness = await import('../../../electron/main/services/attention/attention-test-harness')
const { roomWorld } = await import('../../../electron/main/services/attention/room-world')
const { countAttentionSubjects, humanQueue } = await import('../../../shared/attention/selectors')
const { RoomPanel } = await import('./RoomPanel')
const {
  useRoomPanelStore,
  ROOM_PANEL_DEFAULT,
  ROOM_PANEL_COMPACT,
  DOCKVIEW_HOST_ID,
  DOCKVIEW_MIN_WITH_PANEL,
} = await import('./room-panel-store')
const { useMotherPins } = await import('./mother-pins-store')
const { useCrewDockStore } = await import('@/features/handoffs/crew-dock-store')
const { useProjectsViewStore } = await import('@/features/session-canvas/projects-view-store')
const { useSessionGraphStore } = await import('@/features/sessions/session-graph-store')
const { useAttentionListStore } = await import('@/store/attentionStore')
const { useHandoffsStore } = await import('@/store/handoffsStore')
const { useAppStore } = await import('@/store/appStore')

type WorldLive = import('../../../electron/main/services/attention/room-world').WorldLive

// Lume (F1, com filha), Nori (F1), Sora (F2) e uma sessão avulsa sem feature e
// sem filhas: todas abertas pelo humano, todas mães. A filha da Lume não é.
function seed(): void {
  harness.seedFeature(testDb, 'F1')
  harness.seedFeature(testDb, 'F2')
  harness.seedSession(testDb, 'lume', { repoId: 'r1', featureId: 'F1' })
  harness.seedSession(testDb, 'nori', { repoId: 'r2', featureId: 'F1' })
  harness.seedSession(testDb, 'sora', { repoId: 'r3', featureId: 'F2' })
  harness.seedSession(testDb, 'lume-kid', { repoId: 'r4', featureId: 'F1' })
  harness.seedSession(testDb, 'avulsa', { repoId: 'r5', featureId: null })
  const h = store.create({
    motherSessionId: 'lume',
    targetRepoId: 'r4',
    featureId: 'F1',
    task: 'task lume-kid',
    composedPrompt: 'p',
  })
  store.markRunning(h.id, 'lume-kid')
}

const BASE = ['lume', 'nori', 'sora', 'lume-kid', 'avulsa']
const lives = (ids: string[], over: Record<string, Partial<WorldLive>> = {}): WorldLive[] =>
  ids.map((id) => ({ id, status: 'idle', ...over[id] }))

// O AppShell monta o painel só com ele aberto, na área projects.
function Host() {
  const open = useRoomPanelStore((s) => s.open)
  const area = useAppStore((s) => s.area)
  return area === 'projects' && open ? <RoomPanel /> : null
}

function mount(ls: WorldLive[]) {
  const w = roomWorld(testDb, ls)
  useSessionGraphStore.setState({ graph: w.graph })
  useHandoffsStore.setState({ handoffs: w.handoffs, loading: false })
  useAttentionListStore.setState({ items: w.attention })
  useAppStore.setState({ area: 'projects', liveSessions: w.live, panes: [], focusPaneId: null })
  return { ...render(<Host />), world: w }
}

const tiles = () => screen.getAllByTestId('mother-tile')
const tileOf = (id: string) => tiles().find((t) => t.dataset.tile === id)!
// jsdom não tem PointerEvent: um MouseEvent com o tipo pointer* carrega o clientX.
const pointer = (el: Element, type: string, clientX: number) =>
  act(() => void el.dispatchEvent(new MouseEvent(type, { clientX, bubbles: true })))
const persisted = () => JSON.parse(localStorage.getItem('cm:room-panel') ?? 'null')

describe('RoomPanel', () => {
  let permission: Awaited<ReturnType<typeof harness.scanFixture>>

  beforeEach(async () => {
    testDb = new Database(':memory:')
    testDb.pragma('foreign_keys = ON')
    harness.applyAllMigrations(testDb)
    harness.seedRepos(testDb)
    io.hidden.clear()
    api.attentionMenu.mockReturnValue(new Promise(() => {}))
    localStorage.clear()
    useMotherPins.setState({ order: [] })
    useRoomPanelStore.setState({
      open: true,
      width: ROOM_PANEL_DEFAULT,
      featureFilter: null,
      focus: null,
      compact: false,
    })
    useCrewDockStore.setState({ collapsed: true })
    useProjectsViewStore.getState().setView('terminals')
    permission = await harness.scanFixture('permission-bash')
  })
  afterEach(() => testDb.close())

  it('mostra toda sessão raiz (inclusive a avulsa sem feature) e a contagem única', () => {
    seed()
    const { world } = mount(lives(BASE, { nori: { status: 'waiting', scan: permission } }))
    expect(new Set(tiles().map((t) => t.dataset.tile))).toEqual(
      new Set(['lume', 'nori', 'sora', 'avulsa']),
    )
    const needYou = humanQueue(world.attention)
    expect(Number(screen.getByTestId('room-panel-badge').textContent)).toBe(
      countAttentionSubjects(needYou),
    )
    expect(countAttentionSubjects(needYou)).toBe(1)
    // Aprovação inline no tile, sem abrir página.
    expect(within(tileOf('nori')).getByTestId('mother-tile-menu')).toBeInTheDocument()
  })

  it('clicar numa mãe sem pane abre a pane real dela e foca; de novo, reusa a mesma pane', () => {
    seed()
    mount(lives(BASE))
    fireEvent.click(within(tileOf('nori')).getByTestId('mother-tile-open'))
    const first = useAppStore.getState()
    expect(first.area).toBe('projects')
    const pane = first.panes.find((p) => p.session.id === 'nori')
    expect(pane).toBeDefined()
    expect(first.focusPaneId).toBe(pane!.paneId)

    act(() => useAppStore.setState({ focusPaneId: null }))
    // Clique no corpo do tile (fora dos controles) também foca.
    fireEvent.click(within(tileOf('nori')).getByTestId('mother-tile-tail'))
    const second = useAppStore.getState()
    expect(second.panes.filter((p) => p.session.id === 'nori')).toHaveLength(1)
    expect(second.focusPaneId).toBe(pane!.paneId)
  })

  it('com o mapa na frente, focar a mãe volta para os terminais', () => {
    seed()
    useProjectsViewStore.getState().setView('map')
    mount(lives(BASE))
    fireEvent.click(within(tileOf('sora')).getByTestId('mother-tile-open'))
    expect(useProjectsViewStore.getState().view).toBe('terminals')
    expect(useAppStore.getState().panes.some((p) => p.session.id === 'sora')).toBe(true)
  })

  it('recolher esconde o painel e persiste; a largura do arrasto persiste no pointerup', () => {
    seed()
    mount(lives(BASE))
    const handle = screen.getByTestId('room-panel-resize')
    pointer(handle, 'pointerdown', 1000)
    pointer(handle, 'pointermove', 900)
    expect(screen.getByTestId('room-panel').style.width).toBe(`${ROOM_PANEL_DEFAULT + 100}px`)
    expect(persisted()).toBeNull()
    pointer(handle, 'pointerup', 900)
    expect(persisted()).toEqual({ open: true, width: ROOM_PANEL_DEFAULT + 100 })

    fireEvent.click(screen.getByTestId('room-panel-collapse'))
    expect(screen.queryByTestId('room-panel')).toBeNull()
    expect(persisted()).toEqual({ open: false, width: ROOM_PANEL_DEFAULT + 100 })
  })

  // O host do dockview com a largura que o layout daria; o ResizeObserver é
  // controlado (jsdom não tem): `resize` reaplica a medição.
  function dockviewHost(width: { value: number }) {
    const host = document.createElement('div')
    host.id = DOCKVIEW_HOST_ID
    host.getBoundingClientRect = () => ({ width: width.value }) as DOMRect
    document.body.appendChild(host)
    const callbacks: Array<() => void> = []
    const g = globalThis as { ResizeObserver?: unknown }
    const original = g.ResizeObserver
    g.ResizeObserver = class {
      constructor(cb: () => void) {
        callbacks.push(cb)
      }
      observe() {}
      disconnect() {}
    }
    return {
      resize: (w: number) => {
        width.value = w
        act(() => callbacks.forEach((cb) => cb()))
      },
      remove: () => {
        host.remove()
        g.ResizeObserver = original
      },
    }
  }

  it('dockview estreito: recolhe para a faixa compacta (contagem + ícone por mãe) e volta ao alargar', () => {
    seed()
    const host = dockviewHost({ value: DOCKVIEW_MIN_WITH_PANEL - 1 })
    try {
      mount(lives(BASE, { nori: { status: 'waiting', scan: permission } }))
      const panel = screen.getByTestId('room-panel')
      expect(panel.dataset.compact).toBe('true')
      expect(panel.style.width).toBe(`${ROOM_PANEL_COMPACT}px`)
      expect(screen.queryAllByTestId('mother-tile')).toHaveLength(0)
      const icons = screen.getAllByTestId('room-panel-compact-mother')
      expect(new Set(icons.map((i) => i.dataset.tile))).toEqual(
        new Set(['lume', 'nori', 'sora', 'avulsa']),
      )
      expect(screen.getByTestId('room-panel-summary').textContent).toBe('4')
      expect(screen.getByTestId('room-panel-badge').textContent).toBe('1')

      fireEvent.click(icons.find((i) => i.dataset.tile === 'sora')!)
      const { panes, focusPaneId } = useAppStore.getState()
      expect(panes.find((p) => p.paneId === focusPaneId)?.session.id).toBe('sora')

      // Compacto, o dockview ganhou (largura - faixa): só volta se o painel cheio
      // ainda deixar o dockview acima do limiar — sem oscilar na fronteira.
      host.resize(DOCKVIEW_MIN_WITH_PANEL + ROOM_PANEL_DEFAULT - ROOM_PANEL_COMPACT - 1)
      expect(screen.getByTestId('room-panel').dataset.compact).toBe('true')
      host.resize(DOCKVIEW_MIN_WITH_PANEL + ROOM_PANEL_DEFAULT - ROOM_PANEL_COMPACT)
      expect(screen.getByTestId('room-panel').dataset.compact).toBeUndefined()
      expect(tiles()).toHaveLength(4)
    } finally {
      host.remove()
    }
  })

  it('pedido de foco numa feature filtra o painel e foca a pane da mãe principal (a com filhas)', () => {
    seed()
    mount(lives(BASE))
    act(() => useRoomPanelStore.getState().show({ featureId: 'F1' }))
    expect(new Set(tiles().map((t) => t.dataset.tile))).toEqual(new Set(['lume', 'nori']))
    const { panes, focusPaneId } = useAppStore.getState()
    expect(panes.find((p) => p.paneId === focusPaneId)?.session.id).toBe('lume')
    expect(useRoomPanelStore.getState().focus).toBeNull()
    fireEvent.click(screen.getByTestId('room-panel-filter-clear'))
    expect(tiles()).toHaveLength(4)
  })

  it('um painel à direita por vez: abrir a Room recolhe o Crew Dock; expandir o dock recolhe a Room', () => {
    seed()
    useCrewDockStore.setState({ collapsed: false })
    mount(lives(BASE))
    expect(useCrewDockStore.getState().collapsed).toBe(true)
    act(() => useCrewDockStore.getState().expand())
    expect(useRoomPanelStore.getState().open).toBe(false)
    expect(screen.queryByTestId('room-panel')).toBeNull()
  })
})
