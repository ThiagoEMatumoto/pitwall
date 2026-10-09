import Database from 'better-sqlite3'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Nível "Todas as mães" sobre o estado que os PRODUTORES escrevem: handoffStore em
// banco migrado, tela capturada do claude 2.1.286 (roomWorld → projectAttention →
// buildSessionGraph). Só window.api é dublê.
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
const { menuFingerprint } = await import('../../../shared/tui/tui-menu-parser')
const { countAttentionSubjects, humanQueue } = await import('../../../shared/attention/selectors')
const { FeatureRoom } = await import('./FeatureRoom')
const { MAX_LIVE_TILES } = await import('./AllMothers')
const { useFeatureRoomStore } = await import('./feature-room-store')
const { useMotherPins } = await import('./mother-pins-store')
const { useSessionGraphStore } = await import('@/features/sessions/session-graph-store')
const { useAttentionListStore } = await import('@/store/attentionStore')
const { useHandoffsStore } = await import('@/store/handoffsStore')
const { useAppStore } = await import('@/store/appStore')

type WorldLive = import('../../../electron/main/services/attention/room-world').WorldLive
type RoomWorld = import('../../../electron/main/services/attention/room-world').RoomWorld

// O cenário da Task 8: Lume (F1, 1 filha), Nori (F1), Sora (F2), uma sessão de topo
// sem feature com filha (Solo) e uma avulsa sem filha (fica de fora).
function seed(): void {
  harness.seedFeature(testDb, 'F1')
  harness.seedFeature(testDb, 'F2')
  harness.seedSession(testDb, 'lume', { repoId: 'r1', featureId: 'F1' })
  harness.seedSession(testDb, 'nori', { repoId: 'r2', featureId: 'F1' })
  harness.seedSession(testDb, 'sora', { repoId: 'r3', featureId: 'F2' })
  harness.seedSession(testDb, 'lume-kid', { repoId: 'r4', featureId: 'F1' })
  harness.seedSession(testDb, 'solo', { repoId: 'r1', featureId: null })
  harness.seedSession(testDb, 'solo-kid', { repoId: 'r6', featureId: null })
  harness.seedSession(testDb, 'avulsa', { repoId: 'r5', featureId: null })
  for (const [mother, kid, repo, feature] of [
    ['lume', 'lume-kid', 'r4', 'F1'],
    ['solo', 'solo-kid', 'r6', null],
  ] as const) {
    const h = store.create({
      motherSessionId: mother,
      targetRepoId: repo,
      featureId: feature,
      task: `task ${kid}`,
      composedPrompt: 'p',
    })
    store.markRunning(h.id, kid)
  }
}

const BASE = ['lume', 'nori', 'sora', 'lume-kid', 'solo', 'solo-kid', 'avulsa']

function apply(w: RoomWorld) {
  act(() => {
    useSessionGraphStore.setState({ graph: w.graph })
    useHandoffsStore.setState({ handoffs: w.handoffs, loading: false })
    useAttentionListStore.setState({ items: w.attention })
    useAppStore.setState({ liveSessions: w.live })
  })
}

function mount(lives: WorldLive[]) {
  const w = roomWorld(testDb, lives)
  useSessionGraphStore.setState({ graph: w.graph })
  useHandoffsStore.setState({ handoffs: w.handoffs, loading: false })
  useAttentionListStore.setState({ items: w.attention })
  useAppStore.setState({ area: 'room', liveSessions: w.live })
  useFeatureRoomStore.setState({
    level: 'all',
    featureId: null,
    timelineFilter: null,
    openId: null,
    selectedMotherId: {},
    pendingMother: null,
  })
  return { ...render(<FeatureRoom />), world: w }
}

const lives = (ids: string[], over: Record<string, Partial<WorldLive>> = {}): WorldLive[] =>
  ids.map((id) => ({ id, status: 'idle', ...over[id] }))
const tiles = () => screen.getAllByTestId('mother-tile')
const tileOf = (id: string) => tiles().find((t) => t.dataset.tile === id)!
const tileNum = (el: HTMLElement, testId: string) =>
  Number(within(el).getByTestId(testId).textContent!.match(/\d+/)![0])
const badge = () => Number(screen.getByTestId('all-mothers-badge').textContent)
const watchedTails = () => new Set(api.watchTail.mock.calls.map((c) => c[0] as string))

describe('AllMothers', () => {
  let permission: Awaited<ReturnType<typeof harness.scanFixture>>

  beforeEach(async () => {
    testDb = new Database(':memory:')
    testDb.pragma('foreign_keys = ON')
    harness.applyAllMigrations(testDb)
    harness.seedRepos(testDb)
    for (const fn of Object.values(api))
      if (typeof fn === 'function' && 'mockReset' in fn) fn.mockReset()
    api.subscribeTail.mockImplementation(() => Promise.resolve())
    api.attentionMenu.mockImplementation(() => new Promise(() => {}))
    api.tails.clear()
    io.hidden.clear()
    localStorage.clear()
    useMotherPins.setState({ order: [] })
    permission = await harness.scanFixture('permission-bash')
  })
  afterEach(() => testDb.close())

  it('5 tiles (a avulsa sem feature também é mãe); o badge é a soma dos pedidos dos tiles', () => {
    seed()
    store.ask(store.list().find((h) => h.childSessionId === 'lume-kid')!.id, 'qual branch?')
    const { world } = mount(lives(BASE, { nori: { status: 'waiting', scan: permission } }))
    expect(screen.getByTestId('all-mothers')).toBeInTheDocument()
    expect(new Set(tiles().map((t) => t.dataset.tile))).toEqual(
      new Set(['lume', 'nori', 'sora', 'solo', 'avulsa']),
    )
    expect(screen.getByTestId('all-mothers-summary')).toHaveTextContent('5 mães · 2 features')
    const sum = tiles().reduce(
      (n, t) => n + tileNum(t, 'mother-tile-own') + tileNum(t, 'mother-tile-kids'),
      0,
    )
    const needYou = humanQueue(world.attention)
    expect(badge()).toBe(countAttentionSubjects(needYou))
    expect(badge()).toBe(2)
    expect(sum).toBe(badge())
    expect(tileNum(tileOf('nori'), 'mother-tile-own')).toBe(1)
    expect(tileNum(tileOf('lume'), 'mother-tile-kids')).toBe(1)
    expect(within(tileOf('lume')).getByTestId('mother-tile-kids')).toHaveTextContent(
      'pedido das filhas · Abrir sala',
    )
    expect(screen.getAllByTestId('all-mothers-strip-item')).toHaveLength(2)
  })

  it('aprovar no tile vai por attentionRespond; com o item fora da fila, badge e faixa caem juntos', async () => {
    seed()
    const menu = permission.menu!
    api.attentionMenu.mockResolvedValue({
      sessionId: 'nori',
      fingerprint: menuFingerprint(menu),
      menuSeq: 1,
      menu,
    })
    api.attentionRespond.mockResolvedValue({ ok: true })
    mount(lives(BASE, { nori: { status: 'waiting', scan: permission } }))
    expect(badge()).toBe(1)
    const panel = within(tileOf('nori')).getByTestId('mother-tile-menu')
    const approve = await within(panel).findByTestId('attention-action-approve')
    await act(async () => void fireEvent.click(approve))
    expect(api.attentionRespond).toHaveBeenCalledWith({
      sessionId: 'nori',
      fingerprint: menuFingerprint(menu),
      menuSeq: 1,
      action: { kind: 'select', optionIndex: 0 },
    })
    expect(api.write).not.toHaveBeenCalled()
    // attention:changed sem o menu (a TUI respondeu e voltou a trabalhar).
    apply(roomWorld(testDb, lives(BASE, { nori: { status: 'working' } })))
    expect(badge()).toBe(0)
    expect(screen.queryAllByTestId('all-mothers-strip-item')).toHaveLength(0)
    expect(within(tileOf('nori')).queryByTestId('mother-tile-menu')).toBeNull()
  })

  it('o composer do tile envia por sendTo.send para a mãe, nunca sessions.write', async () => {
    seed()
    api.send.mockResolvedValue({ ok: true, delivered: 'now' })
    mount(lives(BASE))
    const input = within(tileOf('sora')).getByTestId('card-prompt')
    fireEvent.change(input, { target: { value: 'status?' } })
    await act(async () => void fireEvent.keyDown(input, { key: 'Enter' }))
    expect(api.send).toHaveBeenCalledWith({ sessionId: 'sora', text: 'status?', when: 'now' })
    expect(api.write).not.toHaveBeenCalled()
    expect(within(tileOf('sora')).getByTestId('mother-tile-echo')).toHaveTextContent(
      'status? enviando…',
    )
  })

  function seedMany(n: number): string[] {
    harness.seedFeature(testDb, 'F3')
    const ids = Array.from({ length: n }, (_, i) => `m${i}`)
    for (const id of ids) harness.seedSession(testDb, id, { repoId: 'r1', featureId: 'F3' })
    return ids
  }

  it('tile fora da tela não assina a cauda; ao sair da tela libera', () => {
    const ids = seedMany(8)
    io.hidden = new Set(['m6', 'm7'])
    mount(lives(ids))
    expect(watchedTails()).toEqual(new Set(ids.slice(0, 6)))
    expect(tileOf('m6').dataset.live).toBe('paused')
    expect(within(tileOf('m6')).getByTestId('mother-tile-paused')).toBeInTheDocument()
    io.hidden = new Set(['m0', 'm1'])
    act(() => (io.observers.at(-1) as FakeIO).flush())
    expect(new Set(api.unwatchTail.mock.calls.map((c) => c[0]))).toEqual(new Set(['m0', 'm1']))
    expect(watchedTails()).toEqual(new Set(ids))
  })

  it(`com 10 mães visíveis só ${MAX_LIVE_TILES} assinam a cauda`, () => {
    const ids = seedMany(10)
    mount(lives(ids))
    expect(watchedTails().size).toBe(MAX_LIVE_TILES)
    expect(tiles().filter((t) => t.dataset.live === 'live')).toHaveLength(MAX_LIVE_TILES)
    expect(api.watch).not.toHaveBeenCalled()
  })

  it('com o foco no composer do tile 2 a ordem não muda quando outro tile passa a precisar de você', () => {
    seed()
    mount(lives(BASE))
    const before = tiles().map((t) => t.dataset.tile)
    const second = within(tiles()[1]).getByTestId('card-prompt')
    act(() => second.focus())
    fireEvent.focus(second)
    const last = before.at(-1)!
    apply(roomWorld(testDb, lives(BASE, { [last]: { status: 'waiting', scan: permission } })))
    expect(badge()).toBe(1)
    expect(tiles().map((t) => t.dataset.tile)).toEqual(before)
    // Sem rascunho, sair do composer descongela: quem precisa de você sobe.
    act(() => second.blur())
    fireEvent.blur(second)
    expect(tiles()[0].dataset.tile).toBe(last)
  })

  it('tecla 3 foca o tile 3; vinda do xterm não faz nada', () => {
    seed()
    mount(lives(BASE))
    const root = screen.getByTestId('all-mothers')
    fireEvent.keyDown(root, { key: '3' })
    expect(document.activeElement).toBe(tiles()[2])
    const xterm = document.createElement('div')
    xterm.className = 'xterm'
    const helper = document.createElement('textarea')
    helper.className = 'xterm-helper-textarea'
    xterm.appendChild(helper)
    root.appendChild(xterm)
    helper.focus()
    fireEvent.keyDown(helper, { key: '1' })
    expect(document.activeElement).toBe(helper)
  })

  it('Enter no tile abre a sala da feature com a mãe selecionada', () => {
    seed()
    mount(lives(BASE))
    act(() => tileOf('nori').focus())
    fireEvent.keyDown(tileOf('nori'), { key: 'Enter' })
    const room = useFeatureRoomStore.getState()
    expect(room.level).toBe('feature')
    expect(room.featureId).toBe('F1')
    expect(room.selectedMotherId.F1).toBe('nori')
  })

  it('fixar põe o tile primeiro, com aria-pressed', () => {
    seed()
    mount(lives(BASE))
    const last = tiles().at(-1)!
    const id = last.dataset.tile!
    fireEvent.click(within(last).getByTestId('mother-tile-pin'))
    expect(tiles()[0].dataset.tile).toBe(id)
    expect(within(tiles()[0]).getByTestId('mother-tile-pin')).toHaveAttribute(
      'aria-pressed',
      'true',
    )
  })

  it('zero mães: onboarding e o CTA, sem grade', () => {
    mount([])
    expect(screen.getByTestId('all-mothers-empty')).toHaveTextContent('Nenhuma mãe ativa')
    expect(screen.getByTestId('all-mothers-empty-start')).toBeInTheDocument()
    expect(screen.queryByTestId('all-mothers-grid')).toBeNull()
  })
})
