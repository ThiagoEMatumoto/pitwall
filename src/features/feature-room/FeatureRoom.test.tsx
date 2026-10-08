import Database from 'better-sqlite3'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// A Room sobre o estado que os PRODUTORES escrevem (handoffStore, projeção, grafo,
// room:get real via roomSnapshot). Só window.api é dublê: ele devolve o que o main
// devolveria a partir do mesmo banco.
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp', getVersion: () => '0.0.0-test' },
  BrowserWindow: { getAllWindows: () => [] },
}))
let testDb: Database.Database
vi.mock('../../../electron/main/services/db', () => ({ getDb: () => testDb }))
vi.mock('../../../electron/main/services/transcript-path', () => ({
  findTranscriptPath: () => null,
}))
vi.mock('../../../electron/main/services/session-activity', () => ({
  buildSessionsFileIndex: () => new Map(),
}))
vi.mock('../../../electron/main/services/live-session-states', () => ({
  liveSessionStates: () => new Map(),
}))

const special: Record<string, Record<string, unknown>> = {
  room: { get: (id: string) => Promise.resolve(roomSnapshot(id)) },
  handoffs: { list: () => Promise.resolve(store.list()) },
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

const store = await import('../../../electron/main/services/handoff-store')
const harness = await import('../../../electron/main/services/attention/attention-test-harness')
const { roomWorld } = await import('../../../electron/main/services/attention/room-world')
const { roomSnapshot } = await import('../../../electron/main/services/feature-room-service')
const { FeatureRoom } = await import('./FeatureRoom')
const { useFeatureRoomStore } = await import('./feature-room-store')
const { useSessionGraphStore } = await import('@/features/sessions/session-graph-store')
const { useAttentionListStore } = await import('@/store/attentionStore')
const { useHandoffsStore } = await import('@/store/handoffsStore')
const { useAppStore } = await import('@/store/appStore')

type WorldLive = import('../../../electron/main/services/attention/room-world').WorldLive

const F = 'F'

function child(repo: string, sid: string, task = `task ${sid}`) {
  harness.seedSession(testDb, sid, { repoId: repo, featureId: F })
  const h = store.create({
    targetRepoId: repo,
    motherSessionId: 'M',
    featureId: F,
    task,
    composedPrompt: 'p',
  })
  return store.markRunning(h.id, sid)
}

async function mount(lives: WorldLive[]) {
  const w = roomWorld(testDb, lives)
  useSessionGraphStore.setState({ graph: w.graph })
  useHandoffsStore.setState({ handoffs: w.handoffs, loading: false })
  useAttentionListStore.setState({ items: w.attention })
  useAppStore.setState({ area: 'room', liveSessions: w.live })
  useFeatureRoomStore.setState({ featureId: F, timelineFilter: null, openId: null })
  const utils = render(<FeatureRoom />)
  await screen.findByTestId('room-needs-count')
  return { ...utils, world: w }
}

const room = () => screen.getByTestId('feature-room')

describe('FeatureRoom', () => {
  let permission: Awaited<ReturnType<typeof harness.scanFixture>>

  beforeEach(async () => {
    Element.prototype.scrollIntoView = vi.fn()
    testDb = new Database(':memory:')
    testDb.pragma('foreign_keys = ON')
    harness.applyAllMigrations(testDb)
    harness.seedRepos(testDb)
    harness.seedFeature(testDb, F)
    permission = await harness.scanFixture('permission-bash')
  })
  afterEach(() => testDb.close())

  it('vazio: sem sessões nem handoffs', async () => {
    await mount([])
    expect(room().dataset.state).toBe('empty')
    expect(room()).toHaveTextContent('Nenhuma sessão nesta feature')
    expect(room()).toHaveTextContent('Comece pela mãe: ela decompõe e delega as filhas.')
    expect(room()).toHaveTextContent('Nada para decidir ainda')
    expect(room()).toHaveTextContent(
      'Perguntas, menus e falhas das sessões desta feature aparecem aqui.',
    )
    expect(room()).toHaveTextContent('Nada aconteceu ainda.')
    expect(room()).toHaveTextContent('Sem pulso ainda.')
    expect(screen.getByTestId('room-new-child')).toBeDisabled()
    expect(screen.getByTestId('room-new-child')).toHaveAttribute(
      'title',
      'Uma filha precisa de uma mãe',
    )
    expect(screen.getByTestId('room-wakes')).toHaveTextContent('sem avisos à mãe em 24h')
  })

  it('1 sessão só: a mãe em destaque, sem filhas', async () => {
    harness.seedSession(testDb, 'M', { repoId: 'r6', featureId: F })
    await mount([{ id: 'M', status: 'idle', lastText: 'Pronto para delegar.' }])
    expect(room().dataset.state).toBe('solo')
    const mother = screen.getByTestId('room-mother')
    expect(mother).toHaveTextContent('ociosa')
    expect(within(mother).getByTestId('room-last-text')).toHaveTextContent('Pronto para delegar.')
    expect(screen.queryAllByTestId('room-child-row')).toHaveLength(0)
    expect(room()).toHaveTextContent('Nada precisa de você')
    expect(screen.getByTestId('room-new-child')).toBeEnabled()
  })

  it('tudo verde: filhas rodando, fila vazia', async () => {
    harness.seedSession(testDb, 'M', { repoId: 'r6', featureId: F })
    child('r1', 'A')
    child('r2', 'B')
    await mount([
      { id: 'M', status: 'idle' },
      { id: 'A', status: 'working' },
      { id: 'B', status: 'working' },
    ])
    expect(room().dataset.state).toBe('green')
    expect(screen.getByTestId('room-needs-count')).toHaveTextContent('0')
    expect(room()).toHaveTextContent('Nada precisa de você')
    expect(room()).toHaveTextContent('As sessões seguem; a fila acende se algo parar.')
    expect(screen.getAllByTestId('room-child-row')).toHaveLength(2)
    // Trabalho e execução em indicadores separados.
    const row = screen.getAllByTestId('room-child-row')[0]
    expect(row).toHaveTextContent('Em andamento')
    expect(row).toHaveTextContent('trabalhando')
  })

  it('normal: contador e badge do botão Features mostram o mesmo N', async () => {
    harness.seedSession(testDb, 'M', { repoId: 'r6', featureId: F })
    store.ask(child('r1', 'A').id, 'qual branch?')
    child('r2', 'B')
    await mount([
      { id: 'M', status: 'idle' },
      { id: 'A', status: 'working' },
      { id: 'B', status: 'waiting', scan: permission },
    ])
    expect(room().dataset.state).toBe('normal')
    expect(screen.getByTestId('room-needs-count')).toHaveTextContent('2')
    expect(screen.getByTestId('room-needs-count')).toHaveAttribute(
      'aria-label',
      '2 precisa de você',
    )
    expect(screen.getByTestId('room-features-badge')).toHaveTextContent('2')
    expect(screen.getAllByTestId('room-queue-row')).toHaveLength(2)
  })

  it('só 1 item aberto; J vai ao próximo e foca, K volta; J no textarea não navega', async () => {
    harness.seedSession(testDb, 'M', { repoId: 'r6', featureId: F })
    store.ask(child('r1', 'A').id, 'qual branch?')
    store.ask(child('r2', 'B').id, 'qual porta?')
    await mount([
      { id: 'M', status: 'idle' },
      { id: 'A', status: 'working' },
      { id: 'B', status: 'working' },
    ])
    expect(screen.getAllByTestId('room-queue-open')).toHaveLength(1)
    const firstOpen = screen.getByTestId('room-queue-open').textContent
    act(() => void fireEvent.keyDown(room(), { key: 'j' }))
    expect(screen.getAllByTestId('room-queue-open')).toHaveLength(1)
    const second = screen.getByTestId('room-queue-open')
    expect(second.textContent).not.toBe(firstOpen)
    expect(second.contains(document.activeElement)).toBe(true)
    act(() => void fireEvent.keyDown(document.activeElement!, { key: 'k' }))
    expect(screen.getByTestId('room-queue-open').textContent).toBe(firstOpen)
    const textarea = screen.getByRole('textbox', { name: 'Resposta' })
    textarea.focus()
    fireEvent.keyDown(textarea, { key: 'j' })
    expect(screen.getByTestId('room-queue-open').textContent).toBe(firstOpen)
    // Ctrl+J tem outro dono.
    fireEvent.keyDown(room(), { key: 'j', ctrlKey: true })
    expect(screen.getByTestId('room-queue-open').textContent).toBe(firstOpen)
  })

  it('"Por que está aqui?" mostra entryRule/exitRule da projeção', async () => {
    harness.seedSession(testDb, 'M', { repoId: 'r6', featureId: F })
    store.ask(child('r1', 'A').id, 'qual branch?')
    const { world } = await mount([
      { id: 'M', status: 'idle' },
      { id: 'A', status: 'working' },
    ])
    const item = world.attention.find((i) => i.kind === 'child_question')!
    const open = screen.getByTestId('room-queue-open')
    expect(within(open).getByText('Por que está aqui?')).toBeInTheDocument()
    expect(within(open).getByText(item.entryRule)).toBeInTheDocument()
    expect(within(open).getByText(item.exitRule)).toBeInTheDocument()
    expect(within(open).getByText(item.whyNow)).toBeInTheDocument()
  })

  it('clicar numa sessão filtra a linha do tempo e marca aria-pressed', async () => {
    harness.seedSession(testDb, 'M', { repoId: 'r6', featureId: F })
    child('r1', 'A')
    child('r2', 'B')
    await mount([
      { id: 'M', status: 'idle' },
      { id: 'A', status: 'working' },
      { id: 'B', status: 'working' },
    ])
    const all = screen.getAllByTestId('room-timeline-event').length
    expect(all).toBeGreaterThan(2)
    const [rowA] = screen.getAllByTestId('room-child-row')
    const filter = within(rowA).getByRole('button', { pressed: false })
    fireEvent.click(filter)
    expect(filter).toHaveAttribute('aria-pressed', 'true')
    const filtered = screen.getAllByTestId('room-timeline-event')
    expect(filtered.length).toBeLessThan(all)
    const name = screen
      .getByTestId('room-timeline-filter')
      .textContent!.replace(/^só (.*) ✕$/, '$1')
    expect(rowA).toHaveTextContent(name)
    expect(filtered.every((e) => e.querySelector('b')?.textContent === name)).toBe(true)
    fireEvent.click(screen.getByTestId('room-timeline-filter'))
    expect(screen.getAllByTestId('room-timeline-event')).toHaveLength(all)
  })

  it('nada de F3-F5 nem tool atual na árvore', async () => {
    harness.seedSession(testDb, 'M', { repoId: 'r6', featureId: F })
    store.ask(child('r1', 'A').id, 'qual branch?')
    child('r2', 'B')
    await mount([
      { id: 'M', status: 'idle' },
      { id: 'A', status: 'working' },
      { id: 'B', status: 'waiting', scan: permission },
    ])
    const text = room().textContent!.toLowerCase()
    for (const word of ['revisão', 'round', 'watchdog', 'wave', 'tool']) {
      expect(text).not.toContain(word)
    }
  })
})
