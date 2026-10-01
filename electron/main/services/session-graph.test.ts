import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { migrations } from './migrations/index'
import type { SessionGraphEdge } from '../../../shared/types/session-graph'

// Os handoffs saem do handoff-store REAL (o produtor de produção), que usa getDb.
let testDb: Database.Database
vi.mock('./db', () => ({ getDb: () => testDb }))
vi.mock('./transcript-path', () => ({ findTranscriptPath: () => null }))

import * as handoffStore from './handoff-store'
import {
  buildSessionGraph,
  readSessionGraphInput,
  TERMINAL_HANDOFF_WINDOW_MS,
  TERMINAL_HANDOFFS_PER_MOTHER,
  type LiveSessionState,
} from './session-graph'

function applyAllMigrations(db: Database.Database): void {
  for (const m of migrations) {
    if (m.disableForeignKeys) {
      db.pragma('foreign_keys = OFF')
      try {
        m.up(db)
      } finally {
        db.pragma('foreign_keys = ON')
      }
    } else {
      m.up(db)
    }
  }
}

let clock = 1_000

function seedBase(db: Database.Database): void {
  db.prepare(
    `INSERT INTO projects (id, name, color, position, created_at, updated_at)
     VALUES ('p1','Plataforma','#f00',0,1,1), ('p2','Site',NULL,1,1,1)`,
  ).run()
  db.prepare(
    `INSERT INTO repos (id, project_id, label, path, position, created_at) VALUES
       ('r-web','p1','web','/tmp/web',1,1),
       ('r-api','p1','api-core','/tmp/api',0,1),
       ('r-site','p2','site','/tmp/site',0,1)`,
  ).run()
}

function addSession(
  id: string,
  repoId: string | null,
  opts: { title?: string; titleSource?: 'manual' | 'auto'; featureId?: string } = {},
): void {
  clock += 10
  testDb
    .prepare(
      `INSERT INTO sessions (id, repo_id, cc_session_id, title, title_source, status, started_at, feature_id)
       VALUES (?, ?, ?, ?, ?, 'running', ?, ?)`,
    )
    .run(
      id,
      repoId,
      `cc-${id}`,
      opts.title ?? null,
      opts.titleSource ?? null,
      clock,
      opts.featureId ?? null,
    )
}

function dispatch(motherId: string, childId: string, task: string, repoId = 'r-api'): string {
  const h = handoffStore.create({
    motherSessionId: motherId,
    targetRepoId: repoId,
    task,
    composedPrompt: task,
  })
  handoffStore.markRunning(h.id, childId)
  return h.id
}

// Mesma sequência do baton:pass (ipc/baton.ts): carimba a antecessora ANTES do
// relink, e o markRunning aponta child_session_id pra sucessora.
function passBaton(handoffId: string, predecessorId: string, successorId: string): void {
  testDb
    .prepare('UPDATE handoffs SET predecessor_session_id = ? WHERE id = ?')
    .run(predecessorId, handoffId)
  handoffStore.markRunning(handoffId, successorId)
}

function live(entries: Record<string, Partial<LiveSessionState>>): Map<string, LiveSessionState> {
  return new Map(
    Object.entries(entries).map(([id, s]) => [
      id,
      { status: 'idle', lastActivityAt: 5_000, name: null, ...s },
    ]),
  )
}

function graphFor(liveMap: Map<string, LiveSessionState>) {
  return buildSessionGraph(readSessionGraphInput(testDb, liveMap))
}

function edgesOf<K extends SessionGraphEdge['kind']>(
  edges: SessionGraphEdge[],
  kind: K,
): Extract<SessionGraphEdge, { kind: K }>[] {
  return edges.filter((e): e is Extract<SessionGraphEdge, { kind: K }> => e.kind === kind)
}

describe('session-graph', () => {
  beforeEach(() => {
    testDb = new Database(':memory:')
    testDb.pragma('foreign_keys = ON')
    applyAllMigrations(testDb)
    seedBase(testDb)
  })

  afterEach(() => {
    testDb.close()
  })

  it('mãe com 2 filhas: fios mãe→filha na ordem do despacho, com tarefa e passo', () => {
    addSession('mother', 'r-web', { title: 'orquestra', titleSource: 'manual' })
    addSession('kid-a', 'r-api', { title: 'mauricio-auth', titleSource: 'manual' })
    addSession('kid-b', 'r-api', { title: 'otavio-perf', titleSource: 'manual' })
    const ha = dispatch('mother', 'kid-a', 'Refatorar auth')
    const hb = dispatch('mother', 'kid-b', 'Investigar lentidão')
    handoffStore.progress(hb, 'lendo o planner')

    const g = graphFor(live({ mother: {}, 'kid-a': {}, 'kid-b': { status: 'working' } }))

    const handoffs = edgesOf(g.edges, 'handoff')
    expect(handoffs.map((e) => [e.from, e.to, e.handoffId])).toEqual([
      ['mother', 'kid-a', ha],
      ['mother', 'kid-b', hb],
    ])
    expect(handoffs[1]).toMatchObject({ handoffStatus: 'running', currentStep: 'lendo o planner' })
    const kidB = g.nodes.find((n) => n.sessionId === 'kid-b')
    expect(kidB).toMatchObject({
      title: 'otavio-perf',
      purposeHint: 'Investigar lentidão',
      childOfHandoffId: hb,
      status: 'working',
      repoLabel: 'api-core',
      projectId: 'p1',
      provider: 'claude',
    })
    expect(g.nodes.find((n) => n.sessionId === 'mother')?.purposeHint).toBeNull()
  })

  it('bastão: antecessora → sucessora no mesmo handoff; a mãe passa a apontar pra sucessora', () => {
    addSession('mother', 'r-web')
    addSession('old', 'r-api', { title: 'mauricio-auth', titleSource: 'manual' })
    addSession('new', 'r-api', { title: 'renata-auth', titleSource: 'manual' })
    const h = dispatch('mother', 'old', 'Refatorar auth')
    passBaton(h, 'old', 'new')

    expect(handoffStore.get(h)?.predecessorSessionId).toBe('old')

    const g = graphFor(live({ mother: {}, old: {}, new: {} }))
    expect(edgesOf(g.edges, 'baton')).toEqual([
      { kind: 'baton', from: 'old', to: 'new', handoffId: h },
    ])
    expect(edgesOf(g.edges, 'handoff').map((e) => [e.from, e.to])).toEqual([['mother', 'new']])
    // A antecessora continua no grafo (viva), mas já não é filha de ninguém.
    expect(g.nodes.find((n) => n.sessionId === 'old')?.childOfHandoffId).toBeNull()
    expect(g.nodes.find((n) => n.sessionId === 'new')?.childOfHandoffId).toBe(h)
  })

  it('antecessora viva que passou o bastão mantém a tarefa original como propósito', () => {
    addSession('mother', 'r-web')
    addSession('old', 'r-api')
    addSession('new', 'r-api')
    const h = dispatch('mother', 'old', 'Refatorar auth')
    passBaton(h, 'old', 'new')

    const asked: string[] = []
    const g = buildSessionGraph(
      readSessionGraphInput(testDb, live({ mother: {}, old: {}, new: {} }), Date.now(), (cc) => {
        asked.push(cc)
        return null
      }),
    )
    const node = (id: string) => g.nodes.find((n) => n.sessionId === id)!
    expect([node('old').purpose, node('old').purposeSource]).toEqual(['Refatorar auth', 'handoff'])
    expect([node('new').purpose, node('new').purposeSource]).toEqual(['Refatorar auth', 'handoff'])
    // Nenhuma das duas paga leitura de transcript.
    expect(asked).toEqual(['cc-mother'])
  })

  it('sessão readotada por outra mãe: só a mãe do handoff atual, coerente com o nó', () => {
    addSession('old-mother', 'r-web')
    addSession('new-mother', 'r-web')
    addSession('kid', 'r-api')
    const first = dispatch('old-mother', 'kid', 'Tarefa antiga')
    testDb.prepare("UPDATE handoffs SET status = 'done', created_at = 1 WHERE id = ?").run(first)
    const second = dispatch('new-mother', 'kid', 'Tarefa nova')
    testDb.prepare('UPDATE handoffs SET created_at = 2 WHERE id = ?').run(second)

    const g = graphFor(live({ 'old-mother': {}, 'new-mother': {}, kid: {} }))
    expect(edgesOf(g.edges, 'handoff').map((e) => [e.from, e.to, e.handoffId])).toEqual([
      ['new-mother', 'kid', second],
    ])
    expect(g.nodes.find((n) => n.sessionId === 'kid')).toMatchObject({
      childOfHandoffId: second,
      purposeHint: 'Tarefa nova',
    })
  })

  it('a antecessora encerrada ainda aparece (é referenciada pelo handoff), como ended', () => {
    addSession('mother', 'r-web')
    addSession('old', 'r-api')
    addSession('new', 'r-api')
    const h = dispatch('mother', 'old', 't')
    passBaton(h, 'old', 'new')

    const g = graphFor(live({ mother: {}, new: {} }))
    expect(g.nodes.find((n) => n.sessionId === 'old')?.status).toBe('ended')
    expect(edgesOf(g.edges, 'baton')).toHaveLength(1)
  })

  it('repoDep: um fio por par de repos, agregando kinds e só sessões vivas', () => {
    addSession('w1', 'r-web')
    addSession('w2', 'r-web')
    addSession('a1', 'r-api')
    addSession('a-dead', 'r-api')
    addSession('s1', 'r-site')
    const dep = testDb.prepare(
      `INSERT INTO repo_dependencies (id, from_repo_id, to_repo_id, kind, created_at)
       VALUES (?, ?, ?, ?, 1)`,
    )
    dep.run('d1', 'r-web', 'r-api', 'calls-api')
    dep.run('d2', 'r-web', 'r-api', 'shares-types')
    // site não tem sessão viva no outro lado desta dependência → sem fio.
    dep.run('d3', 'r-api', 'r-site', 'deploys-to')

    // a-dead não está no mapa vivo e nem é referenciada: nem vira nó.
    const g = graphFor(live({ w1: {}, w2: {}, a1: {} }))

    expect(edgesOf(g.edges, 'repoDep')).toEqual([
      {
        kind: 'repoDep',
        fromRepoId: 'r-web',
        toRepoId: 'r-api',
        depKinds: ['calls-api', 'shares-types'],
        fromSessionIds: ['w1', 'w2'],
        toSessionIds: ['a1'],
      },
    ])
    expect(g.nodes.map((n) => n.sessionId)).toEqual(['w1', 'w2', 'a1'])
  })

  it('feature: sessões da mesma feature (sessions.feature_id ou registro sintetizado)', () => {
    testDb
      .prepare(
        `INSERT INTO features (id, project_id, slug, title, status, doc_path, created_at, updated_at)
         VALUES ('f1','p1','auth','Auth','active','/tmp/f1.md',1,1)`,
      )
      .run()
    addSession('x', 'r-web', { featureId: 'f1' })
    addSession('y', 'r-api')
    addSession('z', 'r-site')
    testDb
      .prepare(
        `INSERT INTO feature_session_records (session_id, feature_id, summary, session_at, created_at)
         VALUES ('y','f1','resumo',1,1)`,
      )
      .run()

    const g = graphFor(live({ x: {}, y: {}, z: {} }))
    expect(edgesOf(g.edges, 'feature')).toEqual([
      { kind: 'feature', featureId: 'f1', sessionIds: ['x', 'y'] },
    ])
  })

  it('encerrados: só os últimos 7 dias e até 20 por mãe; ativo e needs_input sempre entram', () => {
    const now = 100 * TERMINAL_HANDOFF_WINDOW_MS
    const age = (id: string, ms: number) =>
      testDb.prepare('UPDATE handoffs SET updated_at = ? WHERE id = ?').run(now - ms, id)
    addSession('mother', 'r-web')
    const done: string[] = []
    for (let i = 0; i < TERMINAL_HANDOFFS_PER_MOTHER + 5; i++) {
      addSession(`done-${i}`, 'r-api')
      const h = dispatch('mother', `done-${i}`, `t${i}`)
      handoffStore.report(h, 'ok')
      age(h, (i + 1) * 60_000)
      done.push(h)
    }
    addSession('stale', 'r-api')
    const stale = dispatch('mother', 'stale', 'velho')
    handoffStore.report(stale, 'ok')
    age(stale, TERMINAL_HANDOFF_WINDOW_MS + 1)
    addSession('asking', 'r-api')
    const asking = dispatch('mother', 'asking', 'pergunta')
    handoffStore.ask(asking, 'qual caminho?')
    age(asking, 30 * TERMINAL_HANDOFF_WINDOW_MS)
    addSession('busy', 'r-api')
    const busy = dispatch('mother', 'busy', 'rodando')
    age(busy, 30 * TERMINAL_HANDOFF_WINDOW_MS)

    const g = buildSessionGraph(readSessionGraphInput(testDb, live({ mother: {} }), now))
    const ids = new Set(edgesOf(g.edges, 'handoff').map((e) => e.handoffId))
    expect(ids.has(asking)).toBe(true)
    expect(ids.has(busy)).toBe(true)
    expect(ids.has(stale)).toBe(false)
    expect(done.filter((h) => ids.has(h))).toEqual(done.slice(0, TERMINAL_HANDOFFS_PER_MOTHER))
    expect(g.nodes.some((n) => n.sessionId === 'stale')).toBe(false)
    expect(g.nodes.some((n) => n.sessionId === `done-${TERMINAL_HANDOFFS_PER_MOTHER}`)).toBe(false)
  })

  it('handoff dispensado do Crew Dock não gera fio', () => {
    addSession('mother', 'r-web')
    addSession('kid', 'r-api')
    const h = dispatch('mother', 'kid', 't')
    handoffStore.dismiss(h)

    const g = graphFor(live({ mother: {}, kid: {} }))
    expect(edgesOf(g.edges, 'handoff')).toEqual([])
    expect(g.nodes.find((n) => n.sessionId === 'kid')?.childOfHandoffId).toBeNull()
  })

  it('atenção: pergunta aberta da filha vence; senão waiting do CLI', () => {
    addSession('mother', 'r-web')
    addSession('kid', 'r-api')
    const h = dispatch('mother', 'kid', 't')
    handoffStore.ask(h, 'posso apagar?')

    const g = graphFor(live({ mother: { status: 'waiting' }, kid: { status: 'working' } }))
    const byId = new Map(g.nodes.map((n) => [n.sessionId, n]))
    expect(byId.get('kid')?.attentionReason).toBe('handoff-input')
    expect(byId.get('mother')?.attentionReason).toBe('waiting')
  })

  it('título segue a precedência da aba: manual > nome vivo > título salvo > repo', () => {
    addSession('manual', 'r-web', { title: 'meu nome', titleSource: 'manual' })
    addSession('auto', 'r-web', { title: 'salvo', titleSource: 'auto' })
    addSession('bare', 'r-web')
    addSession('loose', null)

    const g = graphFor(
      live({
        manual: { name: 'nome-do-cli' },
        auto: { name: 'nome-do-cli' },
        bare: {},
        loose: {},
      }),
    )
    const title = (id: string) => g.nodes.find((n) => n.sessionId === id)?.title
    expect(title('manual')).toBe('meu nome')
    expect(title('auto')).toBe('nome-do-cli')
    expect(title('bare')).toBe('web')
    expect(title('loose')).toBe('Avulsa')
  })

  it('lanes: projeto → repos na ordem de posição; avulsas por último', () => {
    addSession('w', 'r-web')
    addSession('a', 'r-api')
    addSession('s', 'r-site')
    addSession('loose', null)

    const g = graphFor(live({ w: {}, a: {}, s: {}, loose: {} }))
    expect(
      g.lanes.map((l) => [l.projectId, l.name, l.repos.map((r) => [r.label, r.sessionIds])]),
    ).toEqual([
      [
        'p1',
        'Plataforma',
        [
          ['api-core', ['a']],
          ['web', ['w']],
        ],
      ],
      ['p2', 'Site', [['site', ['s']]]],
      [null, 'Avulsas', [['Avulsas', ['loose']]]],
    ])
  })
})

describe('session graph — memória de trabalho (P8)', () => {
  beforeEach(() => {
    testDb = new Database(':memory:')
    applyAllMigrations(testDb)
    seedBase(testDb)
  })

  afterEach(() => testDb.close())

  it('propósito: sessions.purpose > tarefa do handoff > 1º prompt do transcript', () => {
    addSession('mae', 'r-web')
    addSession('filha', 'r-api')
    addSession('solta', 'r-site')
    addSession('editada', 'r-site')
    dispatch('mae', 'filha', 'Refatorar o auth')
    // Mesmo UPDATE do canvas-store.setSessionPurpose (o escritor real).
    testDb.prepare(`UPDATE sessions SET purpose = 'Frente de pagamentos' WHERE id = 'editada'`).run()

    const asked: string[] = []
    const firstPrompt = (cc: string) => {
      asked.push(cc)
      return cc === 'cc-solta' ? 'Migrar o checkout' : null
    }
    const g = buildSessionGraph(
      readSessionGraphInput(testDb, live({ mae: {}, filha: {}, solta: {}, editada: {} }), Date.now(), firstPrompt),
    )
    const node = (id: string) => g.nodes.find((n) => n.sessionId === id)!
    expect([node('editada').purpose, node('editada').purposeSource]).toEqual(['Frente de pagamentos', 'user'])
    expect([node('filha').purpose, node('filha').purposeSource]).toEqual(['Refatorar o auth', 'handoff'])
    expect([node('solta').purpose, node('solta').purposeSource]).toEqual(['Migrar o checkout', 'transcript'])
    expect([node('mae').purpose, node('mae').purposeSource]).toEqual([null, null])
    // Transcript só é lido pra quem não tem propósito melhor (custo por rebuild).
    expect(asked.sort()).toEqual(['cc-mae', 'cc-solta'])
  })

  it('provider sem transcript do Claude (codex) não entra na busca do 1º prompt', () => {
    addSession('cl', 'r-web')
    addSession('cx', 'r-web')
    testDb.prepare(`UPDATE sessions SET provider = 'codex' WHERE id = 'cx'`).run()
    const asked: string[] = []
    readSessionGraphInput(testDb, live({ cl: {}, cx: {} }), Date.now(), (cc, isLive) => {
      asked.push(`${cc}@${isLive}`)
      return null
    })
    expect(asked).toEqual(['cc-cl@true'])
  })

  it('mãe que foi filha de um handoff fora da janela: o propósito é a tarefa daquele handoff', () => {
    addSession('avo', 'r-web')
    addSession('mae', 'r-api')
    addSession('neta', 'r-site')
    const old = dispatch('avo', 'mae', 'Combinar o início da perícia com o app')
    // Fora da janela de handoffs do grafo: concluído há 30 dias.
    testDb
      .prepare(`UPDATE handoffs SET status = 'done', updated_at = ?, created_at = 1 WHERE id = ?`)
      .run(Date.now() - 30 * 86_400_000, old)
    dispatch('mae', 'neta', 'Medir a adesão')
    const asked: string[] = []
    const g = buildSessionGraph(
      readSessionGraphInput(
        testDb,
        live({ mae: {}, neta: {} }),
        Date.now(),
        (cc) => {
          asked.push(cc)
          return 'Comece a tarefa…'
        },
        (cc) => (cc === 'cc-mae' ? 'agora abre o PR' : null),
      ),
    )
    const mae = g.nodes.find((n) => n.sessionId === 'mae')!
    expect([mae.purpose, mae.purposeSource]).toEqual(['Combinar o início da perícia com o app', 'handoff'])
    expect(mae.lastPrompt).toBe('agora abre o PR')
    expect(asked).not.toContain('cc-mae')
  })

  it('grupo e "onde parei" vêm das colunas que o canvas-store grava', () => {
    addSession('s1', 'r-web')
    testDb
      .prepare(`UPDATE sessions SET group_id = 'g1', last_summary = 'Parou no webhook.', last_summary_at = 42 WHERE id = 's1'`)
      .run()
    const n = graphFor(live({ s1: {} })).nodes[0]
    expect(n).toMatchObject({ groupId: 'g1', lastSummary: 'Parou no webhook.', lastSummaryAt: 42 })
  })
})
