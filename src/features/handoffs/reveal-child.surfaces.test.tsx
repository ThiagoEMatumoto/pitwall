import Database from 'better-sqlite3'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// As superfícies de envio que não tinham teste do próprio envio (cartão do mapa,
// @alias do composer, QuickComposer) sobre o mundo real: handoffStore em banco
// migrado, grafo e lista viva pelos mappers do main, appStore de verdade. Os
// dublês são só os IPCs que escrevem na filha.
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

const sendMessage = vi.fn()
const send = vi.fn()
const pending = () => new Promise(() => {})
const special: Record<string, Record<string, unknown>> = {
  handoffs: { list: () => Promise.resolve(store.list()), sendMessage },
  // queue/get pendentes: os stores ficam com o estado que o teste pôs.
  sendTo: { send, queue: pending },
  sessionGraph: { get: pending },
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
                (m.startsWith('on') ? () => () => {} : () => Promise.resolve(null)),
            },
          ),
      },
    ),
  }),
)

const store = await import('../../../electron/main/services/handoff-store')
const harness = await import('../../../electron/main/services/attention/attention-test-harness')
const { roomWorld } = await import('../../../electron/main/services/attention/room-world')
const { useSessionGraphStore } = await import('@/features/sessions/session-graph-store')
const { useHandoffsStore } = await import('@/store/handoffsStore')
const { useAppStore } = await import('@/store/appStore')
const { buildTargets } = await import('@/features/quick-composer/target-search')
const { useQuickComposerStore } = await import('@/features/quick-composer/quick-composer-store')
const { QuickComposer } = await import('@/features/quick-composer/QuickComposer')
const { CardPromptBar } = await import('@/features/session-canvas/SessionCardLive')
const { Composer } = await import('@/features/sessions/Composer')

type Handoff = import('../../../shared/types/ipc').Handoff
type RoomWorld = import('../../../electron/main/services/attention/room-world').RoomWorld

const MOTHER = 'M'
const CHILD = 'A'

const tabs = () => useAppStore.getState().panes.map((p) => p.session.id)

describe('mensagem do usuário a uma filha fora da tela', () => {
  let handoff: Handoff
  let world: RoomWorld
  let tabsAtSend: string[]

  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn()
    testDb = new Database(':memory:')
    testDb.pragma('foreign_keys = ON')
    harness.applyAllMigrations(testDb)
    harness.seedRepos(testDb)
    harness.seedSession(testDb, MOTHER)
    harness.seedSession(testDb, CHILD)
    const created = store.create({
      targetRepoId: 'r1',
      motherSessionId: MOTHER,
      task: 'refatorar o auth',
      composedPrompt: 'p',
    })
    handoff = store.markRunning(created.id, CHILD)
    world = roomWorld(testDb, [
      { id: MOTHER, status: 'idle' },
      { id: CHILD, status: 'idle' },
    ])
    // O nome de cada sessão é do teste (o mapper só traz id, cc e status).
    const live = world.live.map((s) => ({ ...s, title: s.id === CHILD ? 'filha-api' : 'mae-web' }))
    useSessionGraphStore.setState({ graph: world.graph })
    useHandoffsStore.setState({ handoffs: world.handoffs, loading: false })
    useAppStore.setState({ liveSessions: live, panes: [], area: 'features', focusPaneId: null })
    useQuickComposerStore.setState({ open: false, targetId: null })
    tabsAtSend = []
    const noteTabs = async () => {
      tabsAtSend = tabs()
    }
    sendMessage.mockReset().mockImplementation(noteTabs)
    send.mockReset().mockImplementation(async () => {
      await noteTabs()
      return { ok: true, delivered: true }
    })
  })
  afterEach(() => testDb.close())

  describe('cartão do mapa', () => {
    const node = () => world.graph.nodes.find((n) => n.sessionId === CHILD)!

    async function sendFromCard(text: string) {
      render(<CardPromptBar node={node()} />)
      const input = screen.getByTestId('card-prompt')
      fireEvent.change(input, { target: { value: text } })
      await act(async () => void fireEvent.keyDown(input, { key: 'Enter' }))
    }

    it('filha do dock: a aba nasce antes do envio e o usuário fica onde está', async () => {
      await sendFromCard('segue por aqui')

      await waitFor(() =>
        expect(sendMessage).toHaveBeenCalledWith({ id: handoff.id, text: 'segue por aqui' }),
      )
      expect(tabsAtSend).toEqual([CHILD])
      expect(useAppStore.getState().area).toBe('features')
      expect(useAppStore.getState().focusPaneId).toBeNull()
    })

    // Como a recusa chega do ipcRenderer.invoke: prefixo do canal + erro do main.
    it('envio recusado: o cartão mostra só o motivo', async () => {
      const reason = 'A sessão-filha não está mais viva — não há para onde enviar.'
      sendMessage
        .mockReset()
        .mockRejectedValue(
          new Error(`Error invoking remote method 'handoffs:send-message': Error: ${reason}`),
        )

      await sendFromCard('segue por aqui')

      expect((await screen.findByTestId('card-prompt-notice')).textContent).toBe(reason)
    })

    it('filha com o handoff done (fora do dock) segue filha: abre do mesmo jeito', async () => {
      store.report(handoff.id, 'pronto')
      world = roomWorld(testDb, [
        { id: MOTHER, status: 'idle' },
        { id: CHILD, status: 'idle' },
      ])
      useSessionGraphStore.setState({ graph: world.graph })
      useHandoffsStore.setState({ handoffs: world.handoffs, loading: false })

      await sendFromCard('mais uma coisa')

      await waitFor(() =>
        expect(send).toHaveBeenCalledWith(
          expect.objectContaining({ sessionId: CHILD, text: 'mais uma coisa' }),
        ),
      )
      expect(sendMessage).not.toHaveBeenCalled()
      expect(tabsAtSend).toEqual([CHILD])
      expect(useAppStore.getState().focusPaneId).toBeNull()
    })
  })

  describe('@alias no composer de outra pane', () => {
    it('a aba da filha nasce em segundo plano antes do envio; o foco fica na pane', async () => {
      const { liveSessions } = useAppStore.getState()
      const alias = buildTargets(liveSessions, world.graph.nodes).find(
        (t) => t.sessionId === CHILD,
      )!.alias
      render(<Composer sessionId={MOTHER} onSend={vi.fn()} onInsert={vi.fn()} />)
      const box = screen.getByRole('textbox')
      fireEvent.change(box, { target: { value: `@${alias} roda os testes` } })
      await act(async () => void fireEvent.keyDown(box, { key: 'Enter' }))

      await waitFor(() =>
        expect(send).toHaveBeenCalledWith(
          expect.objectContaining({
            sessionId: CHILD,
            text: 'roda os testes',
            fromSessionId: MOTHER,
          }),
        ),
      )
      expect(tabsAtSend).toEqual([CHILD])
      expect(useAppStore.getState().area).toBe('features')
      expect(useAppStore.getState().focusPaneId).toBeNull()
    })
  })

  describe('QuickComposer', () => {
    async function sendFromQuickComposer(text: string) {
      act(() => useQuickComposerStore.getState().openFor(CHILD))
      render(<QuickComposer />)
      fireEvent.change(screen.getByTestId('quick-input'), { target: { value: text } })
      await act(async () => void fireEvent.click(screen.getByTestId('quick-send')))
    }

    it('aceito: a aba abriu antes do envio, o painel fecha e o usuário vai para ela', async () => {
      await sendFromQuickComposer('segue por aqui')

      await waitFor(() => expect(screen.queryByTestId('quick-composer')).toBeNull())
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: CHILD, text: 'segue por aqui' }),
      )
      expect(tabsAtSend).toEqual([CHILD])
      const pane = useAppStore.getState().panes.find((p) => p.session.id === CHILD)
      expect(useAppStore.getState().area).toBe('projects')
      expect(useAppStore.getState().focusPaneId).toBe(pane?.paneId)
    })

    it('recusado: o painel fica com o motivo e ninguém é levado a lugar nenhum', async () => {
      send.mockReset().mockResolvedValue({ ok: false, error: 'menu-open' })

      await sendFromQuickComposer('segue por aqui')

      expect(await screen.findByTestId('quick-notice')).toBeInTheDocument()
      expect(screen.getByTestId('quick-composer')).toBeInTheDocument()
      expect(tabs()).toEqual([CHILD])
      expect(useAppStore.getState().area).toBe('features')
      expect(useAppStore.getState().focusPaneId).toBeNull()
    })

    it('destino que não é filha: envia sem abrir aba e o painel continua aberto', async () => {
      act(() => useQuickComposerStore.getState().openFor(MOTHER))
      render(<QuickComposer />)
      fireEvent.change(screen.getByTestId('quick-input'), { target: { value: 'status?' } })
      await act(async () => void fireEvent.click(screen.getByTestId('quick-send')))

      await waitFor(() =>
        expect(send).toHaveBeenCalledWith(expect.objectContaining({ sessionId: MOTHER })),
      )
      expect(tabs()).toEqual([])
      expect(screen.getByTestId('quick-composer')).toBeInTheDocument()
    })
  })
})
