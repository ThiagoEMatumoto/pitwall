import Database from 'better-sqlite3'
import { computeAccessibleName } from 'dom-accessibility-api'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Item "Room" da navegação. O badge vem da projeção real (handoffStore sobre banco
// migrado + projectAttention) e é comparado com o "N no box" da TitleBar montada
// sobre o MESMO estado — não com um número montado à mão.
let testDb: Database.Database
vi.mock('../../electron/main/services/db', () => ({ getDb: () => testDb }))
vi.mock('../../electron/main/services/transcript-path', () => ({
  findTranscriptPath: () => null,
}))
vi.mock('@/lib/ipc', () => ({
  sessionGraphApi: { onUpdated: () => () => {}, get: () => new Promise(() => {}) },
  sessionsApi: {},
  windowApi: {
    isMaximized: () => new Promise(() => {}),
    onMaximizeChange: () => () => {},
  },
}))
vi.mock('@/features/titlebar/UsageWidget', () => ({ UsageWidget: () => null }))
vi.mock('@/features/meetings/RecordingPill', () => ({ RecordingPill: () => null }))

const store = await import('../../electron/main/services/handoff-store')
const { readRequestInput, readTransitions, toAttentionLive } =
  await import('../../electron/main/services/attention/attention-service')
const harness = await import('../../electron/main/services/attention/attention-test-harness')
const { projectAttention } = await import('../../shared/attention/project-attention')
const { IconRail } = await import('./IconRail')
const { TitleBar } = await import('@/features/titlebar/TitleBar')
const { FeatureSwitcher, openFeatureSwitcher } =
  await import('@/features/session-canvas/FeatureSwitcher')
const { useFeatureMruStore } = await import('@/features/session-canvas/feature-mru-store')
const { useMapFocusStore } = await import('@/features/session-canvas/map-focus-store')
const { useFeatureRoomStore } = await import('@/features/feature-room/feature-room-store')
const { useRoomPanelStore } = await import('@/features/feature-room/room-panel-store')
const { useSessionGraphStore } = await import('@/features/sessions/session-graph-store')
const { useAttentionListStore } = await import('@/store/attentionStore')
const { useHandoffsStore } = await import('@/store/handoffsStore')
const { useAppStore } = await import('@/store/appStore')

type SessionGraph = import('../../shared/types/session-graph').SessionGraph

const graph: SessionGraph = {
  edges: [],
  lanes: [
    {
      kind: 'feature',
      featureId: 'f1',
      projectId: 'p1',
      projectName: 'Proj',
      name: 'Feature f1',
      color: null,
      pulse: null,
      status: 'in_progress',
      pinned: false,
      repos: [{ repoId: 'r1', label: 'repo', sessionIds: ['s-f1'] }],
    },
  ],
  nodes: [
    {
      sessionId: 's-f1',
      ccSessionId: 'cc-s-f1',
      title: 's-f1',
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
      featureId: 'f1',
    },
  ],
}

// Duas filhas falhadas (feature FX) com a mãe viva: dois itens na fila humana.
function seedFailures() {
  harness.seedFeature(testDb, 'FX')
  harness.seedSession(testDb, 'M', { repoId: 'r1' })
  for (const [child, task] of [
    ['K1', 'um'],
    ['K2', 'dois'],
  ] as const) {
    harness.seedSession(testDb, child, { repoId: 'r2', featureId: 'FX' })
    const h = store.create({
      targetRepoId: 'r2',
      motherSessionId: 'M',
      featureId: 'FX',
      task,
      composedPrompt: 'p',
    })
    store.fail(store.markRunning(h.id, child).id, 'boom')
  }
  const live = [
    toAttentionLive(
      { id: 'M', feature_id: null, repo_id: 'r1' },
      { status: 'idle', lastActivityAt: 1_000, name: null },
      null,
      null,
    ),
  ]
  const handoffs = store.list()
  return projectAttention({
    handoffs,
    transitions: readTransitions(testDb, handoffs),
    ...readRequestInput(),
    live,
  })
}

const titleBarCount = () =>
  screen.queryByTestId('titlebar-attention-badge')?.textContent?.match(/^(\d+)/)?.[1] ?? '0'
const railCount = () => screen.queryByTestId('rail-room-badge')?.textContent ?? '0'

describe('IconRail → Room', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    Element.prototype.scrollIntoView = vi.fn()
    localStorage.clear()
    testDb = new Database(':memory:')
    testDb.pragma('foreign_keys = ON')
    harness.applyAllMigrations(testDb)
    harness.seedRepos(testDb)
    useSessionGraphStore.setState({ graph })
    useFeatureMruStore.setState({ order: [] })
    useMapFocusStore.setState({ featureId: null, frame: null })
    useAppStore.setState({ area: 'overview', liveSessions: [] })
    useFeatureRoomStore.setState({ level: 'all', featureId: null })
    useRoomPanelStore.setState({ open: false, featureFilter: null, focus: null })
    useAttentionListStore.setState({ items: [] })
    useHandoffsStore.setState({ handoffs: [] })
  })
  afterEach(() => {
    testDb.close()
    vi.useRealTimers()
  })

  it('leva à visão de projeto com o painel da Room aberto (a área room fica intocada)', () => {
    useFeatureRoomStore.setState({ level: 'feature', featureId: 'f9' })
    render(<IconRail onOpenSettings={() => {}} />)
    fireEvent.click(screen.getByTestId('rail-room'))
    expect(useAppStore.getState().area).toBe('projects')
    expect(useRoomPanelStore.getState()).toMatchObject({ open: true, featureFilter: null })
    expect(useFeatureRoomStore.getState().featureId).toBe('f9')
  })

  it('sem nenhuma feature conhecida também abre o painel; o seletor filtra o painel na feature', () => {
    render(
      <>
        <IconRail onOpenSettings={() => {}} />
        <FeatureSwitcher />
      </>,
    )
    fireEvent.click(screen.getByTestId('rail-room'))
    expect(useAppStore.getState().area).toBe('projects')
    expect(useRoomPanelStore.getState().open).toBe(true)
    act(() => openFeatureSwitcher())
    const option = screen.getAllByRole('option').find((o) => o.dataset.key === 'f1')!
    fireEvent.click(option)
    expect(useAppStore.getState().area).toBe('projects')
    expect(useRoomPanelStore.getState().featureFilter).toBe('f1')
  })

  it('badge "precisa de você" é o mesmo número da TitleBar, para o mesmo estado', () => {
    const items = seedFailures()
    render(
      <>
        <TitleBar />
        <IconRail onOpenSettings={() => {}} />
      </>,
    )
    expect(railCount()).toBe('0')

    // Projeção com as filhas já no renderer: ambos contam as duas.
    act(() => {
      useHandoffsStore.setState({ handoffs: store.list() })
      useAttentionListStore.setState({ items })
    })
    expect(titleBarCount()).toBe('2')
    expect(railCount()).toBe(titleBarCount())
    // O badge não pode virar o nome do botão: "Room" continua no nome acessível.
    const roomButton = screen.getByTestId('rail-room')
    expect(computeAccessibleName(roomButton)).toBe('Room · 2 precisa de você')

    // Corrida attention:changed antes do handoff:updated: a TitleBar some com o
    // item, e a rail junto (mesma fonte, não uma regra própria).
    act(() => useHandoffsStore.setState({ handoffs: store.list().slice(0, 1) }))
    expect(titleBarCount()).toBe('1')
    expect(railCount()).toBe(titleBarCount())
  })
})
