import Database from 'better-sqlite3'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Ações inline da fila: cada botão chama o caminho que já existe (handoffs:send-
// message, handoffs:resume, sessions:attention-respond). Estado dos produtores
// reais; o menu de permissão é a captura bruta do claude 2.1.286 parseada.
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp', getVersion: () => '0.0.0-test' },
  BrowserWindow: { getAllWindows: () => [] },
}))
let testDb: Database.Database
vi.mock('../../../electron/main/services/db', () => ({ getDb: () => testDb }))
// O centro da Room monta o Terminal da mãe (xterm, canvas); aqui só a fila importa.
vi.mock('@/features/sessions/Terminal', () => ({ Terminal: () => null }))
let transcriptPath: string | null = null
vi.mock('../../../electron/main/services/transcript-path', () => ({
  findTranscriptPath: () => transcriptPath,
}))
const sendMessage = vi.fn()
const resume = vi.fn()
const attentionMenu = vi.fn()
const attentionRespond = vi.fn()
vi.mock('../../../electron/main/services/session-activity', () => ({
  buildSessionsFileIndex: () => new Map(),
}))
vi.mock('../../../electron/main/services/live-session-states', () => ({
  liveSessionStates: () => new Map(),
}))

const special: Record<string, Record<string, unknown>> = {
  room: { get: (id: string) => Promise.resolve(roomSnapshot(id)) },
  handoffs: { list: () => Promise.resolve(store.list()), sendMessage, resume },
  sessions: { attentionMenu, attentionRespond },
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
const { menuFingerprint } = await import('../../../shared/tui/tui-menu-parser')
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
  useFeatureRoomStore.setState({
    level: 'feature',
    featureId: F,
    timelineFilter: null,
    openId: null,
  })
  const utils = render(<FeatureRoom />)
  await screen.findByTestId('room-needs-count')
  return { ...utils, world: w }
}

const open = () => screen.getByTestId('room-queue-open')

describe('QueueItem — ações inline', () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn()
    testDb = new Database(':memory:')
    testDb.pragma('foreign_keys = ON')
    harness.applyAllMigrations(testDb)
    harness.seedRepos(testDb)
    harness.seedFeature(testDb, F)
    harness.seedSession(testDb, 'M', { repoId: 'r6', featureId: F })
    transcriptPath = null
    for (const fn of [sendMessage, resume, attentionMenu, attentionRespond]) fn.mockReset()
  })
  afterEach(() => testDb.close())

  // child_question só sai para needs_input legado (sem pedido tipado).
  it('child_question: sem texto o botão fica desabilitado; responder chama sendMessage({id,text})', async () => {
    const h = child('r1', 'A')
    harness.legacyAsk(testDb, h.id, 'qual branch?')
    sendMessage.mockResolvedValue(undefined)
    await mount([
      { id: 'M', status: 'idle' },
      { id: 'A', status: 'working' },
    ])
    expect(open()).toHaveTextContent('qual branch?')
    const reply = within(open()).getByRole('button', { name: 'Responder e retomar' })
    expect(reply).toBeDisabled()
    fireEvent.change(within(open()).getByRole('textbox', { name: 'Resposta' }), {
      target: { value: '  main  ' },
    })
    expect(reply).toBeEnabled()
    await act(async () => void fireEvent.click(reply))
    expect(sendMessage).toHaveBeenCalledWith({ id: h.id, text: 'main' })
  })

  it('child_question: erro do envio aparece em role=status', async () => {
    harness.legacyAsk(testDb, child('r1', 'A').id, 'qual branch?')
    sendMessage.mockRejectedValue(new Error('A sessão-filha não está mais viva'))
    await mount([
      { id: 'M', status: 'idle' },
      { id: 'A', status: 'working' },
    ])
    fireEvent.change(within(open()).getByRole('textbox', { name: 'Resposta' }), {
      target: { value: 'main' },
    })
    await act(
      async () =>
        void fireEvent.click(within(open()).getByRole('button', { name: 'Responder e retomar' })),
    )
    expect(within(open()).getByRole('status')).toHaveTextContent('não está mais viva')
  })

  it('request: o pedido tipado despacha para o RequestBody', async () => {
    store.ask(child('r1', 'A').id, 'qual branch?')
    await mount([
      { id: 'M', status: 'idle' },
      { id: 'A', status: 'working' },
    ])
    expect(screen.getByTestId('room-queue-row')).toHaveAttribute('data-kind', 'request')
    expect(within(open()).getByText('Pergunta')).toBeInTheDocument()
    expect(within(open()).queryByRole('button', { name: 'Responder e retomar' })).toBeNull()
    expect(within(open()).getByRole('button', { name: 'Responder' })).toBeDisabled()
  })

  it('child_interrupted: "Retomar" chama handoffs.resume(id)', async () => {
    const h = child('r1', 'A')
    store.failIfRunning(h.id, 'PTY morreu')
    transcriptPath = '/tmp/a.jsonl'
    resume.mockResolvedValue(undefined)
    await mount([{ id: 'M', status: 'idle' }])
    expect(open().closest('li')).toHaveAttribute('data-kind', 'child_interrupted')
    await act(
      async () => void fireEvent.click(within(open()).getByRole('button', { name: 'Retomar' })),
    )
    expect(resume).toHaveBeenCalledWith(h.id)
  })

  it('session_menu: renderiza o AttentionMenuPanel e Aprovar chama attentionRespond', async () => {
    const permission = await harness.scanFixture('permission-bash')
    child('r1', 'A')
    const menu = permission.menu!
    attentionMenu.mockResolvedValue({
      sessionId: 'A',
      fingerprint: menuFingerprint(menu),
      menuSeq: 1,
      menu,
    })
    attentionRespond.mockResolvedValue({ ok: true })
    await mount([
      { id: 'M', status: 'idle' },
      { id: 'A', status: 'waiting', scan: permission },
    ])
    expect(open().closest('li')).toHaveAttribute('data-kind', 'session_menu')
    const approve = await within(open()).findByTestId('attention-action-approve')
    expect(within(open()).getByTestId('attention-action-always')).toBeInTheDocument()
    expect(within(open()).getByTestId('attention-action-deny')).toBeInTheDocument()
    await act(async () => void fireEvent.click(approve))
    expect(attentionRespond).toHaveBeenCalledWith({
      sessionId: 'A',
      fingerprint: menuFingerprint(menu),
      menuSeq: 1,
      action: { kind: 'select', optionIndex: 0 },
    })
  })
})
