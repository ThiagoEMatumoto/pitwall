/** @vitest-environment node */
import type Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

type IpcEvent = { sender: unknown; returnValue?: unknown }
type Listener = (event: IpcEvent, arg: unknown) => unknown

const wire = vi.hoisted(() => {
  const handlers = new Map<string, Listener>()
  const listeners = new Map<string, Listener>()
  const ipcMain = {
    handle(channel: string, fn: Listener) {
      handlers.set(channel, fn)
    },
    on(channel: string, fn: Listener) {
      listeners.set(channel, fn)
      return ipcMain
    },
  }
  return { handlers, listeners, ipcMain }
})

vi.mock('electron', () => ({ app: {}, ipcMain: wire.ipcMain }))
vi.mock('../services/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/db')>()),
  getDb: () => db,
}))

import { openAppDb } from '../services/db'
import { getComposerDraft } from '../services/composer-drafts'
import { drainPerfWindow, instrumentIpcMain } from '../services/perf-probe'
import { registerComposerDraftIpc } from './composer-drafts'
import {
  composerDraftKey,
  createDraftPersister,
  flushAllDrafts,
  flushAllDraftsSync,
  type DraftApi,
  type DraftPersister,
} from '../../../src/features/sessions/composer-draft-persister'

const KEY = composerDraftKey('pane-1', 'cc-1') as string
const sender = { id: 1, isDestroyed: () => false, send: () => {} }

let dir: string
let db: Database.Database
let persister: DraftPersister | null = null

// Fila do IPC de uma janela: invoke e send chegam ao main na ordem em que
// saíram; o sendSync só é atendido depois do que já estava na fila.
let queue: Array<() => void> = []

function deliver(): void {
  for (const run of queue.splice(0)) run()
}

function invoke<T>(channel: string, arg: unknown): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    queue.push(() => {
      try {
        resolve(wire.handlers.get(channel)!({ sender }, arg) as T)
      } catch (err) {
        reject(err)
      }
    })
  })
}

function send(channel: string, arg: unknown): void {
  queue.push(() => void wire.listeners.get(channel)!({ sender }, arg))
}

function sendSync<T>(channel: string, arg: unknown): T {
  deliver()
  const event: IpcEvent = { sender }
  wire.listeners.get(channel)!(event, arg)
  const res = event.returnValue as { ok: true; value: T } | { ok: false; error: string }
  if (!res.ok) throw new Error(res.error)
  return res.value
}

// Mesmos canais do sessionsApi do preload (electron/preload/index.ts).
const api: DraftApi = {
  get: (key) => invoke('sessions:get-draft', key),
  getSync: (key) => sendSync('sessions:get-draft-sync', key),
  save: (draft) => invoke('sessions:save-draft', draft),
  saveSync: (draft) => sendSync('sessions:save-draft-sync', draft),
  writeThrough: (draft) => send('sessions:write-draft', draft),
  clear: (key) => invoke('sessions:clear-draft', key),
}

async function hydratedPersister(): Promise<DraftPersister> {
  const p = createDraftPersister({ key: KEY, ccSessionId: 'cc-1', paneId: 'pane-1', api })
  persister = p
  const reading = p.hydrate(() => {})
  deliver()
  await reading
  // A janela da sonda começa depois da hidratação.
  drainPerfWindow(0)
  return p
}

function arrivals(): Record<string, number> {
  const { ipcIn } = drainPerfWindow(1000)
  return Object.fromEntries(Object.entries(ipcIn).map(([channel, s]) => [channel, s.n]))
}

beforeAll(() => {
  // Como no boot com CM_PERF=1: a sonda embrulha o ipcMain antes do registro.
  instrumentIpcMain(wire.ipcMain as never)
  registerComposerDraftIpc()
})

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cm-draft-flush-'))
  db = openAppDb(join(dir, 'app.db'))
  queue = []
})

afterEach(() => {
  persister?.dispose()
  persister = null
  deliver()
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('flush do rascunho na troca de pane (handlers reais do main + sonda)', () => {
  it('o rascunho chega ao main pelo canal assíncrono; o síncrono fica em zero', async () => {
    const p = await hydratedPersister()
    p.update({ text: 'digitado antes de trocar de pane', attachments: [] })

    const flushed = flushAllDrafts()
    deliver()
    await flushed

    expect(getComposerDraft(db, KEY)?.text).toBe('digitado antes de trocar de pane')
    const n = arrivals()
    expect(n['sessions:save-draft']).toBe(1)
    expect(n['sessions:save-draft-sync']).toBeUndefined()
    expect(n['sessions:get-draft-sync']).toBeUndefined()
  })

  it('a sonda enxerga o canal síncrono quando ele é usado (unload/quit)', async () => {
    const p = await hydratedPersister()
    p.update({ text: 'fechando a janela', attachments: [] })

    flushAllDraftsSync()

    expect(getComposerDraft(db, KEY)?.text).toBe('fechando a janela')
    expect(arrivals()['sessions:save-draft-sync']).toBe(1)
  })

  it('troca rápida de pane (ida e volta) grava uma vez só, sem o síncrono', async () => {
    const p = await hydratedPersister()
    p.update({ text: 'ida e volta', attachments: [] })

    void flushAllDrafts()
    void flushAllDrafts()
    deliver()

    expect(getComposerDraft(db, KEY)?.text).toBe('ida e volta')
    const n = arrivals()
    expect(n['sessions:save-draft']).toBe(1)
    expect(n['sessions:save-draft-sync']).toBeUndefined()
  })

  it('fechar a pane logo depois do blur: o save em voo chega ao main, sem o síncrono', async () => {
    const p = await hydratedPersister()
    p.update({ text: 'fechei logo depois', attachments: [] })
    void p.flush()

    p.dispose()
    persister = null
    deliver()

    expect(getComposerDraft(db, KEY)?.text).toBe('fechei logo depois')
    expect(arrivals()['sessions:save-draft-sync']).toBeUndefined()
  })

  it('fechar a pane logo depois de digitar, sem blur: o desmonte grava na hora', async () => {
    const p = await hydratedPersister()
    p.update({ text: 'fechei sem sair do campo', attachments: [] })

    p.dispose()
    persister = null

    expect(getComposerDraft(db, KEY)?.text).toBe('fechei sem sair do campo')
  })

  it('quit com flush assíncrono em voo: ao voltar do flush síncrono o commit já aconteceu', async () => {
    const p = await hydratedPersister()
    p.update({ text: 'saindo do app', attachments: [] })
    void flushAllDrafts()
    expect(getComposerDraft(db, KEY)).toBeNull()

    flushAllDraftsSync()

    expect(getComposerDraft(db, KEY)?.text).toBe('saindo do app')
  })

  it('duas gravações que chegam fora de ordem: a mais nova vence', async () => {
    const p = await hydratedPersister()
    p.update({ text: 'versão 1', attachments: [] })
    void p.flush()
    p.update({ text: 'versão 2', attachments: [] })
    void p.flush()

    queue.reverse()
    deliver()

    const read = api.get(KEY)
    deliver()
    expect((await read)?.text).toBe('versão 2')
  })
})
