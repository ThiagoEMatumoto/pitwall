/** @vitest-environment node */
// Aviso de troca de apelido à mãe pela fila on-idle REAL. O que se trava aqui: com
// o menu de permissão aberto na mãe a nota NÃO é escrita (o Enter dela aprovaria o
// menu); fica segurada e sai no fim do turno. O handoff vem do store real e a tela
// sai do TuiMenuWatch real sobre capturas do claude 2.1.286.
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { migrations } from '../migrations/index'
import type { LiveStatus, ScreenScan } from '../../../../shared/tui/attention-reason'

let testDb: Database.Database
vi.mock('../db', () => ({ getDb: () => testDb }))
vi.mock('../transcript-path', () => ({ findTranscriptPath: () => null }))

let running = new Set<string>()
vi.mock('../pty-manager', () => ({
  ptyManager: { isRunning: (id: string) => running.has(id) },
}))

const store = await import('../handoff-store')
const { PromptQueue, SETTLE_MS } = await import('../prompt-queue')
const { TuiMenuWatch } = await import('../tui-menu-watch')
const { notifyMotherOfAliasChange, setMotherNoteSender } = await import('./notify-mother-alias')

const FIXTURES = join(__dirname, '..', '..', '..', '..', 'shared', 'tui', '__fixtures__')
const fixture = (name: string) => readFileSync(join(FIXTURES, name), 'utf8')

class FakePty extends EventEmitter {
  write(): void {}
}

async function scanOf(raw: string): Promise<ScreenScan> {
  const pty = new FakePty()
  const watch = new TuiMenuWatch()
  watch.attach(pty)
  pty.emit('spawn', { sessionId: 'probe', cols: 80, rows: 24 })
  pty.emit('data', { sessionId: 'probe', data: raw })
  const scan = await watch.rescan('probe')
  pty.emit('exit', { sessionId: 'probe', exitCode: 0 })
  if (!scan) throw new Error('sem scan')
  return scan
}

let PERMISSION: ScreenScan
let IDLE: ScreenScan
let DIRTY: ScreenScan

beforeAll(async () => {
  PERMISSION = await scanOf(fixture('claude-2.1.286-permission-bash.ansi'))
  IDLE = await scanOf(fixture('claude-2.1.286-idle-prompt.ansi'))
  DIRTY = await scanOf(fixture('claude-2.1.286-input-dirty.ansi'))
})

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

const MOTHER = 'sess-mae'
const SUCCESSOR = 'sess-sucessora'

function setupQueue(initial: ScreenScan) {
  const screen = { scan: initial, status: 'idle' as LiveStatus | null }
  const writes: Array<{ sessionId: string; text: string }> = []
  const deliveredFrom: Array<string | undefined> = []
  const queue = new PromptQueue({
    isRunning: (id) => running.has(id),
    status: () => screen.status,
    screen: async () => screen.scan,
    nativeStatus: () => true,
    handoffAsking: () => false,
    write: (sessionId, text) => writes.push({ sessionId, text }),
    delivered: (_to, from) => deliveredFrom.push(from),
    emit: () => {},
    warn: () => {},
  })
  setMotherNoteSender((input) => queue.send(input))
  return { queue, screen, writes, deliveredFrom }
}

function handoffWithMother(): string {
  const h = store.create({
    motherSessionId: MOTHER,
    targetRepoId: 'r1',
    task: 'refactor auth',
    composedPrompt: 'prompt',
  })
  store.markRunning(h.id, SUCCESSOR)
  return h.id
}

const notice = (handoffId: string) => ({
  handoffId,
  alias: 'bruno-auth',
  previousAlias: 'mauricio-auth',
})

describe('notifyMotherOfAliasChange — pela PromptQueue real', () => {
  beforeEach(() => {
    testDb = new Database(':memory:')
    testDb.pragma('foreign_keys = ON')
    applyAllMigrations(testDb)
    testDb
      .prepare(`INSERT INTO projects (id, name, created_at, updated_at) VALUES ('p1','P1',?,?)`)
      .run(Date.now(), Date.now())
    testDb
      .prepare(
        `INSERT INTO repos (id, project_id, label, path, position, created_at)
         VALUES ('r1','p1','Repo 1','/tmp/r1',0,?)`,
      )
      .run(Date.now())
    running = new Set([MOTHER, SUCCESSOR])
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    setMotherNoteSender(null)
    testDb.close()
  })

  it('mãe ociosa: a nota sai na hora, no PTY da MÃE, com origem na sucessora', async () => {
    const { writes, queue, deliveredFrom } = setupQueue(IDLE)
    const id = handoffWithMother()

    const res = await notifyMotherOfAliasChange(notice(id))
    queue.dispose()

    expect(res).toEqual({ delivered: true })
    expect(writes).toHaveLength(1)
    expect(writes[0]!.sessionId).toBe(MOTHER)
    expect(writes[0]!.text).toContain('bruno-auth')
    expect(writes[0]!.text).toContain('mauricio-auth')
    // A origem vai pro hook `delivered` da fila, que pulsa o mapa na escrita real.
    expect(deliveredFrom).toEqual([SUCCESSOR])
  })

  it('menu de permissão aberto: a nota fica held e só sai após onTurnEnded', async () => {
    const { writes, screen, queue } = setupQueue(PERMISSION)
    const id = handoffWithMother()

    const res = await notifyMotherOfAliasChange(notice(id))
    expect(res).toEqual({ delivered: false, queued: true })
    expect(writes).toHaveLength(0)
    const held = queue.snapshot().items
    expect(held).toHaveLength(1)
    expect(held[0]).toMatchObject({ sessionId: MOTHER, heldReason: 'menu-open', heldByMenu: 1 })

    // Humano resolve o menu, a mãe trabalha e o turno termina.
    screen.scan = IDLE
    queue.onTurnEnded(MOTHER)
    await vi.advanceTimersByTimeAsync(SETTLE_MS + 10)

    expect(writes).toHaveLength(1)
    expect(writes[0]!.sessionId).toBe(MOTHER)
    expect(writes[0]!.text).toContain('bruno-auth')
    expect(queue.snapshot().items).toHaveLength(0)
    expect(queue.snapshot().counters.delivered).toBe(1)
    queue.dispose()
  })

  it('rascunho na caixa da mãe: segura em vez de enviar junto', async () => {
    const { writes, queue } = setupQueue(DIRTY)
    const id = handoffWithMother()

    const res = await notifyMotherOfAliasChange(notice(id))
    expect(res.queued).toBe(true)
    expect(writes).toHaveLength(0)
    expect(queue.snapshot().items[0]!.heldReason).toBe('input-dirty')
    queue.dispose()
  })

  it('apelido com ESC[201~ não fecha o bracketed-paste', async () => {
    const { writes, queue } = setupQueue(IDLE)
    const id = handoffWithMother()

    await notifyMotherOfAliasChange({ handoffId: id, alias: 'evil\x1b[201~\rrm -rf' })
    queue.dispose()

    expect(writes[0]!.text).not.toContain('\x1b')
    expect(writes[0]!.text).not.toContain('\r')
  })

  it('mãe não viva: não enfileira e NÃO é erro', async () => {
    const { writes, queue } = setupQueue(IDLE)
    const id = handoffWithMother()
    running = new Set([SUCCESSOR])

    expect(await notifyMotherOfAliasChange(notice(id))).toEqual({
      delivered: false,
      reason: 'mother-not-running',
    })
    expect(writes).toHaveLength(0)
    expect(queue.snapshot().items).toHaveLength(0)
  })

  it('handoff sem mãe: silêncio', async () => {
    setupQueue(IDLE)
    const h = store.create({ targetRepoId: 'r1', task: 't', composedPrompt: 'p' })
    expect(await notifyMotherOfAliasChange(notice(h.id))).toEqual({
      delivered: false,
      reason: 'no-mother',
    })
  })

  it('handoff inexistente: silêncio', async () => {
    setupQueue(IDLE)
    expect((await notifyMotherOfAliasChange(notice('nao-existe'))).reason).toBe(
      'handoff-not-found',
    )
  })

  it('fila não ligada (boot sem IPC): degrada sem escrever nada', async () => {
    const id = handoffWithMother()
    expect(await notifyMotherOfAliasChange(notice(id))).toEqual({
      delivered: false,
      reason: 'no-queue',
    })
  })
})
