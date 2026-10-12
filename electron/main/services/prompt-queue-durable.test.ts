/** @vitest-environment node */
import type Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { openAppDb } from './db'
import {
  AWAITING_NOTICE_MS,
  CONFIRM_GIVEUP_MS,
  POLL_MS,
  PROMPT_TTL_MS,
  PromptQueue,
  STALE_RESTORE_MS,
  WRITEBACK_MS,
  type PromptQueueDeps,
} from './prompt-queue'
import {
  createPromptQueueStore,
  promptQueuePersistFailures,
  transcriptProof,
  transcriptVerdict,
  type TranscriptVerdict,
} from './prompt-queue-store'
import { fixture, scanOf } from './test-support/screen-scans'
import type { LiveStatus, ScreenScan } from '../../../shared/tui/attention-reason'
import type { PromptQueueSnapshot } from '../../../shared/types/send-prompt'

const CC = 'cc-durable'
const SETTLE_MS_FOR_TEST = 1_000
const PTY = 'pty-1'
let idle: ScreenScan
let dir: string
let db: Database.Database

beforeAll(async () => {
  idle = await scanOf(fixture('claude-2.1.286-idle-prompt.ansi'))
})

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cm-pq-durable-'))
  db = openAppDb(join(dir, 'app.db'))
  db.prepare(
    `INSERT INTO sessions (id, repo_id, cc_session_id, status, started_at) VALUES (?, NULL, ?, 'running', 1)`,
  ).run(PTY, CC)
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

function makeQueue(
  opts: {
    status?: LiveStatus
    now?: () => number
    verdict?: TranscriptVerdict
    // Transcript da conversa (JSONL real): a prova passa pelo parser de produção.
    jsonl?: () => string | null
    obsolete?: (id: string, text: string) => boolean
    extra?: Partial<PromptQueueDeps>
  } = {},
) {
  const writes: string[] = []
  let last: PromptQueueSnapshot | null = null
  const running = new Set([PTY])
  const queue = new PromptQueue({
    isRunning: (id) => running.has(id),
    status: () => opts.status ?? 'working',
    screen: async () => idle,
    nativeStatus: () => true,
    handoffAsking: () => false,
    write: (id, text, raw) => writes.push(`${id}:${raw ? 'raw:' : ''}${text}`),
    emit: (s) => (last = s),
    warn: () => {},
    now: opts.now,
    store: createPromptQueueStore(() => db),
    isObsolete: opts.obsolete,
    deliveryProof: (_cc, text, since) =>
      opts.jsonl
        ? transcriptProof(opts.jsonl(), text, since)
        : { verdict: opts.verdict ?? 'unknown', answered: false },
    ...opts.extra,
  })
  return { queue, writes, running, snap: () => last as PromptQueueSnapshot | null }
}

const rows = () =>
  db.prepare('SELECT id, state, session_id, cc_session_id FROM prompt_queue_items').all() as Array<{
    id: string
    state: string
    session_id: string
    cc_session_id: string | null
  }>

describe('PromptQueue durável (DB real)', () => {
  it('grava o item com o cc da conversa antes de responder queued', async () => {
    const { queue } = makeQueue()
    const res = await queue.send({ sessionId: PTY, text: 'oi', when: 'on-idle' })
    expect(res).toMatchObject({ ok: true, delivered: false })
    expect(res).not.toHaveProperty('durable')
    expect(rows()).toEqual([
      expect.objectContaining({ state: 'queued', session_id: PTY, cc_session_id: CC }),
    ])
    queue.dispose()
  })

  it('cancelar remove a linha', async () => {
    const { queue } = makeQueue()
    const a = await queue.send({ sessionId: PTY, text: 'a', when: 'on-idle' })
    await queue.send({ sessionId: PTY, text: 'b', when: 'on-idle' })
    queue.cancel(a.ok && !a.delivered ? a.queued.id : '')
    expect(rows()).toEqual([expect.objectContaining({ state: 'queued' })])
    queue.dispose()
  })

  it('PTY morta com o Pitwall vivo (OOM): o item fica no banco, visível, e o resume entrega uma vez', async () => {
    vi.useFakeTimers()
    try {
      const opts: { status: LiveStatus } = { status: 'working' }
      const q = makeQueue(opts)
      await q.queue.send({ sessionId: PTY, text: 'quando terminar: X', when: 'on-idle' })
      q.running.delete(PTY)
      q.queue.onSessionExit(PTY)

      expect(rows()).toEqual([
        expect.objectContaining({ state: 'queued', session_id: PTY, cc_session_id: CC }),
      ])
      expect(q.snap()?.items).toEqual([
        expect.objectContaining({ text: 'quando terminar: X', recovery: 'awaiting-session' }),
      ])
      expect(q.snap()?.counters.sessionGone).toBe(0)
      expect(q.snap()?.lastEvent?.kind).not.toBe('session-gone')
      // Sem a conversa voltar, o aviso aparece.
      await vi.advanceTimersByTimeAsync(AWAITING_NOTICE_MS)
      expect(q.snap()?.items[0]).toMatchObject({ waitingNotice: true })
      expect(rows()).toHaveLength(1)

      // Resume da mesma conversa numa PTY nova.
      const resumed = 'pty-resume'
      db.prepare(
        `INSERT INTO sessions (id, repo_id, cc_session_id, status, started_at) VALUES (?, NULL, ?, 'running', 2)`,
      ).run(resumed, CC)
      q.running.add(resumed)
      q.queue.onSessionLive(resumed)
      expect(rows()).toEqual([expect.objectContaining({ session_id: resumed })])
      opts.status = 'idle'
      q.queue.onTurnEnded(resumed)
      await vi.advanceTimersByTimeAsync(SETTLE_MS_FOR_TEST)
      q.queue.onTurnEnded(resumed)
      await vi.advanceTimersByTimeAsync(POLL_MS * 3)
      expect(q.writes).toEqual([`${resumed}:quando terminar: X`])
      expect(q.snap()?.items).toEqual([])
      q.queue.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('quit limpo: as PTYs morrem mas os itens ficam para o próximo boot', async () => {
    const { queue } = makeQueue()
    await queue.send({ sessionId: PTY, text: 'fica', when: 'on-idle' })
    queue.suspendForShutdown()
    queue.onSessionExit(PTY)
    expect(rows()).toEqual([expect.objectContaining({ state: 'queued' })])
  })

  it('restaurado velho (noite fora) nunca é apagado: pede confirmação e só sai com Enviar', async () => {
    let now = 1_000
    const first = makeQueue({ now: () => now })
    await first.queue.send({ sessionId: PTY, text: 'pode fazer o deploy', when: 'on-idle' })
    first.queue.dispose()

    now += 3 * 24 * 60 * 60_000
    const boot = makeQueue({ status: 'idle', now: () => now })
    boot.queue.restore()
    expect(boot.snap()?.items).toEqual([
      expect.objectContaining({ text: 'pode fazer o deploy', recovery: 'needs-confirmation' }),
    ])
    expect(boot.snap()?.counters).toMatchObject({ expired: 0, needsConfirmation: 1 })
    expect(rows()).toEqual([expect.objectContaining({ state: 'queued' })])
    expect(boot.queue.wakeTargets()).toEqual([])

    // A conversa volta: não entrega sozinho.
    boot.queue.onSessionLive(PTY)
    boot.queue.onTurnEnded(PTY)
    await new Promise((r) => setTimeout(r, 600))
    expect(boot.writes).toEqual([])
    expect(rows()).toHaveLength(1)

    const id = boot.snap()?.items[0].id as string
    expect(boot.queue.resend(id)).toBe(true)
    boot.queue.onTurnEnded(PTY)
    await new Promise((r) => setTimeout(r, 600))
    expect(boot.writes).toEqual([`${PTY}:pode fazer o deploy`])
    boot.queue.dispose()
  })

  it('restaurado recente sai sozinho; envelhecido esperando a conversa pede confirmação', async () => {
    let now = 1_000
    const first = makeQueue({ now: () => now })
    await first.queue.send({ sessionId: PTY, text: 'recente', when: 'on-idle' })
    first.queue.dispose()

    now += STALE_RESTORE_MS - 1
    const boot = makeQueue({ status: 'idle', now: () => now })
    boot.queue.restore()
    expect(boot.snap()?.items).toEqual([expect.objectContaining({ recovery: 'awaiting-session' })])
    // Conversa dormindo: alvo do wake.
    expect(boot.queue.wakeTargets()).toEqual([CC])

    now += 2
    boot.queue.onSessionLive(PTY)
    expect(boot.snap()?.items).toEqual([
      expect.objectContaining({ recovery: 'needs-confirmation' }),
    ])
    boot.queue.dispose()
  })

  it('wake da conversa falhou: os itens dela ficam visíveis', async () => {
    db.prepare(
      `INSERT INTO prompt_queue_items (id, session_id, cc_session_id, text, state, created_at)
       VALUES ('w1', 'pty-morta', ?, 'acorda', 'queued', ?)`,
    ).run(CC, Date.now())
    const boot = makeQueue()
    boot.queue.restore()
    boot.queue.surfaceTarget(CC)
    expect(boot.snap()?.items).toEqual([
      expect.objectContaining({ id: 'w1', recovery: 'needs-confirmation' }),
    ])
    expect(rows()).toHaveLength(1)
    boot.queue.dispose()
  })

  it('uncertain antigo nunca expira, nem com o poll rodando', async () => {
    vi.useFakeTimers()
    try {
      const old = Date.now() - 30 * 24 * 60 * 60_000
      db.prepare(
        `INSERT INTO prompt_queue_items (id, session_id, cc_session_id, text, state, created_at, delivering_at)
         VALUES ('u1', 'pty-morta', ?, 'talvez', 'uncertain', ?, ?)`,
      ).run(CC, old, old)
      const boot = makeQueue()
      boot.queue.restore()
      await vi.advanceTimersByTimeAsync(POLL_MS * 3)
      expect(boot.snap()?.items).toEqual([
        expect.objectContaining({ id: 'u1', recovery: 'maybe-undelivered' }),
      ])
      expect(rows()).toEqual([expect.objectContaining({ state: 'uncertain' })])
      boot.queue.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('restaurado entregue à conversa viva que não fica ociosa em PROMPT_TTL_MS: volta a pedir confirmação, sem apagar', async () => {
    vi.useFakeTimers()
    try {
      db.prepare(
        `INSERT INTO prompt_queue_items (id, session_id, cc_session_id, text, state, created_at)
         VALUES ('t1', 'pty-morta', ?, 'espera', 'queued', ?)`,
      ).run(CC, Date.now())
      const boot = makeQueue({ status: 'working' })
      boot.queue.restore()
      boot.queue.onSessionLive(PTY)
      await vi.advanceTimersByTimeAsync(PROMPT_TTL_MS + POLL_MS)
      expect(boot.snap()?.items).toEqual([
        expect.objectContaining({ id: 't1', recovery: 'needs-confirmation' }),
      ])
      expect(boot.snap()?.counters.expired).toBe(0)
      expect(rows()).toHaveLength(1)
      boot.queue.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('conversa que não volta: o item aparece 2 min depois do fim do restore, e segue no banco', async () => {
    vi.useFakeTimers()
    try {
      db.prepare(
        `INSERT INTO prompt_queue_items (id, session_id, cc_session_id, text, state, created_at)
         VALUES ('a1', 'pty-morta', ?, 'espera a conversa', 'queued', ?)`,
      ).run(CC, Date.now())
      const boot = makeQueue({ status: 'idle' })
      boot.queue.restore()
      // O renderer termina o restore 90s depois: o prazo conta dali.
      await vi.advanceTimersByTimeAsync(90_000)
      boot.queue.onWorkspaceRestored()
      await vi.advanceTimersByTimeAsync(AWAITING_NOTICE_MS - 1)
      expect(boot.snap()?.items[0]).not.toHaveProperty('waitingNotice')
      await vi.advanceTimersByTimeAsync(1)
      expect(boot.snap()?.items).toEqual([
        expect.objectContaining({ id: 'a1', recovery: 'awaiting-session', waitingNotice: true }),
      ])
      expect(boot.snap()?.counters.awaitingNoticed).toBe(1)
      expect(rows()).toEqual([expect.objectContaining({ state: 'queued' })])

      // A conversa volta: entrega sozinha e o aviso sai.
      boot.queue.onSessionLive(PTY)
      expect(boot.snap()?.items[0].waitingNotice).toBeUndefined()
      boot.queue.onTurnEnded(PTY)
      await vi.advanceTimersByTimeAsync(1_000)
      expect(boot.writes).toEqual([`${PTY}:espera a conversa`])
      boot.queue.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('envelope de handoff já terminado é descartado no boot, com contador', async () => {
    db.prepare(
      `INSERT INTO prompt_queue_items (id, session_id, cc_session_id, text, state, created_at)
       VALUES ('e1', 'pty-morta', ?, '<pitwall-answer request-id="r">ok</pitwall-answer>', 'queued', ?)`,
    ).run(CC, Date.now())
    const boot = makeQueue({ obsolete: (id) => id === 'e1' })
    boot.queue.restore()
    expect(boot.snap()?.items).toEqual([])
    expect(boot.snap()?.counters.discardedObsolete).toBe(1)
    expect(boot.snap()?.lastEvent).toMatchObject({ kind: 'cancelled', id: 'e1' })
    expect(rows()).toEqual([])
  })

  it('maybe-undelivered: só sai com resend do usuário, e aí entrega uma vez', async () => {
    db.prepare(
      `INSERT INTO prompt_queue_items (id, session_id, cc_session_id, text, state, created_at, delivering_at)
       VALUES ('m1', 'pty-morta', ?, 'talvez', 'delivering', ?, ?)`,
    ).run(CC, Date.now(), Date.now())
    const boot = makeQueue({ status: 'idle', verdict: 'unknown' })
    boot.queue.restore()
    boot.queue.onSessionLive(PTY)
    boot.queue.onTurnEnded(PTY)
    await new Promise((r) => setTimeout(r, 600))
    expect(boot.writes).toEqual([])
    expect(rows()).toEqual([expect.objectContaining({ state: 'uncertain', session_id: PTY })])

    expect(boot.queue.resend('m1')).toBe(true)
    boot.queue.onTurnEnded(PTY)
    await new Promise((r) => setTimeout(r, 600))
    expect(boot.writes).toEqual([`${PTY}:talvez`])
    expect(rows()).toEqual([expect.objectContaining({ state: 'delivering' })])
    boot.queue.dispose()
    boot.queue.dispose()
  })

  it('a linha só sai do banco quando o transcript mostra a mensagem e a resposta', async () => {
    const jsonl: string[] = []
    const { queue, writes } = makeQueue({ status: 'idle', jsonl: () => jsonl.join('\n') })
    const res = await queue.send({ sessionId: PTY, text: 'roda os testes', when: 'on-idle' })
    expect(res).toMatchObject({ ok: true, delivered: true })
    expect(writes).toEqual([`${PTY}:roda os testes`])
    // O write retornou, mas o claude ainda não gravou: a linha segue durável.
    expect(rows()).toEqual([expect.objectContaining({ state: 'delivering' })])
    queue.onTurnEnded(PTY)
    expect(rows()).toHaveLength(1)

    jsonl.push(claudeLine('user', 'roda os testes'))
    queue.onTurnEnded(PTY)
    // Achou a mensagem, mas sem resposta ela ainda pode estar só no page cache.
    expect(rows()).toHaveLength(1)

    jsonl.push(claudeLine('assistant', 'rodando'))
    queue.onTurnEnded(PTY)
    expect(rows()).toEqual([])
    queue.dispose()
  })

  it('mensagem achada sem resposta sai depois da janela de writeback', async () => {
    let now = 1_000_000
    const jsonl: string[] = []
    const { queue } = makeQueue({ status: 'idle', now: () => now, jsonl: () => jsonl.join('\n') })
    await queue.send({ sessionId: PTY, text: 'oi', when: 'on-idle' })
    jsonl.push(claudeLine('user', 'oi', now + 500))
    now += 1_000
    queue.onTurnEnded(PTY)
    now += WRITEBACK_MS - 1
    queue.onTurnEnded(PTY)
    expect(rows()).toHaveLength(1)
    now += 1
    queue.onTurnEnded(PTY)
    expect(rows()).toEqual([])
    queue.dispose()
  })

  it('sem a mensagem no transcript até o limite: vira talvez-não-entregue visível, sem reenviar', async () => {
    let now = 1_000_000
    const { queue, writes, snap } = makeQueue({ status: 'idle', now: () => now, jsonl: () => '' })
    await queue.send({ sessionId: PTY, text: 'sumiu?', when: 'on-idle' })
    now += CONFIRM_GIVEUP_MS - 1
    queue.onTurnEnded(PTY)
    expect(rows()).toEqual([expect.objectContaining({ state: 'delivering' })])
    now += 1
    queue.onTurnEnded(PTY)
    expect(rows()).toEqual([expect.objectContaining({ state: 'uncertain' })])
    expect(snap()?.items).toEqual([
      expect.objectContaining({ text: 'sumiu?', recovery: 'maybe-undelivered' }),
    ])
    expect(snap()?.lastEvent).toMatchObject({ kind: 'maybe-undelivered' })
    expect(writes).toHaveLength(1)
    queue.dispose()
  })

  it('PTY de outra conversa não puxa itens restaurados', async () => {
    db.prepare(
      `INSERT INTO prompt_queue_items (id, session_id, cc_session_id, text, state, created_at)
       VALUES ('q1', 'pty-morta', ?, 'minha', 'queued', ?)`,
    ).run(CC, Date.now())
    const boot = makeQueue({ status: 'idle' })
    boot.queue.restore()
    db.prepare(
      `INSERT INTO sessions (id, repo_id, cc_session_id, status, started_at) VALUES ('pty-outra', NULL, 'cc-outra', 'running', 2)`,
    ).run()
    boot.queue.onSessionLive('pty-outra')
    expect(boot.snap()?.items).toEqual([
      expect.objectContaining({ id: 'q1', recovery: 'awaiting-session' }),
    ])
    boot.queue.dispose()
  })
})

// Disco cheio/IOERR de verdade no caminho do store (writeDurably + better-sqlite3):
// triggers que abortam a escrita enquanto o interruptor estiver ligado.
function failWrites(ops: Array<'INSERT' | 'UPDATE' | 'DELETE'>): (on: boolean) => void {
  db.exec('CREATE TABLE IF NOT EXISTS fail_switch (op TEXT PRIMARY KEY)')
  for (const op of ops) {
    db.exec(`CREATE TRIGGER fail_${op} BEFORE ${op} ON prompt_queue_items
      WHEN EXISTS (SELECT 1 FROM fail_switch WHERE op = '${op}')
      BEGIN SELECT RAISE(ABORT, 'database or disk is full'); END`)
  }
  return (on) => {
    for (const op of ops) {
      if (on) db.prepare('INSERT OR IGNORE INTO fail_switch (op) VALUES (?)').run(op)
      else db.prepare('DELETE FROM fail_switch WHERE op = ?').run(op)
    }
  }
}

describe('falha de persistência (SQLite abortando a escrita)', () => {
  it('store: a escrita que falha lança e conta em persistFailed', () => {
    const fail = failWrites(['INSERT'])
    fail(true)
    const store = createPromptQueueStore(() => db)
    const before = promptQueuePersistFailures()
    expect(() =>
      store.insert({
        id: 'x',
        sessionId: PTY,
        ccSessionId: CC,
        text: 't',
        fromSessionId: null,
        bypassAttention: false,
        raw: false,
        state: 'queued',
        createdAt: 1,
        deliveringAt: null,
      }),
    ).toThrow(/disk is full/)
    expect(promptQueuePersistFailures()).toBe(before + 1)
  })

  it('insert falhou: fica em memória, não entrega sem o registro, e entrega quando grava', async () => {
    const fail = failWrites(['INSERT'])
    fail(true)
    const { queue, writes, snap } = makeQueue({ status: 'idle' })
    const res = await queue.send({ sessionId: PTY, text: 'sem banco', when: 'on-idle' })
    // Aceito, mas o chamador sabe que um kill agora o perderia.
    expect(res).toMatchObject({ ok: true, delivered: false, durable: false })
    expect(writes).toEqual([])
    expect(rows()).toEqual([])
    expect(snap()?.items).toEqual([expect.objectContaining({ text: 'sem banco' })])
    expect(snap()?.counters.persistFailed).toBeGreaterThan(0)

    // Fim de turno com o disco ainda cheio: segue sem entregar.
    queue.onTurnEnded(PTY)
    await new Promise((r) => setTimeout(r, 600))
    expect(writes).toEqual([])

    fail(false)
    queue.onTurnEnded(PTY)
    await new Promise((r) => setTimeout(r, 600))
    expect(writes).toEqual([`${PTY}:sem banco`])
    expect(rows()).toEqual([expect.objectContaining({ state: 'delivering' })])
    queue.dispose()
  })

  it('markDelivering falhou: não escreve no PTY e retenta', async () => {
    const opts: { status: LiveStatus } = { status: 'working' }
    const { queue, writes } = makeQueue(opts)
    await queue.send({ sessionId: PTY, text: 'marca', when: 'on-idle' })
    const fail = failWrites(['UPDATE'])
    fail(true)
    opts.status = 'idle'
    queue.onTurnEnded(PTY)
    await new Promise((r) => setTimeout(r, 600))
    expect(writes).toEqual([])
    expect(rows()).toEqual([expect.objectContaining({ state: 'queued' })])

    fail(false)
    queue.onTurnEnded(PTY)
    await new Promise((r) => setTimeout(r, 600))
    expect(writes).toEqual([`${PTY}:marca`])
    queue.dispose()
  })

  it('cancelar com o DELETE falhando: a linha não fica para trás, o poll retenta', async () => {
    vi.useFakeTimers()
    try {
      const { queue, snap } = makeQueue()
      const res = await queue.send({ sessionId: PTY, text: 'cancela', when: 'on-idle' })
      const fail = failWrites(['DELETE'])
      fail(true)
      queue.cancel(res.ok && !res.delivered ? res.queued.id : '')
      expect(snap()?.items).toEqual([])
      expect(rows()).toHaveLength(1)

      fail(false)
      await vi.advanceTimersByTimeAsync(POLL_MS)
      expect(rows()).toEqual([])
      queue.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('coalescing com o UPDATE falhando: devolve false e o banco segue com o texto entregável', async () => {
    const { queue } = makeQueue()
    const res = await queue.send({ sessionId: PTY, text: 'v1', when: 'on-idle' })
    const id = res.ok && !res.delivered ? res.queued.id : ''
    const fail = failWrites(['UPDATE'])
    fail(true)
    expect(queue.replaceText(id, 'v2')).toBe(false)
    expect(queue.snapshot().items[0].text).toBe('v1')
    expect(db.prepare('SELECT text FROM prompt_queue_items').get()).toEqual({ text: 'v1' })
    queue.dispose()
  })
})

// Linha no formato que o claude grava no JSONL da conversa.
function claudeLine(type: 'user' | 'assistant', text: string, at = Date.now()): string {
  return JSON.stringify({
    parentUuid: 'p',
    isSidechain: false,
    type,
    message:
      type === 'user'
        ? { role: 'user', content: text }
        : { role: 'assistant', content: [{ type: 'text', text }] },
    uuid: `${type}-${text}`,
    timestamp: new Date(at).toISOString(),
    userType: 'external',
    sessionId: CC,
  })
}

describe('transcriptVerdict (formato real do JSONL do claude)', () => {
  const since = Date.parse('2026-10-11T12:00:00.000Z')
  const user = (content: unknown, ts: string, extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      parentUuid: 'p',
      isSidechain: false,
      type: 'user',
      message: { role: 'user', content },
      uuid: 'u',
      timestamp: ts,
      sessionId: 's',
      ...extra,
    })
  const after = '2026-10-11T12:00:01.000Z'

  it('mensagem igual depois do delivering_at = found', () => {
    expect(transcriptVerdict(user('faz X\ne Y', after), 'faz X\r\ne Y', since)).toBe('found')
  })

  it('blocos de texto e queued_command também contam', () => {
    expect(transcriptVerdict(user([{ type: 'text', text: 'faz X' }], after), 'faz X', since)).toBe(
      'found',
    )
    const queued = JSON.stringify({
      type: 'attachment',
      attachment: { type: 'queued_command', prompt: 'faz X' },
      timestamp: after,
    })
    expect(transcriptVerdict(queued, 'faz X', since)).toBe('found')
  })

  it('mesma mensagem ANTES do delivering_at não prova a entrega', () => {
    expect(transcriptVerdict(user('faz X', '2026-10-11T11:00:00.000Z'), 'faz X', since)).toBe(
      'absent',
    )
  })

  it('isMeta e tool_result não são mensagem do usuário', () => {
    const meta = user('faz X', after, { isMeta: true })
    const tool = user([{ type: 'tool_result', content: 'faz X' }], after)
    expect(transcriptVerdict(`${meta}\n${tool}`, 'faz X', since)).toBe('absent')
  })

  it('conteúdo divergente só na formatação = unknown', () => {
    expect(transcriptVerdict(user('faz   X\n\ne Y', after), 'faz X e Y', since)).toBe('unknown')
  })

  it('slash command com args (forma de skill) = found', () => {
    const line = user(
      '<command-message>kz:do</command-message>\n<command-name>/kz:do</command-name>\n<command-args>implementa X</command-args>',
      after,
    )
    expect(transcriptVerdict(line, '/kz:do implementa X', since)).toBe('found')
  })

  it('slash command embutido (indentado, args vazios, nome sem barra) = found', () => {
    const builtin = user(
      '<command-name>/model</command-name>\n            <command-message>model</command-message>\n            <command-args></command-args>',
      after,
    )
    expect(transcriptVerdict(builtin, '/model', since)).toBe('found')
    const bare = user(
      '<command-message>browser-validate</command-message>\n<command-name>browser-validate</command-name>',
      after,
    )
    expect(transcriptVerdict(bare, '/browser-validate', since)).toBe('found')
  })

  it("'!' vira <bash-input> = found", () => {
    expect(
      transcriptVerdict(user('<bash-input> ls -la</bash-input>', after), '! ls -la', since),
    ).toBe('found')
  })

  it('texto idêntico só na folga de 2s (a mensagem anterior igual) é ambíguo = unknown', () => {
    const before = '2026-10-11T11:59:59.000Z'
    expect(transcriptVerdict(user('ok', before), 'ok', since)).toBe('unknown')
    expect(transcriptVerdict(user('ok', undefined as never), 'ok', since)).toBe('unknown')
  })

  it('na folga de 2s com queued_command = found (é a fila entregando)', () => {
    const queued = JSON.stringify({
      type: 'attachment',
      attachment: { type: 'queued_command', prompt: 'ok' },
      timestamp: '2026-10-11T11:59:59.000Z',
    })
    expect(transcriptVerdict(queued, 'ok', since)).toBe('found')
  })

  it('sem transcript = unknown', () => {
    expect(transcriptVerdict(null, 'faz X', since)).toBe('unknown')
  })
})

describe('hibernação × fila durável', () => {
  const WOKEN = 'pty-acordada'
  const rawRows = () =>
    db.prepare('SELECT state, raw, text, session_id FROM prompt_queue_items').all() as Array<{
      state: string
      raw: number
      text: string
      session_id: string
    }>

  it('o /exit é efêmero: enfileirado não vai para o app.db', async () => {
    const { queue } = makeQueue({ status: 'working' })
    const res = await queue.send({
      sessionId: PTY,
      text: '/exit',
      when: 'on-idle',
      ephemeral: true,
    })
    expect(res).toMatchObject({ ok: true, delivered: false })
    expect(rows()).toEqual([])
    queue.dispose()
  })

  it('redirect sem kill: o input retido segue a mesma linha até a sessão acordada e sai uma vez', async () => {
    db.prepare(
      `INSERT INTO sessions (id, repo_id, cc_session_id, status, started_at) VALUES (?, NULL, ?, 'running', 2)`,
    ).run(WOKEN, CC)
    let hibernating = true
    let wake!: (id: string | null) => void
    const writes: string[] = []
    // Estado da linha no instante do write: 'delivering' tem que estar gravado antes.
    const atWrite: unknown[] = []
    const stateOf = db.prepare('SELECT state FROM prompt_queue_items')
    const jsonl: string[] = []
    const q = makeQueue({
      status: 'idle',
      jsonl: () => jsonl.join('\n'),
      extra: {
        isHibernating: (id) => hibernating && id === PTY,
        redirectOnExit: () => new Promise<string | null>((r) => (wake = r)),
        write: (id, text, raw) => {
          atWrite.push(stateOf.all())
          writes.push(`${id}:${raw ? 'raw:' : ''}${text}`)
        },
      },
    })
    const { queue, running } = q
    running.add(WOKEN)

    const held = await queue.send({ sessionId: PTY, text: 'ab', when: 'on-idle', raw: true })
    if (!held.ok || held.delivered) throw new Error('input deveria ficar retido')
    expect(queue.replaceText(held.queued.id, 'abc\r')).toBe(true)
    expect(rawRows()).toEqual([{ state: 'queued', raw: 1, text: 'abc\r', session_id: PTY }])
    expect(writes).toEqual([])

    // A PTY sai; o wake sobe a conversa em outra PTY (o spawn chama onSessionLive)
    // antes de o redirect devolver: nada é puxado duas vezes.
    hibernating = false
    running.delete(PTY)
    queue.onSessionExit(PTY)
    queue.onSessionLive(WOKEN)
    wake(WOKEN)
    await new Promise((r) => setTimeout(r, 50))

    expect(writes).toEqual([`${WOKEN}:raw:abc\r`])
    // 'delivering' gravado antes do write cru.
    expect(atWrite).toEqual([[{ state: 'delivering' }]])
    expect(q.snap()?.lastEvent).toMatchObject({ kind: 'delivered', id: held.queued.id })
    // A linha só sai com a prova no transcript, como qualquer entrega.
    expect(rawRows()).toEqual([{ state: 'delivering', raw: 1, text: 'abc\r', session_id: WOKEN }])

    jsonl.push(claudeLine('user', 'abc'), claudeLine('assistant', 'ok'))
    queue.onTurnEnded(WOKEN)
    await new Promise((r) => setTimeout(r, 600))
    expect(writes).toHaveLength(1)
    expect(rawRows()).toEqual([])
    queue.dispose()
  })

  it('kill entre o redirect e a entrega: a linha já aponta para a sessão acordada', async () => {
    let wake!: (id: string | null) => void
    const { queue, running } = makeQueue({
      status: 'working',
      extra: {
        isHibernating: () => true,
        redirectOnExit: () => new Promise<string | null>((r) => (wake = r)),
      },
    })
    await queue.send({ sessionId: PTY, text: 'x', when: 'on-idle', raw: true })
    running.delete(PTY)
    queue.onSessionExit(PTY)
    wake(WOKEN)
    await new Promise((r) => setTimeout(r, 10))
    expect(rawRows()).toEqual([{ state: 'queued', raw: 1, text: 'x', session_id: WOKEN }])
    queue.dispose()
  })

  it('wake do redirect falhou: o input retido nunca é apagado, fica visível e Reenviar entrega quando a conversa volta', async () => {
    let hibernating = true
    let wake!: (id: string | null) => void
    const { queue, writes, running, snap } = makeQueue({
      status: 'idle',
      extra: {
        isHibernating: (id) => hibernating && id === PTY,
        redirectOnExit: () => new Promise<string | null>((r) => (wake = r)),
      },
    })
    const held = await queue.send({ sessionId: PTY, text: 'deploy\r', when: 'on-idle', raw: true })
    if (!held.ok || held.delivered) throw new Error('input deveria ficar retido')

    hibernating = false
    running.delete(PTY)
    queue.onSessionExit(PTY)
    wake(null)
    await new Promise((r) => setTimeout(r, 10))

    expect(writes).toEqual([])
    expect(rawRows()).toEqual([{ state: 'uncertain', raw: 1, text: 'deploy\r', session_id: PTY }])
    expect(snap()?.items).toEqual([
      expect.objectContaining({ id: held.queued.id, recovery: 'maybe-undelivered' }),
    ])
    expect(snap()?.lastEvent).toMatchObject({ kind: 'maybe-undelivered', id: held.queued.id })
    expect(snap()?.counters.sessionGone).toBe(0)

    // Reenviar com a conversa ainda dormindo: espera ela voltar, sem escrever.
    expect(queue.resend(held.queued.id)).toBe(true)
    expect(rawRows()).toEqual([{ state: 'queued', raw: 1, text: 'deploy\r', session_id: PTY }])
    expect(writes).toEqual([])

    db.prepare(
      `INSERT INTO sessions (id, repo_id, cc_session_id, status, started_at) VALUES (?, NULL, ?, 'running', 2)`,
    ).run(WOKEN, CC)
    running.add(WOKEN)
    queue.onSessionLive(WOKEN)
    queue.onTurnEnded(WOKEN)
    await new Promise((r) => setTimeout(r, 600))
    expect(writes).toEqual([`${WOKEN}:raw:deploy\r`])
    expect(rawRows()).toEqual([
      { state: 'delivering', raw: 1, text: 'deploy\r', session_id: WOKEN },
    ])
    queue.dispose()
  })

  it('wake falhou com o /exit efêmero ainda na fila: ele sai sem gravar nada', async () => {
    let wake!: (id: string | null) => void
    const { queue, running, snap } = makeQueue({
      status: 'working',
      extra: { redirectOnExit: () => new Promise<string | null>((r) => (wake = r)) },
    })
    await queue.send({ sessionId: PTY, text: '/exit', when: 'on-idle', ephemeral: true })
    running.delete(PTY)
    queue.onSessionExit(PTY)
    wake(null)
    await new Promise((r) => setTimeout(r, 10))
    expect(rawRows()).toEqual([])
    expect(snap()?.items).toEqual([])
    expect(snap()?.lastEvent).toMatchObject({ kind: 'session-gone' })
    queue.dispose()
  })
})
