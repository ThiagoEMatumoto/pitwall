import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  applyAllMigrations,
  legacyAsk,
  scanFixture,
  seedFeature,
  seedRepos,
  seedSession,
} from './attention-test-harness'
import { projectAttention } from '../../../../shared/attention/project-attention'
import {
  countAttentionSubjects,
  countForLane,
  humanQueue,
} from '../../../../shared/attention/selectors'
import { loopSnapshot } from '../loop-snapshot'
import type { LiveStatus, ScreenScan } from '../../../../shared/tui/attention-reason'
import type { AttentionItem, AttentionLiveSession } from '../../../../shared/types/attention'

let testDb: Database.Database
vi.mock('../db', () => ({ getDb: () => testDb }))
let transcriptPath: string | null = null
vi.mock('../transcript-path', () => ({ findTranscriptPath: () => transcriptPath }))
// O serviço lê PTYs e session files só no caminho do app (readAttentionInput);
// aqui o estado vivo entra por toAttentionLive, o mesmo mapper.
vi.mock('../session-activity', () => ({ buildSessionsFileIndex: () => new Map() }))
vi.mock('../live-session-states', () => ({ liveSessionStates: () => new Map() }))

import * as store from '../handoff-store'
import * as requestStore from '../handoff-requests'
import {
  attentionCounters,
  projectAndCount,
  readRequestInput,
  readTransitions,
  toAttentionLive,
} from './attention-service'

// O MESMO mapper do main: linha real de sessions + estado vivo + tela capturada.
function liveOf(
  sessionId: string,
  status: LiveStatus,
  scan: ScreenScan | null,
): AttentionLiveSession {
  const row = testDb
    .prepare('SELECT id, feature_id, repo_id FROM sessions WHERE id = ?')
    .get(sessionId) as { id: string; feature_id: string | null; repo_id: string | null }
  return toAttentionLive(
    row,
    { status, lastActivityAt: 1_000, name: null },
    scan,
    scan?.menu ? 1 : null,
  )
}

const T0 = 1_700_000_000_000

// Filha rodando sob a mãe 'm', criada pelo caminho real: create → markRunning.
function runningChild(repo: string, childSid: string) {
  seedSession(testDb, childSid, { repoId: repo })
  const h = store.create({
    targetRepoId: repo,
    motherSessionId: 'm',
    task: `task ${childSid}`,
    composedPrompt: 'p',
  })
  return store.markRunning(h.id, childSid)
}

function project(live: AttentionLiveSession[]): AttentionItem[] {
  const handoffs = store.list()
  return projectAttention({
    handoffs,
    transitions: readTransitions(testDb, handoffs),
    live,
    ...readRequestInput(),
  })
}

function eventAt(handoffId: string, event: string): number {
  const row = testDb
    .prepare('SELECT at FROM handoff_events WHERE handoff_id = ? AND event = ? ORDER BY at DESC')
    .get(handoffId, event) as { at: number }
  return row.at
}

describe('projectAttention — estado produzido pelo handoffStore real', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(T0)
    testDb = new Database(':memory:')
    testDb.pragma('foreign_keys = ON')
    applyAllMigrations(testDb)
    seedRepos(testDb)
    seedSession(testDb, 'm')
    transcriptPath = null
  })
  afterEach(() => {
    testDb.close()
    vi.useRealTimers()
  })

  it('1) needs_input legado (sem pedido) sem progress posterior → 1 child_question com o relógio da pergunta', () => {
    const h = runningChild('r1', 'c1')
    vi.setSystemTime(T0 + 1_000)
    legacyAsk(testDb, h.id, 'Qual branch?')
    const asked = store.get(h.id)!
    const items = project([])
    expect(items).toHaveLength(1)
    expect(items[0].kind).toBe('child_question')
    expect(items[0].createdAt).toBe(asked.questionAskedAt)
    expect(items[0].dedupKey).toContain(String(asked.questionAskedAt))
    expect(items[0].severity).toBe('blocking')
    expect(items[0].actions.map((a) => a.kind)).toEqual(['send_message', 'open_session', 'dismiss'])
  })

  it('2) needs_input legado e depois progress (relógio avançado) → 0 itens', () => {
    const h = runningChild('r1', 'c1')
    vi.setSystemTime(T0 + 1_000)
    legacyAsk(testDb, h.id, 'Qual branch?')
    vi.setSystemTime(T0 + 2_000)
    store.progress(h.id, 'segui com main')
    expect(store.get(h.id)!.status).toBe('needs_input')
    expect(project([])).toEqual([])
  })

  it('3) waiting com a tela de fim de turno (idle-prompt) → 0 itens', async () => {
    const scan = await scanFixture('idle-prompt')
    expect(project([liveOf('m', 'waiting', scan)])).toEqual([])
  })

  it('4) waiting com menu de permissão → 1 session_menu com respond_menu', async () => {
    const scan = await scanFixture('permission-bash')
    const items = project([liveOf('m', 'waiting', scan)])
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      kind: 'session_menu',
      menuReason: 'permission',
      sessionId: 'm',
    })
    expect(items[0].actions[0]).toEqual({ kind: 'respond_menu', sessionId: 'm', menuSeq: 1 })
  })

  it('5) waiting sem scan → session_menu unrecognized, sem respond_menu', () => {
    const items = project([liveOf('m', 'waiting', null)])
    expect(items).toHaveLength(1)
    expect(items[0].menuReason).toBe('unrecognized')
    expect(items[0].actions.map((a) => a.kind)).toEqual(['open_session'])
  })

  it('5c) idle com menu de permissão na tela → session_menu permission', async () => {
    const scan = await scanFixture('permission-bash')
    const items = project([liveOf('m', 'idle', scan)])
    expect(items.map((i) => [i.kind, i.menuReason])).toEqual([['session_menu', 'permission']])
  })

  it('5d) starting/working sem menu na tela → 0 itens', async () => {
    expect(project([liveOf('m', 'starting', null)])).toEqual([])
    expect(project([liveOf('m', 'working', await scanFixture('idle-prompt'))])).toEqual([])
  })

  it('6) filha com ask E menu de permissão na tela → 1 item só (session_menu do handoff)', async () => {
    const h = runningChild('r1', 'c1')
    store.ask(h.id, 'Posso apagar?')
    const scan = await scanFixture('permission-bash')
    const items = project([liveOf('c1', 'waiting', scan)])
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ kind: 'session_menu', handoffId: h.id, sessionId: 'c1' })
  })

  it('é determinística: mesmo input → mesmo JSON', async () => {
    const a = runningChild('r1', 'c1')
    store.ask(a.id, 'q')
    const scan = await scanFixture('permission-bash')
    const input = {
      handoffs: store.list(),
      transitions: new Map(),
      live: [liveOf('m', 'waiting', scan), liveOf('c1', 'working', null)],
      ...readRequestInput(),
    }
    expect(JSON.stringify(projectAttention(input))).toBe(JSON.stringify(projectAttention(input)))
  })

  it('ordena blocking antes de action/info e, dentro, pelo relógio', async () => {
    const a = runningChild('r1', 'c1')
    vi.setSystemTime(T0 + 5_000)
    store.ask(a.id, 'q')
    const scan = await scanFixture('permission-bash')
    // lastActivityAt 1_000 < questionAskedAt: o menu vem primeiro.
    const items = project([liveOf('m', 'waiting', scan)])
    expect(items.map((i) => i.kind)).toEqual(['session_menu', 'request'])
  })
})

describe('projectAttention — desfechos com handoff_events reais', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(T0)
    testDb = new Database(':memory:')
    testDb.pragma('foreign_keys = ON')
    applyAllMigrations(testDb)
    seedRepos(testDb)
    seedSession(testDb, 'm')
    transcriptPath = null
  })
  afterEach(() => {
    testDb.close()
    vi.useRealTimers()
  })

  it('7) fail com a mãe viva → child_failed com o relógio do evento; mãe e filha mortas → 0', () => {
    const h = runningChild('r1', 'c1')
    vi.setSystemTime(T0 + 3_000)
    store.fail(h.id, 'quebrou o build')
    const items = project([liveOf('m', 'idle', null)])
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ kind: 'child_failed', severity: 'action', handoffId: h.id })
    expect(items[0].createdAt).toBe(eventAt(h.id, 'fail'))
    expect(items[0].dedupKey).toBe(`child_failed:${h.id}:${eventAt(h.id, 'fail')}`)
    expect(items[0].whyNow).toBe('Falhou: quebrou o build')
    expect(project([])).toEqual([])
  })

  it('7b) failed com a PTY da filha viva → 1 item só, com kill_session (absorve o pty_orphan)', () => {
    const h = runningChild('r1', 'c1')
    store.fail(h.id, 'x')
    const items = project([liveOf('c1', 'idle', null)])
    expect(items.map((i) => i.kind)).toEqual(['child_failed'])
    expect(items[0].actions.map((a) => a.kind)).toEqual(['dismiss', 'open_session', 'kill_session'])
  })

  it('7c) interrupted retomável → child_interrupted; sem transcript → 0', () => {
    const h = runningChild('r1', 'c1')
    vi.setSystemTime(T0 + 4_000)
    store.failIfRunning(h.id, 'PTY morreu')
    transcriptPath = '/tmp/t.jsonl'
    const items = project([])
    expect(items.map((i) => [i.kind, i.createdAt])).toEqual([
      ['child_interrupted', eventAt(h.id, 'interrupt')],
    ])
    expect(items[0].actions[0]).toEqual({ kind: 'reopen_child', handoffId: h.id })
    // Fora da janela do memo de transcript (30s), o sumiço do disco vale.
    vi.setSystemTime(T0 + 60_000)
    transcriptPath = null
    expect(project([])).toEqual([])
  })

  it('7d) interrupted retomável com a PTY viva num menu → 1 item só (session_menu do handoff)', async () => {
    const h = runningChild('r1', 'c1')
    store.failIfRunning(h.id, 'PTY morreu')
    transcriptPath = '/tmp/t.jsonl'
    const scan = await scanFixture('permission-bash')
    const items = project([liveOf('c1', 'waiting', scan)])
    expect(items.map((i) => [i.kind, i.handoffId])).toEqual([['session_menu', h.id]])
    // Menu respondido: a interrupção volta a ser o item do handoff.
    expect(project([liveOf('c1', 'idle', null)]).map((i) => i.kind)).toEqual(['child_interrupted'])
  })

  it('7e) failed com a PTY da filha num menu → 2 itens, mas a lane conta 1 sessão', async () => {
    const h = runningChild('r1', 'c1')
    store.fail(h.id, 'x')
    const scan = await scanFixture('permission-bash')
    const items = humanQueue(project([liveOf('c1', 'waiting', scan)]))
    expect(items.map((i) => i.kind)).toEqual(['session_menu', 'child_failed'])
    expect(countForLane(items, new Set(['c1']), null)).toBe(1)
  })

  it('8) report sem markConsumed com a mãe viva → result_unconsumed info/mother; depois de markConsumed → 0', () => {
    const h = runningChild('r1', 'c1')
    vi.setSystemTime(T0 + 5_000)
    store.report(h.id, 'feito')
    const items = project([liveOf('m', 'working', null)])
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      kind: 'result_unconsumed',
      severity: 'info',
      audience: 'mother',
      createdAt: eventAt(h.id, 'report'),
    })
    expect(items[0].actions).toEqual([{ kind: 'open_session', sessionId: 'm' }])
    store.markConsumed(h.id)
    expect(project([liveOf('m', 'working', null)])).toEqual([])
  })

  it('9) report com a PTY da filha viva → pty_orphan info; release → nenhum pty_orphan', () => {
    const h = runningChild('r1', 'c1')
    store.report(h.id, 'feito')
    store.markConsumed(h.id)
    const before = project([liveOf('c1', 'idle', null)])
    expect(before.map((i) => [i.kind, i.severity])).toEqual([['pty_orphan', 'info']])
    store.release(h.id)
    expect(project([liveOf('c1', 'idle', null)]).filter((i) => i.kind === 'pty_orphan')).toEqual([])
  })

  it('10) dismiss do handoff tira request, child_failed e result_unconsumed', () => {
    const q = runningChild('r1', 'c1')
    store.ask(q.id, 'q')
    const f = runningChild('r2', 'c2')
    store.fail(f.id, 'x')
    const d = runningChild('r3', 'c3')
    store.report(d.id, 'ok')
    const live = [liveOf('m', 'idle', null)]
    expect(
      project(live)
        .map((i) => i.kind)
        .sort(),
    ).toEqual(['child_failed', 'request', 'result_unconsumed'])
    for (const id of [q.id, f.id, d.id]) store.dismiss(id)
    expect(project(live)).toEqual([])
  })

  it('a dispensa (X→X) não mexe no relógio do desfecho', () => {
    const h = runningChild('r1', 'c1')
    vi.setSystemTime(T0 + 1_000)
    store.fail(h.id, 'x')
    vi.setSystemTime(T0 + 9_000)
    store.dismiss(h.id)
    store.undismiss(h.id)
    const [item] = project([liveOf('m', 'idle', null)])
    expect(item.createdAt).toBe(T0 + 1_000)
  })

  it('contadores: liveWaitingNotTurnEnd === sessionMenuItems (1 permissão, 1 sem scan, 1 turn-end)', async () => {
    seedSession(testDb, 's1')
    seedSession(testDb, 's2')
    seedSession(testDb, 's3')
    const handoffs = store.list()
    const items = projectAndCount({
      handoffs,
      transitions: readTransitions(testDb, handoffs),
      ...readRequestInput(),
      live: [
        liveOf('s1', 'waiting', await scanFixture('permission-bash')),
        liveOf('s2', 'waiting', null),
        liveOf('s3', 'waiting', await scanFixture('idle-prompt')),
      ],
    })
    const c = attentionCounters()
    expect(items).toHaveLength(2)
    expect(c.liveWaitingNotTurnEnd).toBe(2)
    expect(c.sessionMenuItems).toBe(2)
    expect(c.byKind.session_menu).toBe(2)
    expect(c.computedAt).toBe(T0)
  })
})

describe('request — pedidos tipados pelo store real', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(T0)
    testDb = new Database(':memory:')
    testDb.pragma('foreign_keys = ON')
    applyAllMigrations(testDb)
    seedRepos(testDb)
    seedSession(testDb, 'm')
    transcriptPath = null
  })
  afterEach(() => {
    testDb.close()
    vi.useRealTimers()
  })

  function twoAsks() {
    const h = runningChild('r1', 'c1')
    vi.setSystemTime(T0 + 1_000)
    const a = store.ask(h.id, {
      kind: 'decision',
      question: 'Qual banco?',
      options: [
        { key: 'A', label: 'Postgres' },
        { key: 'B', label: 'SQLite', detail: 'já está no app' },
      ],
      recommendation: 'B',
      costOfError: 'migração de dados depois',
    }).request!
    vi.setSystemTime(T0 + 2_000)
    const b = store.ask(h.id, 'Pode renomear o módulo?').request!
    return { h, a, b }
  }

  it('2 asks → 2 itens request do mesmo sujeito, sem child_question; a contagem é 1', () => {
    const { h, a, b } = twoAsks()
    const items = project([])
    expect(items.map((i) => i.kind)).toEqual(['request', 'request'])
    expect(items.map((i) => i.request?.requestId)).toEqual([a.id, b.id])
    expect(new Set(items.map((i) => i.sessionId))).toEqual(new Set(['c1']))
    expect(countAttentionSubjects(humanQueue(items))).toBe(1)
    expect(items[0]).toMatchObject({
      dedupKey: `request:${a.id}`,
      severity: 'blocking',
      audience: 'human',
      handoffId: h.id,
      createdAt: T0 + 1_000,
      entryRule: "handoff_requests.status='open' kind='decision'",
    })
    expect(items[0].whyNow).toBe('task c1 precisa de uma decisão: Qual banco?')
    expect(items[1].whyNow).toBe('task c1 perguntou: Pode renomear o módulo?')
    expect(items[0].request).toEqual({
      requestId: a.id,
      kind: 'decision',
      question: 'Qual banco?',
      options: a.options,
      recommendation: 'B',
      costOfError: 'migração de dados depois',
      resolver: 'mother',
      risk: null,
      escalated: false,
    })
    expect(items[0].actions).toEqual([
      { kind: 'answer_request', requestId: a.id },
      { kind: 'open_session', sessionId: 'c1' },
      { kind: 'triage_dismiss', dedupKey: `request:${a.id}`, requestId: a.id },
      { kind: 'triage_snooze', dedupKey: `request:${a.id}`, requestId: a.id },
    ])
  })

  it('responder o 1º deixa 1 item; dispensar o 2º zera a fila sem mexer no handoff nem no pedido', () => {
    const { h, a, b } = twoAsks()
    requestStore.answerRequest(a.id, { choice: 'B', by: 'mother' })
    expect(project([]).map((i) => i.request?.requestId)).toEqual([b.id])
    expect(store.get(h.id)!.status).toBe('needs_input')
    requestStore.dismissAttention(`request:${b.id}`, b.id)
    expect(project([])).toEqual([])
    expect(store.get(h.id)!.status).toBe('needs_input')
    expect(requestStore.get(b.id)!.status).toBe('open')
  })

  it('snooze: até o prazo o item some; com o prazo vencido volta sozinho', () => {
    const { b } = twoAsks()
    requestStore.snoozeAttention(`request:${b.id}`, b.id, T0 + 60_000)
    expect(project([]).map((i) => i.request?.requestId)).not.toContain(b.id)
    vi.setSystemTime(T0 + 61_000)
    expect(project([]).map((i) => i.request?.requestId)).toContain(b.id)
    requestStore.snoozeAttention(`request:${b.id}`, b.id, T0 - 1)
    expect(project([]).map((i) => i.request?.requestId)).toContain(b.id)
  })

  it('progress depois do ask não fecha o pedido (só resposta fecha)', () => {
    const { h } = twoAsks()
    vi.setSystemTime(T0 + 5_000)
    store.progress(h.id, 'adiantando outra parte')
    expect(project([]).map((i) => i.kind)).toEqual(['request', 'request'])
  })

  it('needs_input legado sem pedido → child_question (rede de segurança)', () => {
    const h = runningChild('r1', 'c1')
    legacyAsk(testDb, h.id, 'pergunta do app antigo')
    expect(requestStore.listOpen({ handoffId: h.id })).toEqual([])
    expect(project([]).map((i) => i.kind)).toEqual(['child_question'])
  })

  it('menu na tela vence o pedido comum, mas não o human_only (2 itens, 1 sujeito)', async () => {
    const h = runningChild('r1', 'c1')
    store.ask(h.id, 'q comum')
    const scan = await scanFixture('permission-bash')
    expect(project([liveOf('c1', 'waiting', scan)]).map((i) => i.kind)).toEqual(['session_menu'])
    store.ask(h.id, {
      kind: 'confirmation',
      question: 'Deploy em prod?',
      risk: 'deploy_infra_spend',
    })
    const items = project([liveOf('c1', 'waiting', scan)])
    expect(items.map((i) => i.kind).sort()).toEqual(['request', 'session_menu'])
    expect(items.find((i) => i.kind === 'request')!.whyNow).toBe(
      'task c1 pede confirmação: Deploy em prod? — só você resolve',
    )
    expect(countAttentionSubjects(humanQueue(items))).toBe(1)
  })

  it('handoff dispensado esconde o pedido comum, mas não o human_only', () => {
    const h = runningChild('r1', 'c1')
    store.ask(h.id, 'comum')
    const ho = store.ask(h.id, {
      kind: 'human_action',
      question: 'Rode o drop',
      risk: 'destructive_data',
    }).request!
    store.dismiss(h.id)
    expect(project([]).map((i) => i.request?.requestId)).toEqual([ho.id])
    expect(project([])[0].whyNow).toBe(
      'task c1 precisa que você faça: Rode o drop — só você resolve',
    )
  })

  it('attentionCounters().byKind.request bate com os itens request', () => {
    twoAsks()
    const handoffs = store.list()
    const items = projectAndCount({
      handoffs,
      transitions: readTransitions(testDb, handoffs),
      live: [],
      ...readRequestInput(),
    })
    expect(attentionCounters().byKind.request).toBe(
      items.filter((i) => i.kind === 'request').length,
    )
    expect(attentionCounters().byKind.request).toBe(2)
  })

  function recompute() {
    const handoffs = store.list()
    return projectAndCount({
      handoffs,
      transitions: readTransitions(testDb, handoffs),
      live: [],
      ...readRequestInput(),
    })
  }

  it('requestHealth: visível → escondido por regressão → triado (e o feature_health vê)', () => {
    seedFeature(testDb, 'F')
    seedSession(testDb, 'c1', { repoId: 'r1' })
    const created = store.create({
      targetRepoId: 'r1',
      motherSessionId: 'm',
      task: 'task c1',
      composedPrompt: 'p',
      featureId: 'F',
    })
    const h = store.markRunning(created.id, 'c1')
    const r = store.ask(h.id, { question: 'Apago a tabela?', risk: 'destructive_data' }).request!
    recompute()
    expect(requestStore.requestHealth({ featureId: 'F' })).toMatchObject({
      openHumanOnly: 1,
      visibleHumanOnly: 1,
      triagedHumanOnly: 0,
      hiddenHumanOnly: 0,
    })
    const codes = () => loopSnapshot('F').issues.map((i) => i.code)
    expect(codes()).not.toContain('human_only_hidden')
    // Regressão simulada: o handoff sai do estado vivo sem cancelOpen.
    testDb.prepare("UPDATE handoffs SET status = 'interrupted' WHERE id = ?").run(h.id)
    vi.setSystemTime(T0 + 10_000)
    recompute()
    const hidden = requestStore.requestHealth({ featureId: 'F' })
    expect(hidden).toMatchObject({ openHumanOnly: 1, visibleHumanOnly: 0, hiddenHumanOnly: 1 })
    expect(hidden.oldestHiddenAt).toBe(r.createdAt)
    expect(requestStore.requestHealth({ featureId: 'outra' }).openHumanOnly).toBe(0)
    expect(codes()).toContain('human_only_hidden')
    requestStore.dismissAttention(`request:${r.id}`, r.id)
    expect(requestStore.requestHealth({})).toMatchObject({
      triagedHumanOnly: 1,
      hiddenHumanOnly: 0,
    })
    expect(codes()).not.toContain('human_only_hidden')
  })

  it('requestHealth: pedido mais novo que a última fila ainda não conta como escondido', () => {
    recompute()
    vi.setSystemTime(T0 + 1_000)
    const h = runningChild('r1', 'c1')
    store.ask(h.id, { question: 'Deploy?', risk: 'deploy_infra_spend' })
    expect(requestStore.requestHealth({}).hiddenHumanOnly).toBe(0)
  })
})

describe('humanQueue', () => {
  beforeEach(() => {
    testDb = new Database(':memory:')
    testDb.pragma('foreign_keys = ON')
    applyAllMigrations(testDb)
    seedRepos(testDb)
    seedSession(testDb, 'm')
  })
  afterEach(() => testDb.close())

  it('11) exclui info por padrão e inclui com includeInfo', () => {
    const h = runningChild('r1', 'c1')
    store.report(h.id, 'feito')
    // Mãe viva: o resultado não lido vira item da mãe (info).
    const items = project([liveOf('m', 'working', null)])
    expect(items.map((i) => [i.kind, i.severity, i.audience])).toEqual([
      ['result_unconsumed', 'info', 'mother'],
    ])
    expect(humanQueue(items)).toEqual([])
    expect(humanQueue(items, { includeInfo: true })).toHaveLength(1)
  })
})
