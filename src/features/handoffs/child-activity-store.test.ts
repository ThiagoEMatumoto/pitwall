import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionLinkPulse } from '../../../shared/types/session-link-pulse'

// Estado pelo caminho real: handoffStore sobre banco migrado, buildSessionGraph,
// o appStore de verdade e o pulso saído do barramento do main (o mesmo singleton
// que handoff_message, a fila de prompts e o SendMessage do transcript usam).
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

// O salto de IPC do pulso (session-graph.ts faz o broadcast, o preload assina por
// janela): quem assina aqui recebe o que o main publica.
const pulseHandlers = new Set<(p: SessionLinkPulse) => void>()
const inert = new Proxy(
  {},
  {
    get: (_t, prop) =>
      typeof prop === 'string' && prop.startsWith('on') ? () => () => {} : () => Promise.resolve(),
  },
)
const sessionGraphBridge = new Proxy(
  {},
  {
    get: (_t, prop) =>
      prop === 'onLinkPulse'
        ? (handler: (p: SessionLinkPulse) => void) => {
            pulseHandlers.add(handler)
            return () => pulseHandlers.delete(handler)
          }
        : Reflect.get(inert, prop),
  },
)
// appStore lê window.api no module-eval: o mock precisa existir antes do import.
Object.assign(window, {
  api: new Proxy({}, { get: (_t, ns) => (ns === 'sessionGraph' ? sessionGraphBridge : inert) }),
})

const store = await import('../../../electron/main/services/handoff-store')
const { buildSessionGraph, readSessionGraphInput } =
  await import('../../../electron/main/services/session-graph')
const harness = await import('../../../electron/main/services/attention/attention-test-harness')
const { emitSessionLinkPulse, onSessionLinkPulse, scanTranscriptForSendMessage } =
  await import('../../../electron/main/services/session-link-pulse')
const { useAppStore } = await import('@/store/appStore')
const { useSessionGraphStore } = await import('@/features/sessions/session-graph-store')
const { useToastStore } = await import('@/features/notifications/toast-store')
const { listenChildActivity, useChildActivityStore } = await import('./child-activity-store')

type LiveSessionState = import('../../../electron/main/services/session-graph').LiveSessionState
type LiveSessionInfo = import('../../../shared/types/ipc').LiveSessionInfo
type Handoff = import('../../../shared/types/ipc').Handoff
type LiveStatus = LiveSessionInfo['status']

onSessionLinkPulse((pulse) => {
  for (const handler of pulseHandlers) handler(structuredClone(pulse))
})

// Ids novos a cada teste: o barramento é singleton e segura o 5º pulso do mesmo
// par dentro de 1s.
let n = 0
let MOTHER = ''
let CHILD = ''

function liveInfo(sessionId: string, status: LiveStatus): LiveSessionInfo {
  return harness.toLiveInfo(testDb, {
    sessionId,
    status,
    screenReason: undefined,
    menuSeq: null,
    lastActivityAt: null,
    featureId: null,
    repoId: 'r1',
  })
}

// O que o renderer tem depois de um refresh: a lista viva e o grafo do main.
function sync(statuses: Record<string, LiveStatus> = { [MOTHER]: 'working', [CHILD]: 'working' }) {
  const states = new Map<string, LiveSessionState>(
    Object.entries(statuses).map(([id, status]) => [
      id,
      { status, lastActivityAt: 1_000, name: null },
    ]),
  )
  useSessionGraphStore.setState({ graph: buildSessionGraph(readSessionGraphInput(testDb, states)) })
  useAppStore.setState({
    liveSessions: Object.entries(statuses).map(([id, status]) => liveInfo(id, status)),
  })
}

const unread = () => useChildActivityStore.getState().unread
const toasts = () => useToastStore.getState().toasts
const openTab = (sessionId: string) =>
  useAppStore
    .getState()
    .focusOrOpenSession(useAppStore.getState().liveSessions.find((s) => s.id === sessionId)!)

// handoff_message da mãe (mcp/tools.ts): o pulso sai sem `by`.
const motherMessages = () =>
  emitSessionLinkPulse({ fromSessionId: MOTHER, toSessionId: CHILD, kind: 'message' })

describe('child-activity-store', () => {
  let handoff: Handoff
  let stop: () => void

  beforeEach(() => {
    n++
    MOTHER = `M${n}`
    CHILD = `C${n}`
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
    useAppStore.setState({ panes: [], area: 'features', focusPaneId: null })
    useToastStore.setState({ toasts: [] })
    useChildActivityStore.setState({ unread: {} })
    sync()
    stop = listenChildActivity()
  })
  afterEach(() => {
    stop()
    testDb.close()
  })

  describe('mensagem da mãe', () => {
    it('filha sem aba: marca não lida e avisa, sem abrir aba nem mudar o foco', () => {
      motherMessages()

      expect(unread()).toEqual({ [CHILD]: 'message' })
      expect(toasts()).toHaveLength(1)
      expect(toasts()[0].actionLabel).toBe('Abrir')
      expect(useAppStore.getState().panes).toEqual([])
      expect(useAppStore.getState().area).toBe('features')
      expect(useAppStore.getState().focusPaneId).toBeNull()
    })

    it('"Abrir" do aviso leva à aba da filha e a marca some', async () => {
      motherMessages()

      toasts()[0].onAction?.()
      await vi.waitFor(() => expect(useAppStore.getState().area).toBe('projects'))

      const [pane] = useAppStore.getState().panes
      expect(pane.session.id).toBe(CHILD)
      expect(useAppStore.getState().focusPaneId).toBe(pane.paneId)
      expect(unread()).toEqual({})
    })

    it('filha com aba aberta: não marca nem avisa', async () => {
      await openTab(CHILD)

      motherMessages()

      expect(unread()).toEqual({})
      expect(toasts()).toEqual([])
    })

    it('resposta da mãe a um pedido da filha também marca', () => {
      emitSessionLinkPulse({ fromSessionId: MOTHER, toSessionId: CHILD, kind: 'answer' })

      expect(unread()).toEqual({ [CHILD]: 'message' })
      expect(toasts()).toHaveLength(1)
    })

    it('segunda mensagem com a primeira ainda não lida: um aviso só', () => {
      motherMessages()
      motherMessages()

      expect(toasts()).toHaveLength(1)
    })

    it('SendMessage da mãe lido do transcript (linha real da CLI) marca a filha', () => {
      const alias = 'otavio-fazer-lia-responder'
      const line = readFileSync(
        join(__dirname, '../../../shared/tui/__fixtures__/claude-2.1.286-send-message.jsonl'),
        'utf8',
      )
        .split('\n')
        .find((l) => l.includes(alias))!
      const call = JSON.parse(line)
      call.message.content[0].id = `toolu_unread_${n}`
      testDb.prepare('UPDATE sessions SET title = ? WHERE id = ?').run(alias, CHILD)
      const { cc } = testDb
        .prepare('SELECT cc_session_id AS cc FROM sessions WHERE id = ?')
        .get(MOTHER) as { cc: string }

      // Baseline sem chamada, depois a chamada nova (como a releitura do tail).
      scanTranscriptForSendMessage(cc, '{"type":"user","message":{"content":"oi"}}', new Map())
      scanTranscriptForSendMessage(cc, JSON.stringify(call), new Map())

      expect(unread()).toEqual({ [CHILD]: 'message' })
      expect(toasts()).toHaveLength(1)
    })
  })

  describe('o que não é mensagem da mãe', () => {
    it('envio do usuário pela pane da mãe (QuickComposer, @filha) não vira não lida', () => {
      // O pulso que sessions:send-prompt produz com fromSessionId = a mãe.
      emitSessionLinkPulse({
        fromSessionId: MOTHER,
        toSessionId: CHILD,
        kind: 'message',
        by: 'human',
      })

      expect(unread()).toEqual({})
      expect(toasts()).toEqual([])
    })

    it('despacho da tarefa e nota do bastão não avisam', () => {
      emitSessionLinkPulse({ fromSessionId: MOTHER, toSessionId: CHILD, kind: 'task' })
      emitSessionLinkPulse({ fromSessionId: MOTHER, toSessionId: CHILD, kind: 'note' })

      expect(unread()).toEqual({})
      expect(toasts()).toEqual([])
    })

    it('pulso da filha para a mãe não marca ninguém', () => {
      emitSessionLinkPulse({ fromSessionId: CHILD, toSessionId: MOTHER, kind: 'report' })
      emitSessionLinkPulse({ fromSessionId: CHILD, toSessionId: MOTHER, kind: 'message' })

      expect(unread()).toEqual({})
      expect(toasts()).toEqual([])
    })

    it('mensagem de quem não é a mãe dela não avisa', () => {
      const other = `O${n}`
      harness.seedSession(testDb, other)
      sync({ [MOTHER]: 'working', [CHILD]: 'working', [other]: 'working' })

      emitSessionLinkPulse({ fromSessionId: other, toSessionId: CHILD, kind: 'message' })

      expect(unread()).toEqual({})
      expect(toasts()).toEqual([])
    })

    it('depois do Desvincular ela é sessão comum: não marca', () => {
      store.release(handoff.id)
      sync()

      motherMessages()

      expect(unread()).toEqual({})
      expect(toasts()).toEqual([])
    })
  })

  describe('reserva: a filha voltou a trabalhar sem pulso que explique', () => {
    it('ociosa → trabalhando em segundo plano marca, sem aviso', () => {
      sync({ [MOTHER]: 'working', [CHILD]: 'idle' })
      sync({ [MOTHER]: 'working', [CHILD]: 'working' })

      expect(unread()).toEqual({ [CHILD]: 'activity' })
      expect(toasts()).toEqual([])
    })

    it('o pulso da mãe que chega depois ainda avisa', () => {
      sync({ [MOTHER]: 'working', [CHILD]: 'idle' })
      sync({ [MOTHER]: 'working', [CHILD]: 'working' })

      motherMessages()

      expect(unread()).toEqual({ [CHILD]: 'message' })
      expect(toasts()).toHaveLength(1)
    })

    it('não rebaixa a mensagem não lida para atividade', () => {
      sync({ [MOTHER]: 'working', [CHILD]: 'idle' })
      motherMessages()

      sync({ [MOTHER]: 'working', [CHILD]: 'working' })

      expect(unread()).toEqual({ [CHILD]: 'message' })
    })

    it('aguardando você → trabalhando não marca: quem respondeu o menu foi o usuário', () => {
      sync({ [MOTHER]: 'working', [CHILD]: 'waiting' })
      sync({ [MOTHER]: 'working', [CHILD]: 'working' })

      expect(unread()).toEqual({})
    })

    it('com aba aberta não marca', async () => {
      sync({ [MOTHER]: 'working', [CHILD]: 'idle' })
      await openTab(CHILD)

      sync({ [MOTHER]: 'working', [CHILD]: 'working' })

      expect(unread()).toEqual({})
    })

    it('a mãe voltando a trabalhar não marca', () => {
      sync({ [MOTHER]: 'idle', [CHILD]: 'working' })
      sync({ [MOTHER]: 'working', [CHILD]: 'working' })

      expect(unread()).toEqual({})
    })
  })

  describe('a marca some', () => {
    it('quando a aba da filha abre por qualquer caminho', async () => {
      motherMessages()

      await openTab(CHILD)

      expect(unread()).toEqual({})
    })

    it('quando o processo dela morre', () => {
      motherMessages()

      sync({ [MOTHER]: 'working' })

      expect(unread()).toEqual({})
    })

    it('quando ela é desvinculada', () => {
      motherMessages()

      store.release(handoff.id)
      sync()

      expect(unread()).toEqual({})
    })

    it('e fica enquanto ela segue em segundo plano', () => {
      motherMessages()

      sync({ [MOTHER]: 'idle', [CHILD]: 'idle' })

      expect(unread()).toEqual({ [CHILD]: 'message' })
    })
  })
})
