import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Estado pelo caminho real: handoffStore sobre banco migrado, buildSessionGraph
// (é dele o hierarchyMotherId que diz "é filha") e o appStore de verdade.
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

// appStore lê window.api no module-eval: o mock precisa existir antes do import.
Object.assign(window, {
  api: new Proxy(
    {},
    {
      get: () =>
        new Proxy(
          {},
          {
            get: (_t, prop) =>
              typeof prop === 'string' && prop.startsWith('on')
                ? () => () => {}
                : () => Promise.resolve(),
          },
        ),
    },
  ),
})

const store = await import('../../../electron/main/services/handoff-store')
const { buildSessionGraph, readSessionGraphInput } =
  await import('../../../electron/main/services/session-graph')
const harness = await import('../../../electron/main/services/attention/attention-test-harness')
const { useAppStore } = await import('@/store/appStore')
const { useSessionGraphStore } = await import('@/features/sessions/session-graph-store')
const { revealChildOnUserMessage } = await import('./reveal-child')

type LiveSessionState = import('../../../electron/main/services/session-graph').LiveSessionState
type LiveSessionInfo = import('../../../shared/types/ipc').LiveSessionInfo
type Handoff = import('../../../shared/types/ipc').Handoff

const MOTHER = 'M'
const CHILD = 'C'

function liveInfo(sessionId: string): LiveSessionInfo {
  return harness.toLiveInfo(testDb, {
    sessionId,
    status: 'working',
    screenReason: undefined,
    menuSeq: null,
    lastActivityAt: null,
    featureId: null,
    repoId: 'r1',
  })
}

// O que o renderer tem depois de um refresh: a lista viva e o grafo do main.
function sync(alive: string[] = [MOTHER, CHILD]): void {
  const states = new Map<string, LiveSessionState>(
    alive.map((id) => [id, { status: 'working', lastActivityAt: 1_000, name: null }]),
  )
  useSessionGraphStore.setState({ graph: buildSessionGraph(readSessionGraphInput(testDb, states)) })
  useAppStore.setState({ liveSessions: alive.map(liveInfo) })
}

function panesOf(sessionId: string) {
  return useAppStore.getState().panes.filter((p) => p.session.id === sessionId)
}

describe('revealChildOnUserMessage', () => {
  let handoff: Handoff

  beforeEach(() => {
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
    sync()
  })
  afterEach(() => testDb.close())

  it('filha viva sem aba: abre a aba e leva o usuário até ela', async () => {
    const opened = await revealChildOnUserMessage(CHILD, { focus: true })

    const [pane] = panesOf(CHILD)
    expect(pane).toBeDefined()
    expect(opened?.id).toBe(CHILD)
    expect(useAppStore.getState().area).toBe('projects')
    expect(useAppStore.getState().focusPaneId).toBe(pane.paneId)
  })

  it('sem foco: a aba nasce e o usuário fica onde estava', async () => {
    await revealChildOnUserMessage(CHILD, { focus: false })

    expect(panesOf(CHILD)).toHaveLength(1)
    expect(useAppStore.getState().area).toBe('features')
    expect(useAppStore.getState().focusPaneId).toBeNull()
  })

  it('filha que já tem aba: nada muda, nem o foco', async () => {
    await revealChildOnUserMessage(CHILD, { focus: true })
    const before = useAppStore.getState().panes
    useAppStore.setState({ area: 'features', focusPaneId: null })

    const opened = await revealChildOnUserMessage(CHILD, { focus: true })

    expect(opened).toBeNull()
    expect(useAppStore.getState().panes).toBe(before)
    expect(useAppStore.getState().area).toBe('features')
    expect(useAppStore.getState().focusPaneId).toBeNull()
  })

  it('handoff done não desvincula: a filha ainda viva abre do mesmo jeito', async () => {
    store.report(handoff.id, 'pronto')
    sync()

    await revealChildOnUserMessage(CHILD, { focus: true })

    expect(panesOf(CHILD)).toHaveLength(1)
  })

  it('sessão que não é filha segue recebendo a mensagem sem abrir aba', async () => {
    await revealChildOnUserMessage(MOTHER, { focus: true })

    expect(useAppStore.getState().panes).toEqual([])
    expect(useAppStore.getState().area).toBe('features')
  })

  it('depois do Desvincular ela é sessão comum: não abre', async () => {
    store.release(handoff.id)
    sync()

    await revealChildOnUserMessage(CHILD, { focus: true })

    expect(useAppStore.getState().panes).toEqual([])
  })

  it('filha sem processo vivo: não cria aba de sessão morta', async () => {
    sync([MOTHER])

    await revealChildOnUserMessage(CHILD, { focus: true })

    expect(useAppStore.getState().panes).toEqual([])
  })

  it('destino desconhecido (item sem sessão): não faz nada', async () => {
    await revealChildOnUserMessage(null, { focus: true })

    expect(useAppStore.getState().panes).toEqual([])
  })
})
