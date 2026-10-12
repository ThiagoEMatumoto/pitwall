/** @vitest-environment node */
// Imagem colada citada por um item da fila durável não pode ser varrida antes da
// entrega: nem no exit da PTY, nem no boot depois de o item voltar do app.db.
import type Database from 'better-sqlite3'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { openAppDb } from './db'
import { buildImageFilename, isImageTempFile, isSessionImageTempFile } from './image-temp'
import { imageKeptByKeepers, registerImageKeeper, sweepImageTempDir } from './image-temp-sweep'
import { PromptQueue } from './prompt-queue'
import { createPromptQueueStore } from './prompt-queue-store'
import { fixture, scanOf } from './test-support/screen-scans'
import type { ScreenScan } from '../../../shared/tui/attention-reason'

const PTY = 'pty-img'
let idle: ScreenScan
let dir: string
let imgDir: string
let db: Database.Database
// O keeper é global no processo (como no main): aponta para a fila do teste atual.
let current: PromptQueue | null = null
registerImageKeeper((name) => current?.references(name) ?? false)

beforeAll(async () => {
  idle = await scanOf(fixture('claude-2.1.286-idle-prompt.ansi'))
})

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cm-img-keeper-'))
  imgDir = join(dir, 'tmp')
  mkdirSync(imgDir)
  db = openAppDb(join(dir, 'app.db'))
  db.prepare(
    `INSERT INTO sessions (id, repo_id, cc_session_id, status, started_at) VALUES (?, NULL, 'cc-img', 'running', 1)`,
  ).run(PTY)
})

afterEach(() => {
  current?.dispose()
  current = null
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

function makeQueue(running: Set<string>): PromptQueue {
  const queue = new PromptQueue({
    isRunning: (id) => running.has(id),
    status: () => 'working',
    screen: async () => idle,
    nativeStatus: () => true,
    handoffAsking: () => false,
    write: () => {},
    emit: () => {},
    warn: () => {},
    store: createPromptQueueStore(() => db),
  })
  current = queue
  return queue
}

function pasted(id: string): string {
  const path = join(imgDir, buildImageFilename({ id, mime: 'image/png', sessionId: PTY }))
  writeFileSync(path, new Uint8Array([0x89, 0x50, 0x4e, 0x47]))
  return path
}

describe('keeper de imagens da fila durável', () => {
  it('imagem de item queued sobrevive ao sweep do exit e ao do boot; a órfã sai', async () => {
    const running = new Set([PTY])
    const queue = makeQueue(running)
    const cited = pasted('cited')
    const orphan = pasted('orphan')
    await queue.send({ sessionId: PTY, text: `olha isto ${cited}`, when: 'on-idle' })

    // Exit da PTY (OOM): o item estaciona esperando a conversa, e o sweep da sessão roda.
    running.delete(PTY)
    queue.onSessionExit(PTY)
    sweepImageTempDir(imgDir, (n) => isSessionImageTempFile(n, PTY), imageKeptByKeepers)
    expect(existsSync(cited)).toBe(true)
    expect(existsSync(orphan)).toBe(false)

    // Kill + boot: processo novo, fila restaurada do app.db antes do sweep de órfãos.
    queue.dispose()
    const boot = makeQueue(new Set())
    boot.restore()
    sweepImageTempDir(imgDir, isImageTempFile, imageKeptByKeepers)
    expect(existsSync(cited)).toBe(true)

    // Item descartado: a imagem deixa de ser citada e o próximo sweep a recolhe.
    const id = boot.snapshot().items[0]?.id as string
    expect(boot.cancel(id)).toBe(true)
    sweepImageTempDir(imgDir, isImageTempFile, imageKeptByKeepers)
    expect(existsSync(cited)).toBe(false)
  })
})
