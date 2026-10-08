import Database from 'better-sqlite3'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OverviewCounts } from '../../../shared/types/ipc'

// O "N no box" da Home é o mesmo da TitleBar: a fila única, produzida pelo caminho
// real (handoffStore sobre banco migrado + projectAttention). Nada montado à mão.
let testDb: Database.Database
vi.mock('../../../electron/main/services/db', () => ({ getDb: () => testDb }))
let transcriptPath: string | null = null
vi.mock('../../../electron/main/services/transcript-path', () => ({
  findTranscriptPath: () => transcriptPath,
}))
vi.mock('../../../electron/main/services/session-activity', () => ({
  buildSessionsFileIndex: () => new Map(),
}))
vi.mock('../../../electron/main/services/live-session-states', () => ({
  liveSessionStates: () => new Map(),
}))
vi.stubGlobal(
  'window',
  Object.assign(window, {
    api: new Proxy({}, { get: () => new Proxy({}, { get: () => () => undefined }) }),
  }),
)

const store = await import('../../../electron/main/services/handoff-store')
const { readRequestInput, readTransitions, toAttentionLive } =
  await import('../../../electron/main/services/attention/attention-service')
const harness = await import('../../../electron/main/services/attention/attention-test-harness')
const { projectAttention } = await import('../../../shared/attention/project-attention')
const { attentionCount } = await import('@/features/session-switcher/attention-queue')
const { getAttentionQueue } = await import('@/features/session-switcher/useAttentionQueue')
const { HomeHero } = await import('./HomeHero')
const { SessionsCard } = await import('./SessionsCard')
const { useAppStore } = await import('@/store/appStore')
const { useHandoffsStore } = await import('@/store/handoffsStore')
const { useAttentionListStore } = await import('@/store/attentionStore')

type LiveStatus = import('../../../shared/tui/attention-reason').LiveStatus
type ScreenScan = import('../../../shared/tui/attention-reason').ScreenScan

function child(repo: string, sid: string) {
  harness.seedSession(testDb, sid, { repoId: repo, featureId: 'F' })
  const h = store.create({
    targetRepoId: repo,
    motherSessionId: 'M',
    featureId: 'F',
    task: `task ${sid}`,
    composedPrompt: 'p',
  })
  return store.markRunning(h.id, sid)
}

// Publica nos stores do renderer o que o main publicaria (attention:list etc.).
function publish(lives: Array<{ id: string; status: LiveStatus; scan: ScreenScan | null }>) {
  const live = lives.map((l) => {
    const row = testDb
      .prepare('SELECT id, feature_id, repo_id FROM sessions WHERE id = ?')
      .get(l.id) as { id: string; feature_id: string | null; repo_id: string | null }
    return toAttentionLive(
      row,
      { status: l.status, lastActivityAt: 1_000, name: null },
      l.scan,
      l.scan?.menu ? 1 : null,
    )
  })
  const handoffs = store.list()
  const items = projectAttention({
    handoffs,
    transitions: readTransitions(testDb, handoffs),
    live,
    ...readRequestInput(),
  })
  useAppStore.setState({ liveSessions: live.map((s) => harness.toLiveInfo(testDb, s)), panes: [] })
  useHandoffsStore.setState({ handoffs })
  useAttentionListStore.setState({ items })
}

const hero = () => render(<HomeHero counts={{} as OverviewCounts} onRefresh={() => {}} />)
const inBox = () => screen.getByTestId('home-in-box').textContent

describe('Home — "no box" é a fila única (o número da TitleBar)', () => {
  beforeEach(() => {
    testDb = new Database(':memory:')
    testDb.pragma('foreign_keys = ON')
    harness.applyAllMigrations(testDb)
    harness.seedRepos(testDb)
    harness.seedFeature(testDb, 'F')
    harness.seedSession(testDb, 'M', { repoId: 'r6', featureId: 'F' })
    transcriptPath = null
  })
  afterEach(() => {
    cleanup()
    testDb.close()
  })

  it('filha interrupted-retomável sem PTY conta (antes: "0 no box" com a TitleBar em 1)', () => {
    const h = child('r1', 'A')
    store.failIfRunning(h.id, 'PTY morreu')
    transcriptPath = '/tmp/a.jsonl'
    publish([])
    hero()
    expect(attentionCount(getAttentionQueue())).toBe(1)
    expect(inBox()).toContain('1 no box')
    expect(screen.getByTestId('home-in-box')).toHaveAttribute('data-highlight', 'true')
  })

  it('filha com menu de permissão na tela conta; fim de turno não; o card de sessões segue sem a equipe', async () => {
    child('r1', 'A')
    child('r2', 'B')
    const permission = await harness.scanFixture('permission-bash')
    const idle = await harness.scanFixture('idle-prompt')
    publish([
      { id: 'A', status: 'waiting', scan: permission },
      { id: 'B', status: 'waiting', scan: idle },
    ])
    render(
      <>
        <HomeHero counts={{} as OverviewCounts} onRefresh={() => {}} />
        <SessionsCard />
      </>,
    )
    expect(attentionCount(getAttentionQueue())).toBe(1)
    expect(inBox()).toContain('1 no box')
    expect(screen.getByText('Nenhuma sessão viva.')).toBeInTheDocument()
  })

  it('fila vazia: sem destaque e garagem tranquila', () => {
    child('r1', 'A')
    publish([{ id: 'A', status: 'working', scan: null }])
    hero()
    expect(inBox()).toContain('0 no box')
    expect(screen.getByTestId('home-in-box')).not.toHaveAttribute('data-highlight')
  })
})
