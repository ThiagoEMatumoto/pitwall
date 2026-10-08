import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// A fila mapeia a projeção; o estado que a alimenta sai do handoffStore REAL sobre
// um banco migrado (nada de Handoff montado à mão no caminho da atenção).
let testDb: Database.Database
vi.mock('../../../electron/main/services/db', () => ({ getDb: () => testDb }))
vi.mock('../../../electron/main/services/transcript-path', () => ({
  findTranscriptPath: () => null,
}))

// attention-queue importa crew.ts → handoffsStore → @/lib/ipc, que lê window.api
// no module-eval. Mesmo stub de crew.test.ts, antes do import dinâmico.
vi.stubGlobal('window', {
  ...globalThis.window,
  api: new Proxy({}, { get: () => new Proxy({}, { get: () => () => undefined }) }),
})

const { buildAttentionQueue, attentionCount, stepAttention, planAttentionStep, planBackTarget } =
  await import('./attention-queue')

const store = await import('../../../electron/main/services/handoff-store')
const { readTransitions, toAttentionLive } =
  await import('../../../electron/main/services/attention/attention-service')
const { projectAttention } = await import('../../../shared/attention/project-attention')
const harness = await import('../../../electron/main/services/attention/attention-test-harness')

type Handoff = import('../../../shared/types/ipc').Handoff
type LiveSessionInfo = import('../../../shared/types/ipc').LiveSessionInfo

const live = (over: Partial<LiveSessionInfo> & { id: string }): LiveSessionInfo =>
  ({
    ccSessionId: `cc-${over.id}`,
    name: null,
    title: null,
    status: 'working',
    repo: null,
    projectName: 'proj',
    projectIcon: null,
    projectColor: null,
    lastActivityAt: null,
    lastText: null,
    ...over,
  }) as LiveSessionInfo

const hf = (over: Partial<Handoff> & { id: string }): Handoff =>
  ({
    motherSessionId: null,
    targetRepoId: 'repo',
    targetRepoLabel: 'repo-alvo',
    childSessionId: null,
    featureId: null,
    task: 'tarefa',
    status: 'running',
    currentStep: null,
    stepUpdatedAt: null,
    pendingQuestion: null,
    questionAskedAt: null,
    dismissedAt: null,
    resumable: false,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  }) as Handoff

// Cenário pelos produtores reais: sessões no banco, handoffs pelo store, telas
// capturadas do claude, projeção pelo mesmo mapper do main.
type Status = import('../../../shared/tui/attention-reason').LiveStatus
type Scan = import('../../../shared/tui/attention-reason').ScreenScan
type AttentionLive = import('../../../shared/types/attention').AttentionLiveSession

function liveOf(id: string, status: Status, scan: Scan | null, at = 1_000): AttentionLive {
  const row = testDb
    .prepare('SELECT id, feature_id, repo_id FROM sessions WHERE id = ?')
    .get(id) as {
    id: string
    feature_id: string | null
    repo_id: string | null
  }
  return toAttentionLive(
    row,
    { status, lastActivityAt: at, name: null },
    scan,
    scan?.menu ? 1 : null,
  )
}

function child(repo: string, sid: string, task = `task ${sid}`): Handoff {
  harness.seedSession(testDb, sid, { repoId: repo })
  const h = store.create({ targetRepoId: repo, motherSessionId: 'm', task, composedPrompt: 'p' })
  return store.markRunning(h.id, sid)
}

function queueFor(
  states: AttentionLive[],
  visibleIds: string[],
  over: Record<string, Partial<LiveSessionInfo>> = {},
) {
  const handoffs = store.list()
  const attention = projectAttention({
    handoffs,
    transitions: readTransitions(testDb, handoffs),
    live: states,
  })
  const infos = states.map((s) => harness.toLiveInfo(testDb, s, over[s.sessionId]))
  return buildAttentionQueue({
    visibleSessions: infos.filter((i) => visibleIds.includes(i.id)),
    liveSessions: infos,
    handoffs,
    attention,
  })
}

describe('buildAttentionQueue — mapeia a projeção', () => {
  beforeEach(() => {
    testDb = new Database(':memory:')
    testDb.pragma('foreign_keys = ON')
    harness.applyAllMigrations(testDb)
    harness.seedRepos(testDb)
    harness.seedSession(testDb, 'm')
  })
  afterEach(() => testDb.close())

  it('pergunta de filha sem aba + menu numa sessão visível → 2 entradas (crew + session)', async () => {
    const a = child('r1', 'a')
    store.ask(a.id, 'qual branch?')
    harness.seedSession(testDb, 's')
    const q = queueFor(
      [
        liveOf('a', 'working', null),
        liveOf('s', 'waiting', await harness.scanFixture('permission-bash')),
      ],
      ['s'],
    )
    expect(q.map((i) => [i.key, i.reason, i.detail])).toEqual([
      ['session:s', 'waiting', 'permission'],
      [`crew:${a.id}`, 'handoff-input', 'handoff-input'],
    ])
    expect(attentionCount(q)).toBe(2)
  })

  it('filha com aba aberta e pergunta pendente vira sessão com o handoff e o relógio da pergunta', () => {
    const a = child('r1', 'a')
    store.ask(a.id, 'q')
    const q = queueFor([liveOf('a', 'working', null)], ['a'])
    expect(q).toHaveLength(1)
    expect(q[0]).toMatchObject({ kind: 'session', handoffId: a.id, reason: 'handoff-input' })
    expect(q[0].since).toBe(store.get(a.id)!.questionAskedAt)
    expect(q[0].projectedKind).toBe('child_question')
  })

  it('fim de turno na tela e needs_input retomado ficam fora', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(10_000)
      const a = child('r1', 'a')
      store.ask(a.id, 'q')
      vi.setSystemTime(20_000)
      store.progress(a.id, 'segui')
    } finally {
      vi.useRealTimers()
    }
    harness.seedSession(testDb, 's')
    const q = queueFor(
      [
        liveOf('a', 'working', null),
        liveOf('s', 'waiting', await harness.scanFixture('idle-prompt')),
      ],
      ['s'],
    )
    expect(q).toEqual([])
  })

  it('falha com a mãe viva entra como crew (action), depois do menu (blocking)', () => {
    const f = child('r1', 'f')
    store.fail(f.id, 'build quebrou')
    harness.seedSession(testDb, 's')
    const q = queueFor([liveOf('m', 'idle', null), liveOf('s', 'waiting', null)], ['m', 's'])
    expect(q.map((i) => [i.key, i.projectedKind])).toEqual([
      ['session:s', 'session_menu'],
      [`crew:${f.id}`, 'child_failed'],
    ])
    expect(q[1].reason).toBe('crew')
  })

  it('resultado não lido pela mãe (info) não entra na fila humana', () => {
    const d = child('r1', 'd')
    store.report(d.id, 'ok')
    expect(queueFor([liveOf('m', 'idle', null)], ['m'])).toEqual([])
  })

  it('título: o mesmo da barra — title > name > repo > Avulsa', () => {
    for (const id of ['a', 'b', 'c', 'd']) harness.seedSession(testDb, id)
    const repo = { label: 'Kakei' } as LiveSessionInfo['repo']
    const q = queueFor(
      ['a', 'b', 'c', 'd'].map((id, n) => liveOf(id, 'waiting', null, n + 1)),
      ['a', 'b', 'c', 'd'],
      { a: { title: 'Refactor', name: 'x' }, b: { name: 'nome-b' }, c: { repo } },
    )
    expect(q.map((i) => i.title)).toEqual(['Refactor', 'nome-b', 'Kakei', 'Avulsa'])
  })

  it('item sem sessão visível e sem handoff carregado (corrida de push) é descartado', () => {
    const a = child('r1', 'a')
    store.ask(a.id, 'q')
    const handoffs = store.list()
    const attention = projectAttention({ handoffs, transitions: new Map(), live: [] })
    expect(attention).toHaveLength(1)
    expect(
      buildAttentionQueue({ visibleSessions: [], liveSessions: [], handoffs: [], attention }),
    ).toEqual([])
  })
})

describe('stepAttention', () => {
  const keys = ['a', 'b', 'c']

  it('sem cursor: next entra no primeiro, prev no último', () => {
    expect(stepAttention(keys, null, 1)).toBe(0)
    expect(stepAttention(keys, null, -1)).toBe(2)
  })

  it('avança e recua a partir do cursor', () => {
    expect(stepAttention(keys, 'a', 1)).toBe(1)
    expect(stepAttention(keys, 'b', -1)).toBe(0)
  })

  it('dá a volta nas pontas (wrap)', () => {
    expect(stepAttention(keys, 'c', 1)).toBe(0)
    expect(stepAttention(keys, 'a', -1)).toBe(2)
  })

  it('cursor que saiu da fila conta como sem cursor', () => {
    expect(stepAttention(keys, 'sumiu', 1)).toBe(0)
  })

  it('fila vazia → null', () => {
    expect(stepAttention([], null, 1)).toBeNull()
    expect(stepAttention([], 'a', -1)).toBeNull()
  })
})

describe('planAttentionStep', () => {
  type Item = import('./attention-queue').AttentionItem
  const item = (key: string, cc: string | null): Item =>
    ({
      key,
      kind: key.startsWith('crew:') ? 'crew' : 'session',
      sessionId: key,
      ccSessionId: cc,
      projectName: null,
      title: key,
      reason: key.startsWith('crew:') ? 'crew' : 'waiting',
      since: null,
      liveStatus: null,
    }) as Item
  // Fila [A (mais antiga), B, filha].
  const queue = [item('session:a', 'cc-a'), item('session:b', 'cc-b'), item('crew:h', 'cc-h')]
  const keyAt = (step: ReturnType<typeof planAttentionStep>) =>
    step ? queue[step.index].key : null

  it('1º Alt+A sem pulo guardado vai pra mais antiga, mesmo com a ativa (B) na fila', () => {
    expect(keyAt(planAttentionStep(queue, null, 'cc-b', 1))).toBe('session:a')
  })

  it('1º Alt+A com a ativa na cabeça da fila pula ela e vai pra próxima', () => {
    expect(keyAt(planAttentionStep(queue, null, 'cc-a', 1))).toBe('session:b')
  })

  it('1º Alt+Shift+A entra pela cauda; se a cauda é a ativa, a anterior a ela', () => {
    expect(keyAt(planAttentionStep(queue, null, 'cc-b', -1))).toBe('crew:h')
    expect(keyAt(planAttentionStep(queue.slice(0, 2), null, 'cc-b', -1))).toBe('session:a')
  })

  it('fila de um item só que é a ativa: fica nela', () => {
    expect(keyAt(planAttentionStep(queue.slice(0, 1), null, 'cc-a', 1))).toBe('session:a')
  })

  it('sequência da spec com a aba trocando a tempo: A → B → filha (peek) → A', () => {
    const s1 = planAttentionStep(queue, null, 'cc-b', 1)!
    const s2 = planAttentionStep(queue, s1.cursor, 'cc-a', 1)!
    const s3 = planAttentionStep(queue, s2.cursor, 'cc-b', 1)!
    // Peek da filha não troca a aba: a ativa segue B.
    const s4 = planAttentionStep(queue, s3.cursor, 'cc-b', 1)!
    expect([s1, s2, s3, s4].map(keyAt)).toEqual(['session:a', 'session:b', 'crew:h', 'session:a'])
  })

  it('Alt+A rápido com o store atrasado (B, depois A, depois B) não repete item', () => {
    const s1 = planAttentionStep(queue, null, 'cc-b', 1)!
    // O dockview ainda não ativou A: o store segue em B.
    const s2 = planAttentionStep(queue, s1.cursor, 'cc-b', 1)!
    // Agora o store chegou em A (atrasado — o usuário já está indo pra B).
    const s3 = planAttentionStep(queue, s2.cursor, 'cc-a', 1)!
    expect([s1, s2, s3].map(keyAt)).toEqual(['session:a', 'session:b', 'crew:h'])
  })

  it('usuário trocou de sessão por fora: recomeça pela cabeça', () => {
    const s1 = planAttentionStep(queue, null, 'cc-b', 1)!
    expect(keyAt(planAttentionStep(queue, s1.cursor, 'cc-z', 1))).toBe('session:a')
  })

  it('pulo guardado que saiu da fila é ignorado', () => {
    const stored = { key: 'session:x', trail: ['cc-b'] }
    expect(keyAt(planAttentionStep(queue, stored, 'cc-b', 1))).toBe('session:a')
  })

  it('fila vazia → null', () => {
    expect(planAttentionStep([], null, null, 1)).toBeNull()
  })
})

describe('planBackTarget', () => {
  it('pula sessão viva que não é visível e volta pra última visível', () => {
    const a = live({ id: 'a' })
    const hidden = live({ id: 'hidden' })
    const b = live({ id: 'b' })
    const target = planBackTarget(['cc-b', 'cc-hidden', 'cc-a'], 'cc-b', {
      visibleSessions: [a, b],
      liveSessions: [a, hidden, b],
      handoffs: [],
    })
    expect(target).toEqual({ kind: 'session', ccSessionId: 'cc-a' })
  })

  it('filha do dock sem aba volta pelo peek, não por pane nova', () => {
    const a = live({ id: 'a' })
    const child = live({ id: 'child' })
    const target = planBackTarget(['cc-a', 'cc-child'], 'cc-a', {
      visibleSessions: [a],
      liveSessions: [a, child],
      handoffs: [hf({ id: 'h', childSessionId: 'child', status: 'running' })],
    })
    expect(target).toEqual({ kind: 'crew', handoffId: 'h' })
  })

  it('filha com aba aberta é sessão normal', () => {
    const a = live({ id: 'a' })
    const child = live({ id: 'child' })
    const target = planBackTarget(['cc-a', 'cc-child'], 'cc-a', {
      visibleSessions: [a, child],
      liveSessions: [a, child],
      handoffs: [hf({ id: 'h', childSessionId: 'child', status: 'running' })],
    })
    expect(target).toEqual({ kind: 'session', ccSessionId: 'cc-child' })
  })

  it('sem outra sessão alcançável: null', () => {
    const a = live({ id: 'a' })
    expect(
      planBackTarget(['cc-a', 'cc-gone'], 'cc-a', {
        visibleSessions: [a],
        liveSessions: [a],
        handoffs: [],
      }),
    ).toBeNull()
  })
})
