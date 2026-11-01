import Database from 'better-sqlite3'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Tela de projeto sobre o grafo que os PRODUTORES montam (handoffStore +
// readSessionGraphInput + projectAttention num banco migrado, via roomWorld) —
// nada de nó montado à mão com hierarchyMotherId inventado.
let testDb: Database.Database
vi.mock('../../../electron/main/services/db', () => ({ getDb: () => testDb }))
vi.mock('../../../electron/main/services/transcript-path', () => ({
  PROJECTS_ROOT: '/nonexistent-projects',
  findTranscriptPath: () => null,
}))
vi.mock('../../../electron/main/services/session-activity', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  buildSessionsFileIndex: () => new Map(),
}))
vi.mock('../../../electron/main/services/live-session-states', () => ({
  liveSessionStates: () => new Map(),
}))
vi.mock('@/lib/ipc', () => ({
  sessionGraphApi: { onUpdated: () => () => {}, get: () => new Promise(() => {}) },
  sessionsApi: {},
  prefsApi: { get: async () => null, set: async () => {} },
}))

const { migrations } = await import('../../../electron/main/services/migrations/index')
const store = await import('../../../electron/main/services/handoff-store')
const { roomWorld } = await import('../../../electron/main/services/attention/room-world')
const { useSessionGraphStore } = await import('@/features/sessions/session-graph-store')
const { useAppStore } = await import('@/store/appStore')
const { ProjectSessionPurposes } = await import('./ProjectSessionPurposes')
const { buildSessionTree, childrenSummary } = await import('./session-hierarchy')
const { focusFilteredSessions, motherTitleBySession } =
  await import('@/features/session-switcher/useGlobalSessions')

function migrate(db: Database.Database): void {
  for (const m of migrations) {
    if (m.disableForeignKeys) db.pragma('foreign_keys = OFF')
    try {
      m.up(db)
    } finally {
      if (m.disableForeignKeys) db.pragma('foreign_keys = ON')
    }
  }
}

let clock = 100
function addSession(id: string, title: string): void {
  clock += 10
  testDb
    .prepare(
      `INSERT INTO repos (id, project_id, label, path, position, created_at)
       VALUES (?, 'p1', ?, ?, 0, 1)`,
    )
    .run(`r-${id}`, `repo-${id}`, `/tmp/${id}`)
  testDb
    .prepare(
      `INSERT INTO sessions (id, repo_id, cc_session_id, title, title_source, status, started_at)
       VALUES (?, ?, ?, ?, 'manual', 'running', ?)`,
    )
    .run(id, `r-${id}`, `cc-${id}`, title, clock)
}

function dispatch(mother: string, child: string): string {
  const h = store.create({
    motherSessionId: mother,
    targetRepoId: `r-${child}`,
    task: `tarefa de ${child}`,
    composedPrompt: 'p',
  })
  store.markRunning(h.id, child)
  return h.id
}

// 2 mães: A com 3 filhas (uma pergunta, uma dispensada há tempo, uma quieta) e B
// sem filhas.
function world() {
  addSession('mae-a', 'Mãe A')
  addSession('mae-b', 'Mãe B')
  addSession('k1', 'Filha quieta')
  addSession('k2', 'Filha perguntando')
  addSession('k3', 'Filha dispensada')
  dispatch('mae-a', 'k1')
  const h2 = dispatch('mae-a', 'k2')
  store.ask(h2, 'Qual branch uso?')
  const h3 = dispatch('mae-a', 'k3')
  store.report(h3, 'feito')
  store.dismiss(h3)
  testDb.prepare('UPDATE handoffs SET updated_at = 1 WHERE id = ?').run(h3)
  const ids = ['mae-a', 'mae-b', 'k1', 'k2', 'k3']
  return roomWorld(
    testDb,
    ids.map((id) => ({ id, status: 'idle' as const })),
  )
}

describe('tela de projeto — mães no topo, filhas aninhadas', () => {
  beforeEach(() => {
    testDb = new Database(':memory:')
    testDb.pragma('foreign_keys = ON')
    migrate(testDb)
    testDb
      .prepare(`INSERT INTO projects (id, name, created_at, updated_at) VALUES ('p1','P',1,1)`)
      .run()
  })
  afterEach(() => testDb.close())

  it('seletor: mães na raiz, filhas (inclusive a dispensada antiga) sob a mãe', () => {
    const { graph } = world()
    const tree = buildSessionTree(graph.nodes, 'p1')
    expect(tree.map((t) => t.sessionId)).toEqual(['mae-a', 'mae-b'])
    const a = tree[0]
    expect(a.children.map((c) => c.sessionId).sort()).toEqual(['k1', 'k2', 'k3'])
    expect(a.children.find((c) => c.sessionId === 'k2')?.needsYou).toBe(true)
    expect(childrenSummary(a)).toBe('3 filhas · 1 precisa de você')
  })

  it('componente: recolhido mostra só a filha que precisa de você, com badge', () => {
    const { graph, live } = world()
    useSessionGraphStore.setState({ graph })
    useAppStore.setState({ liveSessions: live })
    render(<ProjectSessionPurposes projectId="p1" />)

    const rows = () => screen.getAllByTestId('sidebar-session').map((b) => b.dataset.sessionId)
    expect(rows()).toEqual(['mae-a', 'k2', 'mae-b'])
    expect(screen.getByTestId('sidebar-session-children-summary').textContent).toBe(
      '3 filhas · 1 precisa de você',
    )
    const k2 = screen.getAllByTestId('sidebar-session').find((b) => b.dataset.sessionId === 'k2')!
    expect(k2.dataset.needsYou).toBe('true')
    expect(within(k2).getByTestId('sidebar-session-attention')).toBeTruthy()
    const nested = screen.getByTestId('sidebar-session-children')
    expect(within(nested).getAllByTestId('sidebar-session')).toHaveLength(1)

    fireEvent.click(screen.getByTestId('sidebar-session-children-toggle'))
    expect(rows()).toEqual(['mae-a', 'k1', 'k2', 'k3', 'mae-b'])
  })

  it('filtro da barra/seletor: esconde filhas quietas, mantém mães e quem precisa', () => {
    const { graph, live } = world()
    const { items, hiddenCount } = focusFilteredSessions(live, graph.nodes, { enabled: true })
    expect(items.map((s) => s.id).sort()).toEqual(['k2', 'mae-a', 'mae-b'])
    expect(hiddenCount).toBe(2)

    const kept = focusFilteredSessions(live, graph.nodes, {
      enabled: true,
      keepIds: new Set(['k1']),
    })
    expect(kept.items.map((s) => s.id)).toContain('k1')
    expect(focusFilteredSessions(live, graph.nodes, { enabled: false }).hiddenCount).toBe(0)
    expect(motherTitleBySession(graph.nodes).get('k3')).toBe('Mãe A')
  })
})
