/** @vitest-environment node */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { openAppDb } from './db'
import { fixture, scanOf } from './test-support/screen-scans'
import { runAndKill, runToEnd } from './test-support/kill-after-write'
import type { PromptQueueSnapshot } from '../../../shared/types/send-prompt'

// Fila durável contra kill -9 com processos de verdade: um filho enfileira pela
// PromptQueue + store reais sobre o app.db (openAppDb) e leva SIGKILL no estágio
// pedido; outro filho faz o boot (restore + resume da conversa numa PTY nova) com
// HOME temporário, onde o transcript da conversa está no formato real do claude.

const OLD_PTY = 'pty-antes-do-kill'
const NEW_PTY = 'pty-depois-do-resume'
const CC = '7d0c2a8e-1111-4c4c-9e9e-000000000001'
const TEXT = 'roda os testes do módulo de billing\ne me diz o que falhou'
const ENTRY = 'prompt-queue-process.ts'

let dir: string
let home: string
let dbPath: string
let transcript: string
let scanJson: string

beforeAll(async () => {
  // A tela que a fila relê é a captura real de um claude ocioso, pelo parser real.
  scanJson = JSON.stringify(await scanOf(fixture('claude-2.1.286-idle-prompt.ansi')))
})

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cm-pq-kill-'))
  home = join(dir, 'home')
  const projectDir = join(home, '.claude', 'projects', '-tmp-repo')
  mkdirSync(projectDir, { recursive: true })
  transcript = join(projectDir, `${CC}.jsonl`)
  dbPath = join(dir, 'app.db')
  const db = openAppDb(dbPath)
  const insert = db.prepare(
    `INSERT INTO sessions (id, repo_id, cc_session_id, status, started_at) VALUES (?, NULL, ?, 'running', 1)`,
  )
  insert.run(OLD_PTY, CC)
  // O resume cria outra linha em sessions para a mesma conversa.
  insert.run(NEW_PTY, CC)
  db.close()
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

// Histórico anterior da conversa, no formato que o claude grava.
function writeHistory(): void {
  const line = (o: Record<string, unknown>) => JSON.stringify(o)
  const base = { isSidechain: false, userType: 'external', cwd: '/tmp/repo', sessionId: CC }
  writeFileSync(
    transcript,
    [
      line({
        ...base,
        parentUuid: null,
        promptId: 'prompt-1',
        type: 'user',
        message: { role: 'user', content: 'mensagem antiga' },
        uuid: 'u-1',
        timestamp: new Date(Date.now() - 60_000).toISOString(),
      }),
      line({
        ...base,
        parentUuid: 'u-1',
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
        uuid: 'a-1',
        timestamp: new Date(Date.now() - 59_000).toISOString(),
      }),
    ].join('\n') + '\n',
  )
}

async function kill(stage: string): Promise<void> {
  const exit = await runAndKill({
    entry: ENTRY,
    dir,
    args: ['enqueue', dbPath, scanJson, OLD_PTY, TEXT, stage],
    marker: stage,
    env: { HOME: home, TRANSCRIPT: transcript, CC_SESSION_ID: CC },
  })
  expect(exit.signal).toBe('SIGKILL')
}

interface BootOutput {
  restored: PromptQueueSnapshot | null
  after: PromptQueueSnapshot | null
  writes: string[]
}

async function boot(): Promise<BootOutput> {
  const out = await runToEnd({
    entry: ENTRY,
    dir,
    args: ['boot', dbPath, scanJson, NEW_PTY],
    env: { HOME: home, TRANSCRIPT: transcript, CC_SESSION_ID: CC },
  })
  return JSON.parse(out.trim().split('\n').at(-1) as string) as BootOutput
}

function rows(): Array<{ id: string; state: string; session_id: string }> {
  const db = openAppDb(dbPath)
  try {
    return db.prepare('SELECT id, state, session_id FROM prompt_queue_items').all() as never
  } finally {
    db.close()
  }
}

describe('kill -9 com o item em cada estado', () => {
  it('queued: fica pendente no banco e o resume entrega uma única vez', async () => {
    writeHistory()
    await kill('queued')
    expect(rows()).toEqual([expect.objectContaining({ state: 'queued', session_id: OLD_PTY })])

    const first = await boot()
    expect(first.restored?.items).toEqual([
      expect.objectContaining({ text: TEXT, recovery: 'awaiting-session' }),
    ])
    expect(first.writes).toEqual([`${NEW_PTY}:${TEXT}`])
    expect(rows()).toEqual([])

    // Outro boot (ou outro resume) não traz a mensagem de novo.
    const second = await boot()
    expect(second.writes).toEqual([])
    expect(second.restored?.items).toEqual([])
  }, 30000)

  it('delivering antes do write: o transcript prova que não entrou e o boot reenvia uma vez', async () => {
    writeHistory()
    await kill('before-write')
    expect(rows()).toEqual([expect.objectContaining({ state: 'delivering' })])

    const first = await boot()
    expect(first.writes).toEqual([`${NEW_PTY}:${TEXT}`])
    expect(rows()).toEqual([])
    expect((await boot()).writes).toEqual([])
  }, 30000)

  it('escrito no PTY e kill antes de o claude gravar: a linha segue delivering e o boot reenvia uma vez', async () => {
    writeHistory()
    await kill('written')
    // O write retornou, mas não há prova de que a mensagem entrou na conversa.
    expect(rows()).toEqual([expect.objectContaining({ state: 'delivering' })])

    const first = await boot()
    expect(first.writes).toEqual([`${NEW_PTY}:${TEXT}`])
    expect(rows()).toEqual([])
    expect((await boot()).writes).toEqual([])
  }, 30000)

  it('delivering depois do write: o transcript prova que entrou e nada é reenviado', async () => {
    writeHistory()
    await kill('after-write')
    expect(rows()).toEqual([expect.objectContaining({ state: 'delivering' })])

    const first = await boot()
    expect(first.writes).toEqual([])
    expect(first.restored?.counters).toMatchObject({ restored: 1, restoredDelivered: 1 })
    expect(first.restored?.lastEvent).toMatchObject({ kind: 'delivered', text: TEXT })
    expect(rows()).toEqual([])
  }, 30000)

  it('delivering sem transcript: inconclusivo, marcado para o usuário e não reenviado', async () => {
    // Sem writeHistory: a conversa não tem transcript neste HOME.
    await kill('before-write')

    const first = await boot()
    expect(first.writes).toEqual([])
    expect(first.restored?.lastEvent).toMatchObject({ kind: 'maybe-undelivered', text: TEXT })
    expect(first.after?.items).toEqual([
      expect.objectContaining({ text: TEXT, recovery: 'maybe-undelivered', sessionId: NEW_PTY }),
    ])
    expect(first.after?.counters.maybeUndelivered).toBe(1)
    expect(rows()).toEqual([expect.objectContaining({ state: 'uncertain', session_id: NEW_PTY })])

    // Segue visível nos boots seguintes, sem reenviar sozinho.
    const second = await boot()
    expect(second.writes).toEqual([])
    expect(second.after?.items).toEqual([
      expect.objectContaining({ recovery: 'maybe-undelivered' }),
    ])
  }, 30000)

  it('confirmado pelo transcript (mensagem + resposta) antes do kill: não reaparece no boot', async () => {
    writeHistory()
    await kill('delivered')
    expect(rows()).toEqual([])

    const first = await boot()
    expect(first.writes).toEqual([])
    expect(first.restored?.items).toEqual([])
  }, 30000)
})
