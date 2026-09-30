import { describe, expect, it, vi } from 'vitest'

// attention-queue importa crew.ts → handoffsStore → @/lib/ipc, que lê window.api
// no module-eval. Mesmo stub de crew.test.ts, antes do import dinâmico.
vi.stubGlobal('window', {
  ...globalThis.window,
  api: new Proxy({}, { get: () => new Proxy({}, { get: () => () => undefined }) }),
})

const {
  buildAttentionQueue,
  attentionSessionCount,
  stepAttention,
  planAttentionStep,
  planBackTarget,
} = await import('./attention-queue')

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

describe('buildAttentionQueue', () => {
  it('fila vazia quando ninguém espera', () => {
    const s = live({ id: 'a', status: 'working' })
    expect(buildAttentionQueue({ visibleSessions: [s], liveSessions: [s], handoffs: [] })).toEqual(
      [],
    )
  })

  it('sessões waiting da mais antiga para a mais recente; sem lastActivityAt vai pro fim', () => {
    const recent = live({ id: 'recent', status: 'waiting', lastActivityAt: 300 })
    const old = live({ id: 'old', status: 'waiting', lastActivityAt: 100 })
    const unknown = live({ id: 'unknown', status: 'waiting', lastActivityAt: null })
    const busy = live({ id: 'busy', status: 'working', lastActivityAt: 50 })
    const all = [recent, unknown, busy, old]
    const q = buildAttentionQueue({ visibleSessions: all, liveSessions: all, handoffs: [] })
    expect(q.map((i) => i.sessionId)).toEqual(['old', 'recent', 'unknown'])
    expect(q.every((i) => i.kind === 'session' && i.reason === 'waiting')).toBe(true)
    expect(q[0]).toMatchObject({ ccSessionId: 'cc-old', projectName: 'proj', since: 100 })
  })

  it('título: o mesmo da barra — title > name > repo > Avulsa', () => {
    const a = live({ id: 'a', status: 'waiting', title: 'Refactor', name: 'x', lastActivityAt: 1 })
    const b = live({ id: 'b', status: 'waiting', name: 'nome-b', lastActivityAt: 2 })
    const repo = { label: 'Kakei' } as LiveSessionInfo['repo']
    const c = live({ id: 'c', status: 'waiting', repo, lastActivityAt: 3 })
    const d = live({ id: 'd', status: 'waiting', lastActivityAt: 4 })
    const q = buildAttentionQueue({
      visibleSessions: [a, b, c, d],
      liveSessions: [a, b, c, d],
      handoffs: [],
    })
    expect(q.map((i) => i.title)).toEqual(['Refactor', 'nome-b', 'Kakei', 'Avulsa'])
  })

  it('ordem: pergunta de handoff (filha com aba aberta) → waiting → crew do dock', () => {
    const waiting = live({ id: 'w', status: 'waiting', lastActivityAt: 10 })
    const openChild = live({ id: 'open-child', status: 'working', lastActivityAt: 5 })
    const dockChild = live({ id: 'dock-child', status: 'working' })
    const handoffs = [
      hf({ id: 'h-dock', childSessionId: 'dock-child', status: 'needs_input', questionAskedAt: 1 }),
      hf({ id: 'h-open', childSessionId: 'open-child', status: 'needs_input', questionAskedAt: 2 }),
    ]
    const q = buildAttentionQueue({
      // dock-child está escondida (sem aba) — é assim que useVisibleLiveSessions a entrega.
      visibleSessions: [waiting, openChild],
      liveSessions: [waiting, openChild, dockChild],
      handoffs,
    })
    expect(q.map((i) => [i.kind, i.reason, i.sessionId, i.handoffId ?? null])).toEqual([
      ['session', 'handoff-input', 'open-child', 'h-open'],
      ['session', 'waiting', 'w', null],
      ['crew', 'handoff-input', 'dock-child', 'h-dock'],
    ])
    expect(q[0].since).toBe(2)
  })

  it('dedup: filha com aba aberta em waiting aparece uma vez só (como sessão)', () => {
    const child = live({ id: 'child', status: 'waiting', lastActivityAt: 7 })
    const handoffs = [hf({ id: 'h', childSessionId: 'child', status: 'running' })]
    const q = buildAttentionQueue({ visibleSessions: [child], liveSessions: [child], handoffs })
    expect(q).toHaveLength(1)
    expect(q[0]).toMatchObject({ kind: 'session', reason: 'waiting', sessionId: 'child' })
  })

  it('dedup: filha com aba aberta, needs_input E PTY waiting → só handoff-input', () => {
    const child = live({ id: 'child', status: 'waiting', lastActivityAt: 7 })
    const handoffs = [
      hf({ id: 'h', childSessionId: 'child', status: 'needs_input', questionAskedAt: 3 }),
    ]
    const q = buildAttentionQueue({ visibleSessions: [child], liveSessions: [child], handoffs })
    expect(q.map((i) => i.reason)).toEqual(['handoff-input'])
  })

  it('filha do dock em waiting (PTY) entra como crew, não como sessão', () => {
    const child = live({ id: 'child', status: 'waiting', name: 'mauricio-auth', lastActivityAt: 9 })
    const handoffs = [hf({ id: 'h', childSessionId: 'child', status: 'running', task: 'Auth' })]
    const q = buildAttentionQueue({ visibleSessions: [], liveSessions: [child], handoffs })
    expect(q).toEqual([
      expect.objectContaining({
        kind: 'crew',
        reason: 'crew',
        sessionId: 'child',
        ccSessionId: 'cc-child',
        handoffId: 'h',
        title: 'mauricio-auth',
        since: 9,
      }),
    ])
  })

  it('crew sem sessão viva usa task e label do repo; pergunta respondida fora do app não entra', () => {
    const handoffs = [
      hf({ id: 'asking', status: 'needs_input', questionAskedAt: 5, task: 'Migrar export' }),
      hf({
        id: 'resumed',
        status: 'needs_input',
        questionAskedAt: 5,
        stepUpdatedAt: 6,
      }),
      hf({ id: 'dismissed', status: 'needs_input', questionAskedAt: 5, dismissedAt: 7 }),
    ]
    const q = buildAttentionQueue({ visibleSessions: [], liveSessions: [], handoffs })
    expect(q).toEqual([
      expect.objectContaining({
        kind: 'crew',
        sessionId: null,
        ccSessionId: null,
        handoffId: 'asking',
        title: 'Migrar export',
        projectName: 'repo-alvo',
        since: 5,
      }),
    ])
  })

  it('badge == fila de sessões: conta sessões (inclui pergunta de handoff), nunca crew', () => {
    const w1 = live({ id: 'w1', status: 'waiting', lastActivityAt: 1 })
    const w2 = live({ id: 'w2', status: 'waiting', lastActivityAt: 2 })
    const openChild = live({ id: 'oc', status: 'working' })
    const dockChild = live({ id: 'dc', status: 'waiting' })
    const handoffs = [
      hf({ id: 'h1', childSessionId: 'oc', status: 'needs_input', questionAskedAt: 1 }),
      hf({ id: 'h2', childSessionId: 'dc', status: 'running' }),
    ]
    const visible = [w1, w2, openChild]
    const q = buildAttentionQueue({
      visibleSessions: visible,
      liveSessions: [...visible, dockChild],
      handoffs,
    })
    expect(q).toHaveLength(4)
    expect(attentionSessionCount(q)).toBe(3)
    expect(attentionSessionCount(q)).toBe(q.filter((i) => i.kind === 'session').length)
    expect(attentionSessionCount([])).toBe(0)
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
