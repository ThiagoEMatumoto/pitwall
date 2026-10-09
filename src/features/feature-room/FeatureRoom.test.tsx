import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import Database from 'better-sqlite3'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// A Room sobre o estado que os PRODUTORES escrevem (handoffStore, projeção, grafo,
// room:get real via roomSnapshot). Só window.api é dublê: ele devolve o que o main
// devolveria a partir do mesmo banco.
// Produtores reais do main que a Room consome ao iniciar a mãe: o list-live-global
// (via ipcMain) e o chat:transcript-update (via broadcast da janela).
const rt = vi.hoisted(() => ({
  running: [] as string[],
  index: new Map<string, unknown>(),
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  chat: new Set<(u: unknown) => void>(),
}))
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp', getVersion: () => '0.0.0-test' },
  BrowserWindow: {
    getAllWindows: () => [
      {
        webContents: {
          send: (channel: string, payload: unknown) => {
            if (channel === 'chat:transcript-update') rt.chat.forEach((cb) => cb(payload))
          },
        },
      },
    ],
  },
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) =>
      rt.handlers.set(channel, fn),
    on: () => {},
    removeHandler: () => {},
  },
}))
let testDb: Database.Database
vi.mock('../../../electron/main/services/db', () => ({ getDb: () => testDb }))
vi.mock('../../../electron/main/services/transcript-path', () => ({
  PROJECTS_ROOT: '/nonexistent-projects',
  findTranscriptPath: () => null,
}))
vi.mock('../../../electron/main/services/session-activity', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  // O ~/.claude/sessions/<pid>.json: vazio até o claude recém-spawnado escrevê-lo.
  buildSessionsFileIndex: () => rt.index,
  isPidAlive: () => true,
}))
vi.mock('../../../electron/main/services/live-session-states', () => ({
  liveSessionStates: () => new Map(),
}))
// room:mother-preflight real (room-mother.ts) importa o spawnSession: a PTY e o MCP
// são os únicos dublês, como no room-mother.test.
vi.mock('../../../electron/main/services/pty-manager', () => ({
  ptyManager: {
    on: () => {},
    off: () => {},
    isRunning: () => false,
    runningIds: () => rt.running,
  },
}))
vi.mock('../../../electron/main/services/custom-env', () => ({ sessionSpawnEnv: () => ({}) }))
vi.mock('../../../electron/main/services/feature-memory', () => ({
  featureMemory: { onSessionExit: () => {} },
}))
const mcp = vi.hoisted(() => ({ runtime: null as null | Record<string, unknown> }))
vi.mock('../../../electron/main/services/mcp/server', () => ({ getMcpRuntime: () => mcp.runtime }))
// O Terminal real precisa de canvas/ResizeObserver; o que a Room decide são as props.
const terminalProps = vi.hoisted(() => [] as Array<Record<string, unknown>>)
vi.mock('@/features/sessions/Terminal', () => ({
  Terminal: (props: Record<string, unknown> & { session: { id: string } }) => {
    terminalProps.push(props)
    return (
      <div
        data-testid="terminal-mock"
        data-session={props.session.id}
        data-mode={String(props.mode)}
        data-lease={String(props.leaseHost)}
      />
    )
  },
}))
const startMother = vi.hoisted(() => ({
  fn: (() => new Promise(() => {})) as (i: unknown) => Promise<unknown>,
}))

const special: Record<string, Record<string, unknown>> = {
  room: {
    get: (id: string) => Promise.resolve(roomSnapshot(id)),
    motherPreflight: (id: string, repoId?: string) => Promise.resolve(motherPreflight(id, repoId)),
    startMother: (input: unknown) => startMother.fn(input),
  },
  handoffs: { list: () => Promise.resolve(store.list()) },
  chat: {
    onTranscriptUpdate: (cb: (u: unknown) => void) => {
      rt.chat.add(cb)
      return () => rt.chat.delete(cb)
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

const store = await import('../../../electron/main/services/handoff-store')
const harness = await import('../../../electron/main/services/attention/attention-test-harness')
const { roomWorld } = await import('../../../electron/main/services/attention/room-world')
const { roomSnapshot } = await import('../../../electron/main/services/feature-room-service')
const { motherPreflight } = await import('../../../electron/main/ipc/room-mother')
const { registerSessionIpc } = await import('../../../electron/main/ipc/sessions')
const { chatTranscriptService } =
  await import('../../../electron/main/services/chat-transcript-service')
const {
  CHAT_TIMEOUT_MS,
  CHAT_TIMEOUT_TEXT,
  MOTHER_DIED_TEXT,
  TERMINAL_TIMEOUT_MS,
  TERMINAL_TIMEOUT_TEXT,
} = await import('./StartMotherCard')
const { FeatureRoom } = await import('./FeatureRoom')
const { useTerminalLease } = await import('@/features/sessions/terminal-lease')
const { useFeatureRoomStore } = await import('./feature-room-store')
const { useSessionGraphStore } = await import('@/features/sessions/session-graph-store')
const { useAttentionListStore } = await import('@/store/attentionStore')
const { useHandoffsStore } = await import('@/store/handoffsStore')
const { useAppStore } = await import('@/store/appStore')

type WorldLive = import('../../../electron/main/services/attention/room-world').WorldLive

const F = 'F'

function child(repo: string, sid: string, task = `task ${sid}`, mode?: 'plan') {
  harness.seedSession(testDb, sid, { repoId: repo, featureId: F })
  const h = store.create({
    targetRepoId: repo,
    motherSessionId: 'M',
    featureId: F,
    task,
    composedPrompt: 'p',
    mode,
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
    featureId: F,
    timelineFilter: null,
    openId: null,
    selectedMotherId: {},
    pendingMother: null,
  })
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
    // Repo da feature num diretório que existe: o preflight real só oferece repo válido.
    testDb
      .prepare('UPDATE repos SET path = ? WHERE id = ?')
      .run(mkdtempSync(`${tmpdir()}/room-`), 'r1')
    testDb.prepare('INSERT INTO feature_repos (feature_id, repo_id) VALUES (?, ?)').run(F, 'r1')
    mcp.runtime = { port: 1 }
    terminalProps.length = 0
    useTerminalLease.setState({ leases: {}, stacks: {} })
    startMother.fn = vi.fn(() => new Promise(() => {}))
    rt.running = []
    rt.index.clear()
    permission = await harness.scanFixture('permission-bash')
  })
  afterEach(() => {
    chatTranscriptService.closeAll()
    vi.useRealTimers()
    testDb.close()
  })

  it('vazio: sem sessões nem handoffs', async () => {
    await mount([])
    expect(room().dataset.state).toBe('empty')
    expect(screen.getByTestId('start-mother')).toHaveTextContent(
      'Esta feature ainda não tem uma mãe',
    )
    expect(screen.queryByTestId('room-mother')).toBeNull()
    expect(room()).toHaveTextContent('As filhas aparecem aqui quando a mãe delegar.')
    expect(room()).toHaveTextContent('Nada para decidir ainda')
    expect(room()).toHaveTextContent(
      'Perguntas, menus e falhas das sessões desta feature aparecem aqui.',
    )
    fireEvent.click(screen.getByTestId('room-side-timeline'))
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
    expect(screen.queryByTestId('start-mother')).toBeNull()
    expect(screen.queryAllByTestId('room-child-row')).toHaveLength(0)
    expect(room()).toHaveTextContent('A mãe ainda não abriu filhas.')
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

  it("filha plan: rótulo 'leitura' com o aviso de que escreve pelo shell após aprovar", async () => {
    harness.seedSession(testDb, 'M', { repoId: 'r6', featureId: F })
    child('r1', 'P', 'task P', 'plan')
    child('r2', 'W', 'task W')
    await mount([
      { id: 'M', status: 'idle' },
      { id: 'P', status: 'working', lastText: 'lendo o plano' },
      { id: 'W', status: 'working', lastText: 'editando arquivos' },
    ])
    const rows = screen.getAllByTestId('room-child-row')
    const plan = rows.find((r) => r.textContent?.includes('lendo o plano'))!
    const writer = rows.find((r) => r.textContent?.includes('editando arquivos'))!
    const tag = within(plan).getByTestId('room-readonly')
    expect(tag).toHaveTextContent('leitura')
    expect(tag).toHaveAttribute(
      'title',
      'Não conta para a trava do diretório. Se você aprovar o plano dela, ela pode escrever pelo shell.',
    )
    expect(within(writer).queryByTestId('room-readonly')).toBeNull()
    expect(within(screen.getByTestId('room-mother')).queryByTestId('room-readonly')).toBeNull()
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
    expect(screen.getByText('2 precisa de você')).toHaveClass('sr-only')
    expect(screen.getByTestId('room-features-badge')).toHaveTextContent('2')
    expect(screen.getAllByTestId('room-queue-row')).toHaveLength(2)
  })

  it('feature inexistente oferece a saída para o seletor', async () => {
    useFeatureRoomStore.setState({ featureId: 'NOPE', timelineFilter: null, openId: null })
    render(<FeatureRoom />)
    expect(await screen.findByText(/não existe mais/)).toBeInTheDocument()
    expect(screen.getByTestId('room-gone-switch')).toHaveTextContent('Trocar de feature')
  })

  it('room:get rejeitado: mostra o erro e "Tentar de novo" recarrega', async () => {
    const realGet = special.room.get
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    special.room.get = () => Promise.reject(new Error('ipc down'))
    try {
      const w = roomWorld(testDb, [])
      useSessionGraphStore.setState({ graph: w.graph })
      useHandoffsStore.setState({ handoffs: w.handoffs, loading: false })
      useAttentionListStore.setState({ items: w.attention })
      useAppStore.setState({ area: 'room', liveSessions: w.live })
      useFeatureRoomStore.setState({ featureId: F, timelineFilter: null, openId: null })
      render(<FeatureRoom />)
      expect(await screen.findByRole('alert')).toHaveTextContent(
        'Não foi possível carregar a Room.',
      )
      expect(screen.queryByText('Carregando a Room…')).not.toBeInTheDocument()
      special.room.get = realGet
      fireEvent.click(screen.getByTestId('room-retry'))
      expect(await screen.findByTestId('room-needs-count')).toBeInTheDocument()
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    } finally {
      special.room.get = realGet
      errSpy.mockRestore()
    }
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
    // Esc no textarea devolve o foco à Room, e J volta a navegar.
    fireEvent.keyDown(textarea, { key: 'Escape' })
    expect(document.activeElement).toBe(room())
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
    const item = world.attention.find((i) => i.kind === 'request')!
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
    fireEvent.click(screen.getByTestId('room-side-timeline'))
    const all = screen.getAllByTestId('room-timeline-event').length
    expect(all).toBeGreaterThan(2)
    fireEvent.click(screen.getByTestId('room-side-children'))
    const [rowA] = screen.getAllByTestId('room-child-row')
    const filter = within(rowA).getByRole('button', { pressed: false })
    fireEvent.click(filter)
    expect(filter).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(screen.getByTestId('room-side-timeline'))
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

  it('sem mãe: o card de iniciar; objetivo vazio mostra o erro e não chama startMother', async () => {
    await mount([])
    const purpose = await screen.findByTestId('start-mother-purpose')
    // O preflight real sugere o título da feature (sem objetivo) e o repo válido.
    await waitFor(() => expect(purpose).toHaveValue(F))
    expect(screen.getAllByTestId('start-mother-repo').map((b) => b.textContent)).toEqual(['Repo 1'])
    fireEvent.change(purpose, { target: { value: '   ' } })
    fireEvent.click(screen.getByTestId('start-mother-submit'))
    expect(screen.getByTestId('start-mother-error')).toHaveTextContent(
      'Escreva o objetivo — ele vira o propósito da mãe.',
    )
    expect(startMother.fn).not.toHaveBeenCalled()
    fireEvent.change(purpose, { target: { value: 'Fechar o PR' } })
    fireEvent.click(screen.getByTestId('start-mother-submit'))
    expect(startMother.fn).toHaveBeenCalledWith({
      featureId: F,
      repoId: 'r1',
      purpose: 'Fechar o PR',
    })
    expect(await screen.findByTestId('start-mother-steps')).toBeInTheDocument()
    expect(useFeatureRoomStore.getState().pendingMother).toMatchObject({ step: 'worktree' })
  })

  it('sem MCP: botão desabilitado com o motivo à vista', async () => {
    mcp.runtime = null
    await mount([])
    const reason = await screen.findByTestId('start-mother-blocked')
    expect(reason).toHaveTextContent('O servidor MCP do Pitwall não subiu')
    expect(screen.getByTestId('start-mother-submit')).toBeDisabled()
  })

  it('com mãe viva: o centro é o Terminal em chat com a lease room (nunca dock)', async () => {
    harness.seedSession(testDb, 'M', { repoId: 'r6', featureId: F })
    await mount([{ id: 'M', status: 'idle' }])
    const pane = screen.getByTestId('room-mother')
    const term = within(pane).getByTestId('terminal-mock')
    expect(term.dataset).toMatchObject({ session: 'M', mode: 'chat', lease: 'room' })
    expect(terminalProps.at(-1)).toMatchObject({ chrome: 'bare', leaseHost: 'room', mode: 'chat' })
    expect(useTerminalLease.getState().stacks).toEqual({ M: ['room'] })
    // Ctrl+. alterna; o modo chega ao Terminal.
    act(() => void fireEvent.keyDown(window, { key: '.', ctrlKey: true }))
    expect(within(pane).getByTestId('terminal-mock').dataset.mode).toBe('terminal')
    expect(screen.getByTestId('room-mother-mode-terminal')).toHaveAttribute('aria-pressed', 'true')
  })

  it('/ foca o composer da mãe, não o helper do xterm que vem antes no DOM', async () => {
    harness.seedSession(testDb, 'M', { repoId: 'r6', featureId: F })
    await mount([{ id: 'M', status: 'idle' }])
    const pane = screen.getByTestId('room-mother')
    const xterm = document.createElement('div')
    xterm.innerHTML = '<textarea class="xterm-helper-textarea"></textarea>'
    const composer = document.createElement('textarea')
    pane.append(xterm, composer)
    room().focus()
    fireEvent.keyDown(room(), { key: '/' })
    expect(document.activeElement).toBe(composer)
  })

  // O list-live-global de verdade, como o renderer o recebe.
  const liveFromMain = async () => {
    if (!rt.handlers.has('sessions:list-live-global')) registerSessionIpc()
    const list = (await rt.handlers.get('sessions:list-live-global')!({})) as Array<{
      id: string
      status: string
    }>
    act(() => useAppStore.setState({ liveSessions: list as never }))
    return list
  }
  const ccOf = (id: string) =>
    (
      testDb.prepare('SELECT cc_session_id FROM sessions WHERE id = ?').get(id) as {
        cc_session_id: string
      }
    ).cc_session_id

  it('recém-nascida (ended no list-live-global): os passos esperam e o foco chega ao composer quando ele monta', async () => {
    await mount([])
    harness.seedSession(testDb, 'M', { repoId: 'r1', featureId: F })
    rt.running = ['M']
    startMother.fn = vi.fn(() =>
      Promise.resolve({ sessionId: 'M', ccSessionId: ccOf('M'), cwd: '', ccSessionIdReadyMs: 1 }),
    )
    fireEvent.click(await screen.findByTestId('start-mother-submit'))
    await waitFor(() =>
      expect(useFeatureRoomStore.getState().pendingMother).toMatchObject({ step: 'terminal' }),
    )

    // A PTY roda mas o sessions/<pid>.json ainda não existe: o main diz 'ended'.
    expect((await liveFromMain()).find((l) => l.id === 'M')?.status).toBe('ended')
    expect(useFeatureRoomStore.getState().pendingMother).toMatchObject({ step: 'terminal' })
    expect(screen.getByTestId('start-mother-steps')).toBeInTheDocument()
    expect(screen.queryByTestId('start-mother-failure')).toBeNull()

    rt.index.set(ccOf('M'), { pid: 1, status: 'idle', name: null, cwd: null, updatedAt: 1 })
    expect((await liveFromMain()).find((l) => l.id === 'M')?.status).toBe('idle')
    expect(useFeatureRoomStore.getState().pendingMother).toMatchObject({ step: 'chat' })

    // O watch do chat emite a lista vazia de cara (transcript ainda inexistente).
    act(() => chatTranscriptService.watch('M', ccOf('M')))
    expect(useFeatureRoomStore.getState().pendingMother).toBeNull()

    // O RoomMotherPane monta depois (o grafo ainda não via a mãe): o foco espera por ele.
    const w = roomWorld(testDb, [{ id: 'M', status: 'idle' }])
    act(() => useSessionGraphStore.setState({ graph: w.graph }))
    const pane = await screen.findByTestId('room-mother')
    const xterm = document.createElement('textarea')
    xterm.className = 'xterm-helper-textarea'
    const composer = document.createElement('textarea')
    pane.append(xterm, composer)
    await waitFor(() => expect(document.activeElement).toBe(composer))
  })

  it('não aparece viva no prazo: erro visível com saída', async () => {
    harness.seedSession(testDb, 'M', { repoId: 'r6', featureId: F })
    rt.running = ['M']
    await mount([])
    await liveFromMain()
    vi.useFakeTimers()
    act(() =>
      useFeatureRoomStore
        .getState()
        .setPendingMother({ featureId: F, sessionId: 'M', step: 'terminal' }),
    )
    act(() => void vi.advanceTimersByTime(TERMINAL_TIMEOUT_MS - 1))
    expect(screen.queryByTestId('start-mother-failure')).toBeNull()
    act(() => void vi.advanceTimersByTime(1))
    expect(screen.getByTestId('start-mother-failure')).toHaveTextContent(TERMINAL_TIMEOUT_TEXT)
    expect(document.querySelector('[data-step="terminal"]')).toHaveAttribute('data-state', 'failed')
    expect(screen.getByTestId('start-mother-submit')).toHaveTextContent('Iniciar sessão-mãe')
    fireEvent.click(screen.getByTestId('start-mother-dismiss'))
    expect(useFeatureRoomStore.getState().pendingMother).toBeNull()
  })

  it('chat sem o 1º transcript-update: o passo "chat" estoura o prazo com estado visível', async () => {
    harness.seedSession(testDb, 'M', { repoId: 'r6', featureId: F })
    await mount([{ id: 'M', status: 'idle' }])
    vi.useFakeTimers()
    act(() =>
      useFeatureRoomStore
        .getState()
        .setPendingMother({ featureId: F, sessionId: 'M', step: 'chat' }),
    )
    act(() => void vi.advanceTimersByTime(CHAT_TIMEOUT_MS))
    expect(screen.getByTestId('start-mother-failure')).toHaveTextContent(CHAT_TIMEOUT_TEXT)
    expect(document.querySelector('[data-step="chat"]')).toHaveAttribute('data-state', 'failed')
    // Chegou tarde, mas chegou: o card sai sozinho.
    act(() => chatTranscriptService.watch('M', ccOf('M')))
    expect(useFeatureRoomStore.getState().pendingMother).toBeNull()
  })

  it('mãe encerrada depois de vista viva: erro com saída, não "Iniciando…" para sempre', async () => {
    harness.seedSession(testDb, 'M', { repoId: 'r6', featureId: F })
    await mount([{ id: 'M', status: 'idle' }])
    act(() =>
      useFeatureRoomStore
        .getState()
        .setPendingMother({ featureId: F, sessionId: 'M', step: 'chat' }),
    )
    expect(screen.getByTestId('start-mother-steps')).toBeInTheDocument()
    act(() =>
      useAppStore.setState((s) => ({
        liveSessions: s.liveSessions.map((l) => (l.id === 'M' ? { ...l, status: 'ended' } : l)),
      })),
    )
    expect(screen.getByTestId('start-mother-failure')).toHaveTextContent(MOTHER_DIED_TEXT)
    fireEvent.click(screen.getByTestId('start-mother-dismiss'))
    expect(useFeatureRoomStore.getState().pendingMother).toBeNull()
    expect(screen.queryByTestId('start-mother-steps')).not.toBeInTheDocument()
  })

  it('J vindo do xterm não move a fila', async () => {
    harness.seedSession(testDb, 'M', { repoId: 'r6', featureId: F })
    store.ask(child('r1', 'A').id, 'qual branch?')
    store.ask(child('r2', 'B').id, 'qual porta?')
    await mount([
      { id: 'M', status: 'idle' },
      { id: 'A', status: 'working' },
      { id: 'B', status: 'working' },
    ])
    const firstOpen = screen.getByTestId('room-queue-open').textContent
    const xterm = document.createElement('div')
    xterm.className = 'xterm'
    xterm.innerHTML =
      '<div class="xterm-screen"></div><textarea class="xterm-helper-textarea"></textarea>'
    screen.getByTestId('room-mother').appendChild(xterm)
    fireEvent.keyDown(xterm.querySelector('.xterm-screen')!, { key: 'j' })
    fireEvent.keyDown(xterm.querySelector('textarea')!, { key: 'j' })
    expect(screen.getByTestId('room-queue-open').textContent).toBe(firstOpen)
  })

  it('2 mães: tabs; escolher uma muda selectedMotherId e o centro', async () => {
    harness.seedSession(testDb, 'M', { repoId: 'r6', featureId: F })
    harness.seedSession(testDb, 'M2', { repoId: 'r1', featureId: F })
    await mount([
      { id: 'M', status: 'idle' },
      { id: 'M2', status: 'idle' },
    ])
    const tabs = screen.getAllByTestId('room-mother-tab')
    expect(tabs).toHaveLength(2)
    const other = tabs.find((t) => t.getAttribute('aria-selected') === 'false')!
    const before = screen.getByTestId('room-mother').dataset.sessionId
    fireEvent.click(other)
    const picked = useFeatureRoomStore.getState().selectedMotherId[F]
    expect(picked).toBeDefined()
    expect(picked).not.toBe(before)
    // A troca espera 300ms (o mesmo debounce do MotherDock) antes de remontar.
    await waitFor(() => expect(screen.getByTestId('room-mother').dataset.sessionId).toBe(picked))
  })
})
