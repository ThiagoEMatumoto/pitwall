/** @vitest-environment node */
import type Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { openAppDb } from './db'
import { DURABLE_TTL_MS, PromptQueue } from './prompt-queue'
import {
  createPromptQueueStore,
  transcriptVerdict,
  type TranscriptVerdict,
} from './prompt-queue-store'
import { fixture, scanOf } from './test-support/screen-scans'
import type { LiveStatus, ScreenScan } from '../../../shared/tui/attention-reason'
import type { PromptQueueSnapshot } from '../../../shared/types/send-prompt'

const CC = 'cc-durable'
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
  opts: { status?: LiveStatus; now?: () => number; verdict?: TranscriptVerdict } = {},
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
    write: (id, text) => writes.push(`${id}:${text}`),
    emit: (s) => (last = s),
    warn: () => {},
    now: opts.now,
    store: createPromptQueueStore(() => db),
    deliveryInTranscript: () => opts.verdict ?? 'unknown',
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
    expect(rows()).toEqual([
      expect.objectContaining({ state: 'queued', session_id: PTY, cc_session_id: CC }),
    ])
    queue.dispose()
  })

  it('cancelar e session-gone removem a linha', async () => {
    const { queue } = makeQueue()
    const a = await queue.send({ sessionId: PTY, text: 'a', when: 'on-idle' })
    await queue.send({ sessionId: PTY, text: 'b', when: 'on-idle' })
    queue.cancel(a.ok && !a.delivered ? a.queued.id : '')
    expect(rows()).toHaveLength(1)
    queue.onSessionExit(PTY)
    expect(rows()).toEqual([])
  })

  it('quit limpo: as PTYs morrem mas os itens ficam para o próximo boot', async () => {
    const { queue } = makeQueue()
    await queue.send({ sessionId: PTY, text: 'fica', when: 'on-idle' })
    queue.suspendForShutdown()
    queue.onSessionExit(PTY)
    expect(rows()).toEqual([expect.objectContaining({ state: 'queued' })])
  })

  it('item restaurado expira depois de DURABLE_TTL_MS e conta em expiredRestored', async () => {
    let now = 1_000
    const first = makeQueue({ now: () => now })
    await first.queue.send({ sessionId: PTY, text: 'velha', when: 'on-idle' })
    first.queue.dispose()

    now += DURABLE_TTL_MS + 1
    const boot = makeQueue({ now: () => now })
    boot.queue.restore()
    expect(boot.snap()?.counters).toMatchObject({ restored: 1, expired: 1, expiredRestored: 1 })
    expect(boot.snap()?.lastEvent).toMatchObject({ kind: 'expired', text: 'velha' })
    expect(rows()).toEqual([])
  })

  it('maybe-undelivered: só sai com resend do usuário, e aí entrega uma vez', async () => {
    db.prepare(
      `INSERT INTO prompt_queue_items (id, session_id, cc_session_id, text, state, created_at, delivering_at)
       VALUES ('m1', 'pty-morta', ?, 'talvez', 'delivering', ?, ?)`,
    ).run(CC, Date.now(), Date.now())
    const boot = makeQueue({ status: 'idle', verdict: 'unknown' })
    boot.queue.restore()
    boot.queue.onSessionLive(PTY, CC)
    boot.queue.onTurnEnded(PTY)
    await new Promise((r) => setTimeout(r, 600))
    expect(boot.writes).toEqual([])
    expect(rows()).toEqual([expect.objectContaining({ state: 'uncertain', session_id: PTY })])

    expect(boot.queue.resend('m1')).toBe(true)
    boot.queue.onTurnEnded(PTY)
    await new Promise((r) => setTimeout(r, 600))
    expect(boot.writes).toEqual([`${PTY}:talvez`])
    expect(rows()).toEqual([])
    boot.queue.dispose()
  })

  it('PTY de outra conversa não puxa itens restaurados', async () => {
    db.prepare(
      `INSERT INTO prompt_queue_items (id, session_id, cc_session_id, text, state, created_at)
       VALUES ('q1', 'pty-morta', ?, 'minha', 'queued', ?)`,
    ).run(CC, Date.now())
    const boot = makeQueue({ status: 'idle' })
    boot.queue.restore()
    boot.queue.onSessionLive('pty-outra', 'cc-outra')
    expect(boot.snap()?.items).toEqual([
      expect.objectContaining({ id: 'q1', recovery: 'awaiting-session' }),
    ])
    boot.queue.dispose()
  })
})

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

  it('sem transcript = unknown', () => {
    expect(transcriptVerdict(null, 'faz X', since)).toBe('unknown')
  })
})
