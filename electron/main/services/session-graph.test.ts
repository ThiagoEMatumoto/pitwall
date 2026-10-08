import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { migrations } from './migrations/index'
import type { SessionGraphEdge } from '../../../shared/types/session-graph'

// Os handoffs saem do handoff-store REAL (o produtor de produção), que usa getDb.
let testDb: Database.Database
vi.mock('./db', () => ({ getDb: () => testDb }))
const transcripts = vi.hoisted(() => new Set<string>())
vi.mock('./transcript-path', () => ({
  findTranscriptPath: (cc: string) => (transcripts.has(cc) ? `/t/${cc}.jsonl` : null),
}))

// A fila de atenção entra pelo serviço real; só o caminho do app (PTYs e session
// files) fica de fora — os estados vivos vêm do teste.
vi.mock('./session-activity', () => ({ buildSessionsFileIndex: () => new Map() }))
vi.mock('./live-session-states', () => ({ liveSessionStates: () => new Map() }))

import * as handoffStore from './handoff-store'
import { readAttentionInputFrom } from './attention/attention-service'
import { projectAttention } from '../../../shared/attention/project-attention'
import { tuiMenuWatch } from './tui-menu-watch'
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

let repoSeq = 0

// Sem repoId explícito, cada filha ganha um clone do api-core: o índice da
// migration 054 permite UM handoff ativo por repo, e estes cenários têm várias
// filhas vivas ao mesmo tempo.
function dispatch(motherId: string, childId: string, task: string, repoId?: string): string {
  const targetRepoId = repoId ?? `r-api-${childId}-${(repoSeq += 1)}`
  if (!repoId) {
    testDb
      .prepare(
        `INSERT INTO repos (id, project_id, label, path, position, created_at)
         VALUES (?, 'p1', 'api-core', ?, 0, 1)`,
      )
      .run(targetRepoId, `/tmp/${targetRepoId}`)
  }
  const h = handoffStore.create({
    motherSessionId: motherId,
    targetRepoId,
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
  return buildSessionGraph({
    ...readSessionGraphInput(testDb, liveMap),
    attention: projectAttention(readAttentionInputFrom(testDb, liveMap)),
  })
}

// Tela real na PTY: o tuiMenuWatch de produção espelha e escaneia a captura.
const FIXTURES = join(__dirname, '../../../shared/tui/__fixtures__')
const fakePty = new EventEmitter() as EventEmitter & { write: () => void }
fakePty.write = () => {}
async function showScreen(sessionId: string, capture: string): Promise<void> {
  const raw = readFileSync(join(FIXTURES, `claude-2.1.286-${capture}.ansi`), 'utf8')
  fakePty.emit('spawn', { sessionId, cols: 80, rows: 24 })
  fakePty.emit('data', { sessionId, data: raw })
  await tuiMenuWatch.snapshot(sessionId)
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

  it('feature: 1 card com 3 repos de 2 projetos; sem feature cai em "Sem feature · <Projeto>"', () => {
    // Mesmos INSERTs do feature-store.createFeature/upsert (features + feature_repos).
    testDb
      .prepare(
        `INSERT INTO features (id, project_id, slug, title, status, doc_path, created_at, updated_at)
         VALUES ('f1','p1','checkout','Checkout E2E','in-progress','/tmp/f1.md',1,1),
                ('f-arch','p1','old','Velha','done','/tmp/f2.md',1,1)`,
      )
      .run()
    testDb.prepare(`UPDATE features SET archived_at = 5 WHERE id = 'f-arch'`).run()
    testDb
      .prepare(
        `INSERT INTO feature_repos (feature_id, repo_id, branch, worktree_path) VALUES
           ('f1','r-api','feat/checkout',NULL), ('f1','r-web','feat/checkout',NULL),
           ('f1','r-site','feat/checkout',NULL)`,
      )
      .run()
    testDb
      .prepare(
        `INSERT INTO feature_pulses (id, feature_id, body, source, created_at)
         VALUES ('pu1','f1','antigo','human',1), ('pu2','f1','Pagamento integrado','human',2)`,
      )
      .run()
    addSession('m', 'r-api', { featureId: 'f1' })
    addSession('c', 'r-site', { featureId: 'f1' })
    addSession('solta', 'r-web')
    addSession('arq', 'r-web', { featureId: 'f-arch' })

    const g = graphFor(live({ m: {}, c: {}, solta: {}, arq: {} }))
    const feature = g.lanes.find((l) => l.kind === 'feature')
    expect(g.lanes.filter((l) => l.kind === 'feature')).toHaveLength(1)
    expect(feature).toMatchObject({
      featureId: 'f1',
      name: 'Checkout E2E',
      pulse: 'Pagamento integrado',
      projectName: 'Plataforma',
    })
    expect(feature!.repos.map((r) => [r.label, r.projectName, r.sessionIds])).toEqual([
      ['api-core', 'Plataforma', ['m']],
      ['web', 'Plataforma', []],
      ['site', 'Site', ['c']],
    ])
    expect(g.nodes.find((n) => n.sessionId === 'm')).toMatchObject({
      featureId: 'f1',
      featureTitle: 'Checkout E2E',
    })
    // Arquivada = sem feature no mapa.
    expect(g.nodes.find((n) => n.sessionId === 'arq')?.featureId).toBeNull()
    expect(
      g.lanes
        .filter((l) => l.kind === 'project')
        .map((l) => [l.name, l.repos.map((r) => r.sessionIds)]),
    ).toEqual([['Sem feature · Plataforma', [['solta', 'arq']]]])
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

  describe('atenção vem da fila única', () => {
    beforeAll(() => tuiMenuWatch.attach(fakePty as never))
    afterEach(() => {
      for (const id of ['mother', 'kid']) fakePty.emit('exit', { sessionId: id })
    })

    it('pergunta aberta da filha vence; menu de permissão na tela da mãe é waiting', async () => {
      addSession('mother', 'r-web')
      addSession('kid', 'r-api')
      const h = dispatch('mother', 'kid', 't')
      handoffStore.ask(h, 'posso apagar?')
      await showScreen('mother', 'permission-bash')

      const g = graphFor(live({ mother: { status: 'waiting' }, kid: { status: 'working' } }))
      const byId = new Map(g.nodes.map((n) => [n.sessionId, n]))
      expect(byId.get('kid')?.attentionReason).toBe('handoff-input')
      expect(byId.get('mother')?.attentionReason).toBe('waiting')
    })

    it('needs_input com progress posterior à pergunta → null', () => {
      addSession('mother', 'r-web')
      addSession('kid', 'r-api')
      const h = dispatch('mother', 'kid', 't')
      vi.useFakeTimers({ toFake: ['Date'] })
      try {
        vi.setSystemTime(1_000_000)
        handoffStore.ask(h, 'qual branch?')
        vi.setSystemTime(1_005_000)
        handoffStore.progress(h, 'segui com main')
      } finally {
        vi.useRealTimers()
      }
      expect(handoffStore.get(h)?.status).toBe('needs_input')

      const g = graphFor(live({ mother: {}, kid: { status: 'working' } }))
      expect(g.nodes.find((n) => n.sessionId === 'kid')?.attentionReason).toBeNull()
    })

    // Toda superfície == projeção: a raia conta child_failed pela sessão da filha,
    // então o nó (tom do card, MapStatusCounters, FeaturePanel) também tem de contar.
    it('filha com PTY viva num handoff que falhou → waiting (item child_failed)', () => {
      addSession('mother', 'r-web')
      addSession('kid', 'r-api')
      const h = dispatch('mother', 'kid', 't')
      handoffStore.fail(h, 'boom')

      const g = graphFor(live({ mother: { status: 'idle' }, kid: { status: 'idle' } }))
      expect(g.nodes.find((n) => n.sessionId === 'kid')?.attentionReason).toBe('waiting')
    })

    it('waiting com a tela de fim de turno → null', async () => {
      addSession('mother', 'r-web')
      await showScreen('mother', 'idle-prompt')
      const g = graphFor(live({ mother: { status: 'waiting' } }))
      expect(g.nodes.find((n) => n.sessionId === 'mother')?.attentionReason).toBeNull()
    })
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
        'Sem feature · Plataforma',
        [
          ['api-core', ['a']],
          ['web', ['w']],
        ],
      ],
      ['p2', 'Sem feature · Site', [['site', ['s']]]],
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
    testDb
      .prepare(`UPDATE sessions SET purpose = 'Frente de pagamentos' WHERE id = 'editada'`)
      .run()

    const asked: string[] = []
    const firstPrompt = (cc: string) => {
      asked.push(cc)
      return cc === 'cc-solta' ? 'Migrar o checkout' : null
    }
    const g = buildSessionGraph(
      readSessionGraphInput(
        testDb,
        live({ mae: {}, filha: {}, solta: {}, editada: {} }),
        Date.now(),
        firstPrompt,
      ),
    )
    const node = (id: string) => g.nodes.find((n) => n.sessionId === id)!
    expect([node('editada').purpose, node('editada').purposeSource]).toEqual([
      'Frente de pagamentos',
      'user',
    ])
    expect([node('filha').purpose, node('filha').purposeSource]).toEqual([
      'Refatorar o auth',
      'handoff',
    ])
    expect([node('solta').purpose, node('solta').purposeSource]).toEqual([
      'Migrar o checkout',
      'transcript',
    ])
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
    expect([mae.purpose, mae.purposeSource]).toEqual([
      'Combinar o início da perícia com o app',
      'handoff',
    ])
    expect(mae.lastPrompt).toBe('agora abre o PR')
    expect(asked).not.toContain('cc-mae')
  })

  it('grupo e "onde parei" vêm das colunas que o canvas-store grava', () => {
    addSession('s1', 'r-web')
    testDb
      .prepare(
        `UPDATE sessions SET group_id = 'g1', last_summary = 'Parou no webhook.', last_summary_at = 42 WHERE id = 's1'`,
      )
      .run()
    const n = graphFor(live({ s1: {} })).nodes[0]
    expect(n).toMatchObject({ groupId: 'g1', lastSummary: 'Parou no webhook.', lastSummaryAt: 42 })
  })
})

// Bastão da MÃE pelo produtor real (handoffStore.transferMother): o nó diz quem
// lidera, quantas filhas, e quem passou o bastão.
describe('session graph — mãe transferível (F3)', () => {
  beforeEach(() => {
    testDb = new Database(':memory:')
    testDb.pragma('foreign_keys = ON')
    applyAllMigrations(testDb)
    seedBase(testDb)
    addSession('m', 'r-web', { title: 'ana-mc', titleSource: 'manual' })
    addSession('c1', 'r-api')
    addSession('c2', 'r-api')
  })

  afterEach(() => {
    testDb.close()
  })

  const nodeOf = (g: ReturnType<typeof graphFor>, id: string) =>
    g.nodes.find((n) => n.sessionId === id)!

  it('mãe com 2 filhas vivas: isMother e childCount; filha não é mãe', () => {
    dispatch('m', 'c1', 'Mapa')
    dispatch('m', 'c2', 'Modal')
    const g = graphFor(live({ m: {}, c1: {}, c2: {} }))
    expect(nodeOf(g, 'm')).toMatchObject({ isMother: true, childCount: 2, batonPassed: false })
    expect(nodeOf(g, 'c1')).toMatchObject({ isMother: false, childCount: 0 })
  })

  // Regressão: o badge e o bastão usavam recortes diferentes. Interrompida sem
  // transcript ou dispensada não é filha; interrompida retomável é (o bastão a
  // relinka, e retomada ela reporta à mãe do handoff).
  it('conta filha no recorte do bastão: interrompida só se retomável, dispensada nunca', () => {
    addSession('c3', 'r-api')
    dispatch('m', 'c1', 'Mapa')
    const dead = dispatch('m', 'c2', 'Modal')
    handoffStore.failIfRunning(dead, 'pty morreu')
    const gone = dispatch('m', 'c3', 'Outra')
    handoffStore.dismiss(gone)
    const g = live({ m: {}, c1: {}, c2: {}, c3: {} })
    expect(nodeOf(graphFor(g), 'm').childCount).toBe(1)
    expect(handoffStore.listRelinkableByMother('m')).toHaveLength(1)

    const uuid = '11111111-2222-4333-8444-555555555555'
    testDb.prepare('UPDATE sessions SET cc_session_id = ? WHERE id = ?').run(uuid, 'c2')
    transcripts.add(uuid)
    try {
      expect(nodeOf(graphFor(g), 'm').childCount).toBe(2)
      expect(handoffStore.listRelinkableByMother('m')).toHaveLength(2)
    } finally {
      transcripts.delete(uuid)
    }
  })

  it('handoff encerrado não conta como filha', () => {
    dispatch('m', 'c1', 'Mapa')
    const done = dispatch('m', 'c2', 'Modal')
    handoffStore.report(done, 'ok')
    expect(nodeOf(graphFor(live({ m: {}, c1: {}, c2: {} })), 'm').childCount).toBe(1)
  })

  it('depois do transferMother: a sucessora é mãe, a antecessora "bastão passado", fios e baton mudam', () => {
    addSession('m2', 'r-web', { title: 'bruno-mc', titleSource: 'manual' })
    dispatch('m', 'c1', 'Mapa')
    dispatch('m', 'c2', 'Modal')
    handoffStore.transferMother('m', 'm2')

    const g = graphFor(live({ m: {}, m2: {}, c1: {}, c2: {} }))
    expect(nodeOf(g, 'm2')).toMatchObject({ isMother: true, childCount: 2, batonPassed: false })
    expect(nodeOf(g, 'm')).toMatchObject({ isMother: false, childCount: 0, batonPassed: true })

    const wires = edgesOf(g.edges, 'handoff')
    expect(wires.map((e) => e.from)).toEqual(['m2', 'm2'])
    const baton = edgesOf(g.edges, 'baton')
    expect(baton).toHaveLength(1)
    expect(baton[0]).toMatchObject({ from: 'm', to: 'm2' })
  })

  it('mãe antiga que ganha filha nova de novo deixa de ser "bastão passado"', () => {
    addSession('m2', 'r-web')
    addSession('c3', 'r-site')
    dispatch('m', 'c1', 'Mapa')
    handoffStore.transferMother('m', 'm2')
    dispatch('m', 'c3', 'Outra', 'r-site')
    const n = nodeOf(graphFor(live({ m: {}, m2: {}, c1: {}, c3: {} })), 'm')
    expect(n).toMatchObject({ isMother: true, childCount: 1, batonPassed: false })
  })

  // Mãe que também é filha (da avó g): o baton:pass grava predecessor_session_id
  // no handoff dela E o transferMother das filhas. É um bastão só, uma seta só.
  it('mãe que também é filha passa o bastão: um único ⟲ m→m2', () => {
    addSession('g', 'r-web')
    addSession('m2', 'r-web')
    const own = dispatch('g', 'm', 'Liderar')
    dispatch('m', 'c1', 'Mapa')
    passBaton(own, 'm', 'm2')
    handoffStore.transferMother('m', 'm2')
    const baton = edgesOf(graphFor(live({ g: {}, m: {}, m2: {}, c1: {} })).edges, 'baton')
    expect(baton).toHaveLength(1)
    expect(baton[0]).toMatchObject({ from: 'm', to: 'm2' })
  })
})
