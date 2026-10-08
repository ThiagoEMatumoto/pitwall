import Database from 'better-sqlite3'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Ctrl+` → Room. O card de atenção vem da projeção real (handoffStore sobre banco
// migrado + projectAttention), não de um AttentionItem montado à mão.
let testDb: Database.Database
vi.mock('../../../electron/main/services/db', () => ({ getDb: () => testDb }))
vi.mock('../../../electron/main/services/transcript-path', () => ({
  findTranscriptPath: () => null,
}))
vi.mock('@/lib/ipc', () => ({
  sessionGraphApi: { onUpdated: () => () => {}, get: () => new Promise(() => {}) },
}))

const store = await import('../../../electron/main/services/handoff-store')
const { readTransitions, toAttentionLive } =
  await import('../../../electron/main/services/attention/attention-service')
const harness = await import('../../../electron/main/services/attention/attention-test-harness')
const { projectAttention } = await import('../../../shared/attention/project-attention')
const { FeatureSwitcher, FeatureSwitcherButton } = await import('./FeatureSwitcher')
const { useFeatureMruStore } = await import('./feature-mru-store')
const { useMapFocusStore } = await import('./map-focus-store')
const { useProjectsViewStore } = await import('./projects-view-store')
const { useFeatureRoomStore } = await import('@/features/feature-room/feature-room-store')
const { useCrewDockStore } = await import('@/features/handoffs/crew-dock-store')
const { useSessionGraphStore } = await import('@/features/sessions/session-graph-store')
const { useAttentionListStore } = await import('@/store/attentionStore')
const { useAppStore } = await import('@/store/appStore')

type SessionGraph = import('../../../shared/types/session-graph').SessionGraph
type SessionGraphLane = import('../../../shared/types/session-graph').SessionGraphLane
type SessionGraphNode = import('../../../shared/types/session-graph').SessionGraphNode

const lane = (featureId: string): SessionGraphLane => ({
  kind: 'feature',
  featureId,
  projectId: 'p1',
  projectName: 'Proj',
  name: `Feature ${featureId}`,
  color: null,
  pulse: null,
  status: 'in_progress',
  pinned: false,
  repos: [{ repoId: 'r1', label: 'repo', sessionIds: [`s-${featureId}`] }],
})
const looseLane: SessionGraphLane = {
  kind: 'project',
  projectId: 'p1',
  name: 'Proj',
  color: null,
  repos: [{ repoId: 'r1', label: 'repo', sessionIds: ['s-loose'] }],
}
const node = (sessionId: string, featureId: string | null): SessionGraphNode => ({
  sessionId,
  ccSessionId: `cc-${sessionId}`,
  title: sessionId,
  projectId: 'p1',
  repoId: 'r1',
  repoLabel: 'repo',
  provider: 'claude',
  status: 'idle',
  attentionReason: null,
  lastActivityAt: 1,
  purposeHint: null,
  purpose: null,
  purposeSource: null,
  groupId: null,
  lastSummary: null,
  lastSummaryAt: null,
  childOfHandoffId: null,
  featureId,
})
const graphOf = (lanes: SessionGraphLane[]): SessionGraph => ({
  lanes,
  edges: [],
  nodes: lanes.flatMap((l) =>
    l.repos.flatMap((r) =>
      r.sessionIds.map((id) => node(id, l.kind === 'feature' ? l.featureId : null)),
    ),
  ),
})

const ctrlBackquote = () =>
  fireEvent.keyDown(window, { key: '`', code: 'Backquote', ctrlKey: true })
const releaseCtrl = () => fireEvent.keyUp(window, { key: 'Control', code: 'ControlLeft' })
const both = () => (
  <>
    <FeatureSwitcher />
    <FeatureSwitcherButton />
  </>
)

describe('FeatureSwitcher → Room', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    Element.prototype.scrollIntoView = vi.fn()
    localStorage.clear()
    testDb = new Database(':memory:')
    testDb.pragma('foreign_keys = ON')
    harness.applyAllMigrations(testDb)
    harness.seedRepos(testDb)
    useSessionGraphStore.setState({ graph: graphOf([lane('f1'), lane('f2'), looseLane]) })
    useFeatureMruStore.setState({ order: ['f2', 'f1'] })
    useMapFocusStore.setState({ featureId: 'f2', frame: null })
    useAppStore.setState({ area: 'features', liveSessions: [] })
    useFeatureRoomStore.setState({ featureId: null })
    useAttentionListStore.setState({ items: [] })
    useProjectsViewStore.getState().setView('terminals')
  })
  afterEach(() => {
    testDb.close()
    vi.useRealTimers()
  })

  it('combo + card de feature: área room com a feature, MRU tocado, mapa não focado', () => {
    render(both())
    ctrlBackquote()
    releaseCtrl()
    expect(useAppStore.getState().area).toBe('room')
    expect(useFeatureRoomStore.getState().featureId).toBe('f1')
    expect(useFeatureMruStore.getState().order[0]).toBe('f1')
    expect(useMapFocusStore.getState().featureId).toBe('f2')
    expect(useMapFocusStore.getState().frame).toBeNull()
    expect(useProjectsViewStore.getState().view).toBe('terminals')
  })

  it('a mesma entry pelo botão do mapa fica no mapa e foca a feature (OPEN-8)', () => {
    render(both())
    fireEvent.click(screen.getByTestId('map-feature-switcher'))
    fireEvent.click(screen.getAllByRole('option').find((o) => o.dataset.key === 'f1')!)
    expect(useAppStore.getState().area).toBe('projects')
    expect(useProjectsViewStore.getState().view).toBe('map')
    expect(useMapFocusStore.getState().featureId).toBe('f1')
    expect(useMapFocusStore.getState().frame?.featureId).toBe('f1')
    expect(useFeatureRoomStore.getState().featureId).toBeNull()
  })

  it('"Sem feature" pelo combo segue para o mapa', () => {
    render(both())
    ctrlBackquote()
    act(() => void vi.advanceTimersByTime(200))
    fireEvent.click(screen.getAllByRole('option').find((o) => o.dataset.key === 'p:p1')!)
    expect(useAppStore.getState().area).toBe('projects')
    expect(useProjectsViewStore.getState().view).toBe('map')
    expect(useMapFocusStore.getState().frame).toMatchObject({ flowId: 'lane:p:p1' })
    expect(useFeatureRoomStore.getState().featureId).toBeNull()
  })

  it('card de atenção com handoff abre o peek da filha, como antes', () => {
    harness.seedFeature(testDb, 'FX')
    harness.seedSession(testDb, 'K', { repoId: 'r2', featureId: 'FX' })
    const h = store.create({
      targetRepoId: 'r2',
      motherSessionId: 'M',
      featureId: 'FX',
      task: 'sem lane',
      composedPrompt: 'p',
    })
    store.fail(store.markRunning(h.id, 'K').id, 'boom')
    harness.seedSession(testDb, 'M', { repoId: 'r1' })
    // Falha só entra na fila com mãe ou filha de PTY viva: a mãe está viva.
    const live = [
      toAttentionLive(
        { id: 'M', feature_id: null, repo_id: 'r1' },
        { status: 'idle', lastActivityAt: 1_000, name: null },
        null,
        null,
      ),
    ]
    const handoffs = store.list()
    useAttentionListStore.setState({
      items: projectAttention({
        handoffs,
        transitions: readTransitions(testDb, handoffs),
        live,
      }),
    })
    const openPeek = vi.spyOn(useCrewDockStore.getState(), 'openPeek')
    render(both())
    ctrlBackquote()
    act(() => void vi.advanceTimersByTime(200))
    const card = screen.getAllByRole('option').find((o) => o.dataset.kind === 'attention')!
    fireEvent.click(card)
    expect(openPeek).toHaveBeenCalledWith(h.id)
    expect(useAppStore.getState().area).toBe('features')
    expect(useFeatureRoomStore.getState().featureId).toBeNull()
  })

  it('toque rápido a partir da Room vai à feature anterior, não volta à mesma', () => {
    render(both())
    ctrlBackquote()
    releaseCtrl()
    expect(useFeatureRoomStore.getState().featureId).toBe('f1')
    ctrlBackquote()
    releaseCtrl()
    expect(useFeatureRoomStore.getState().featureId).toBe('f2')
  })
  it('dica "Ctrl+` agora abre a Room" só na primeira abertura visível pelo combo', () => {
    render(both())
    // Pelo botão do mapa (não leva à Room): sem dica, e ela não é gasta.
    fireEvent.click(screen.getByTestId('map-feature-switcher'))
    expect(screen.queryByTestId('feature-switcher-room-hint')).toBeNull()
    fireEvent.keyDown(window, { key: 'Escape' })
    // Toque rápido: o overlay nem aparece, a dica continua guardada.
    ctrlBackquote()
    releaseCtrl()
    expect(screen.queryByTestId('feature-switcher-room-hint')).toBeNull()

    ctrlBackquote()
    act(() => void vi.advanceTimersByTime(200))
    expect(screen.getByTestId('feature-switcher-room-hint')).toHaveTextContent(
      'Ctrl+` agora abre a Room da feature',
    )
    fireEvent.keyDown(window, { key: 'Escape' })

    ctrlBackquote()
    act(() => void vi.advanceTimersByTime(200))
    expect(screen.getByTestId('feature-switcher')).toBeInTheDocument()
    expect(screen.queryByTestId('feature-switcher-room-hint')).toBeNull()
  })
})
