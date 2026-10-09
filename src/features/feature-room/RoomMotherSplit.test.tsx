import { useState } from 'react'
import Database from 'better-sqlite3'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Split da sala: as mães saem do buildRoomView sobre o estado dos produtores
// (roomWorld). O Terminal é dublê: o que o split decide são as props dele.
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
const terminals = vi.hoisted(() => new Map<string, Record<string, unknown>>())
vi.mock('@/features/sessions/Terminal', () => ({
  Terminal: (props: Record<string, unknown> & { session: { id: string } }) => {
    terminals.set(props.session.id, props)
    return <div data-testid="terminal-mock" data-mode={String(props.mode)} />
  },
}))
vi.mock('@/features/session-canvas/MotherDock', () => ({
  SWITCH_DEBOUNCE_MS: 0,
  useSettled: <T,>(v: T) => v,
}))

vi.stubGlobal(
  'window',
  Object.assign(window, {
    api: new Proxy(
      {},
      {
        get: () =>
          new Proxy(
            {},
            {
              get: (_n, m: string) =>
                m.startsWith('on') ? () => () => {} : () => new Promise(() => {}),
            },
          ),
      },
    ),
  }),
)

const harness = await import('../../../electron/main/services/attention/attention-test-harness')
const { roomWorld } = await import('../../../electron/main/services/attention/room-world')
const { buildRoomView } = await import('./room-model')
const { RoomMotherSplit, MAX_SPLIT } = await import('./RoomMotherSplit')
const { useAppStore } = await import('@/store/appStore')

type RoomMotherTab = import('./room-model').RoomMotherTab

const F = 'F'

function mothersOf(ids: string[]): RoomMotherTab[] {
  ids.forEach((id, i) =>
    harness.seedSession(testDb, id, { repoId: `r${(i % 6) + 1}`, featureId: F }),
  )
  const w = roomWorld(
    testDb,
    ids.map((id) => ({ id, status: 'idle' as const })),
  )
  useAppStore.setState({ liveSessions: w.live })
  const inUse = new Set(w.graph.nodes.map((n) => n.sessionId))
  return buildRoomView({
    featureId: F,
    graph: w.graph,
    handoffs: w.handoffs,
    live: w.live,
    attention: w.attention,
    inUse,
    timeline: [],
    timelineFilter: null,
  }).mothers
}

function Harness({ mothers }: { mothers: RoomMotherTab[] }) {
  const [active, setActive] = useState(mothers[0].sessionId)
  return (
    <RoomMotherSplit mothers={mothers} activeId={active} onActivate={setActive} onPeek={() => {}} />
  )
}

const cols = () => screen.getAllByTestId('room-mother')
const modeOf = (id: string) => terminals.get(id)?.mode
const ctrlDot = () => fireEvent.keyDown(window, { key: '.', ctrlKey: true })

describe('RoomMotherSplit', () => {
  beforeEach(() => {
    testDb = new Database(':memory:')
    testDb.pragma('foreign_keys = ON')
    harness.applyAllMigrations(testDb)
    harness.seedRepos(testDb)
    harness.seedFeature(testDb, F)
    terminals.clear()
  })
  afterEach(() => testDb.close())

  it('2 mães → 2 colunas em chat com lease room; um terminal por vez', () => {
    const mothers = mothersOf(['A', 'B'])
    render(<Harness mothers={mothers} />)
    expect(cols()).toHaveLength(2)
    const [a, b] = mothers.map((m) => m.sessionId)
    expect(modeOf(a)).toBe('chat')
    expect(modeOf(b)).toBe('chat')
    expect(terminals.get(a)?.leaseHost).toBe('room')
    expect(terminals.get(b)?.leaseHost).toBe('room')

    const colB = cols().find((c) => c.dataset.sessionId === b)!
    fireEvent.click(colB.querySelector('[data-testid="room-mother-mode-terminal"]')!)
    expect(modeOf(b)).toBe('terminal')
    expect(modeOf(a)).toBe('chat')

    const colA = cols().find((c) => c.dataset.sessionId === a)!
    fireEvent.click(colA.querySelector('[data-testid="room-mother-mode-terminal"]')!)
    expect(modeOf(a)).toBe('terminal')
    expect(modeOf(b)).toBe('chat')
    expect([...terminals.values()].filter((p) => p.mode === 'terminal')).toHaveLength(1)
  })

  it(`4 mães → ${MAX_SPLIT} colunas + 1 botão de overflow que troca com a ativa`, async () => {
    const mothers = mothersOf(['A', 'B', 'C', 'D'])
    render(<Harness mothers={mothers} />)
    expect(cols()).toHaveLength(MAX_SPLIT)
    const extra = screen.getAllByTestId('room-mother-tab')
    expect(extra).toHaveLength(1)
    const outId = extra[0].dataset.sessionId!
    const activeBefore = cols().find((c) => c.getAttribute('aria-current') === 'true')!
    const activeId = activeBefore.dataset.sessionId!
    const slot = cols().indexOf(activeBefore)
    act(() => void fireEvent.click(extra[0]))
    await waitFor(() => expect(cols()[slot].dataset.sessionId).toBe(outId))
    expect(cols()[slot]).toHaveAttribute('aria-current', 'true')
    expect(screen.getAllByTestId('room-mother-tab')[0].dataset.sessionId).toBe(activeId)
    expect(cols()).toHaveLength(MAX_SPLIT)
  })

  it('Ctrl+. alterna só a coluna ativa', () => {
    const mothers = mothersOf(['A', 'B'])
    render(<Harness mothers={mothers} />)
    const [a, b] = mothers.map((m) => m.sessionId)
    fireEvent.mouseDown(cols().find((c) => c.dataset.sessionId === b)!)
    act(() => void ctrlDot())
    expect(modeOf(b)).toBe('terminal')
    expect(modeOf(a)).toBe('chat')
    act(() => void ctrlDot())
    expect(modeOf(b)).toBe('chat')
  })
})
