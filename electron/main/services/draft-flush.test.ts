/** @vitest-environment node */
import type Database from 'better-sqlite3'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: {} }))

import { openAppDb } from './db'
import {
  clearComposerDraft,
  draftReferencesFile,
  getComposerDraft,
  saveComposerDraft,
} from './composer-drafts'
import {
  createDraftFlushCoordinator,
  DRAFT_FLUSH_REQUEST_CHANNEL,
  DRAFT_FLUSH_TIMEOUT_MS,
  flushBeforeQuit,
  type DraftFlushCoordinator,
} from './draft-flush'
import { sweepAfterDraftFlush, sweepImageTempDir } from './image-temp-sweep'
import { buildImageFilename, isSessionImageTempFile } from './image-temp'
import {
  createDraftPersister,
  flushAllDraftsSync,
  type DraftPersister,
} from '../../../src/features/sessions/composer-draft-persister'

// O main pede o flush; o "renderer" aqui é o persister REAL sobre o app.db real,
// respondendo como o draft-flush-hooks: flushAllDraftsSync e depois o ack. A
// latência do IPC é simulada com timer.

let dir: string
let db: Database.Database
let persisters: DraftPersister[]

beforeEach(() => {
  vi.useFakeTimers()
  dir = mkdtempSync(join(tmpdir(), 'cm-draft-flush-'))
  db = openAppDb(join(dir, 'app.db'))
  persisters = []
})

afterEach(() => {
  for (const p of persisters) p.dispose()
  vi.useRealTimers()
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

async function typed(
  paneId: string,
  text: string,
  attachments = [] as { name: string; path: string }[],
) {
  const p = createDraftPersister({
    key: `pane:${paneId}`,
    ccSessionId: `cc-${paneId}`,
    paneId,
    api: {
      get: async (k) => getComposerDraft(db, k),
      getSync: (k) => getComposerDraft(db, k),
      save: async (d) => saveComposerDraft(db, d),
      saveSync: (d) => saveComposerDraft(db, d),
      clear: async (k) => clearComposerDraft(db, k),
    },
  })
  persisters.push(p)
  await p.hydrate(() => {})
  p.update({ text, attachments })
  return p
}

// Janela que responde ao pedido depois de `latencyMs` (ou nunca, com null).
function rendererWindow(coord: DraftFlushCoordinator, id: number, latencyMs: number | null) {
  const sent: string[] = []
  coord.remember({
    id,
    isDestroyed: () => false,
    send: (channel, requestId) => {
      sent.push(channel)
      if (latencyMs === null) return
      setTimeout(() => {
        flushAllDraftsSync()
        coord.ack(requestId, id)
      }, latencyMs)
    },
  })
  return sent
}

describe('before-quit espera o flush dos rascunhos', () => {
  it('o shutdown só segue depois do ack, com o digitado do debounce já no app.db', async () => {
    const coord = createDraftFlushCoordinator()
    const sent = rendererWindow(coord, 1, 200)
    await typed('p-quit', 'digitado 100ms antes do quit')

    let shutdown = false
    const quit = flushBeforeQuit({
      flushDrafts: () => coord.request(),
      flushSync: async () => {},
      syncTimeoutMs: 6000,
    }).then(() => {
      shutdown = true
      // Aqui o index.ts roda o closeDb: o rascunho tem que estar commitado.
      return getComposerDraft(db, 'pane:p-quit')?.text
    })

    await vi.advanceTimersByTimeAsync(150)
    expect(shutdown).toBe(false)
    expect(getComposerDraft(db, 'pane:p-quit')).toBeNull()
    await vi.advanceTimersByTimeAsync(60)
    expect(await quit).toBe('digitado 100ms antes do quit')
    expect(sent).toEqual([DRAFT_FLUSH_REQUEST_CHANNEL])
  })

  it('renderer que não responde não segura o quit além do timeout de ~1,5s', async () => {
    const coord = createDraftFlushCoordinator()
    rendererWindow(coord, 1, null)
    let done = false
    void flushBeforeQuit({
      flushDrafts: () => coord.request(),
      flushSync: async () => {},
      syncTimeoutMs: 6000,
    }).then(() => (done = true))

    await vi.advanceTimersByTimeAsync(DRAFT_FLUSH_TIMEOUT_MS - 1)
    expect(done).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(done).toBe(true)
  })

  it('espera todas as janelas com Composer; janela destruída não conta', async () => {
    const coord = createDraftFlushCoordinator()
    rendererWindow(coord, 1, 10)
    rendererWindow(coord, 2, 300)
    coord.remember({ id: 3, isDestroyed: () => true, send: () => {} })
    let result: boolean | null = null
    void coord.request().then((ok) => (result = ok))
    await vi.advanceTimersByTimeAsync(100)
    expect(result).toBeNull()
    await vi.advanceTimersByTimeAsync(250)
    expect(result).toBe(true)
  })

  it('sem janela com Composer resolve na hora', async () => {
    expect(await createDraftFlushCoordinator().request()).toBe(true)
  })
})

describe('sweep de imagens no exit da sessão', () => {
  function pasted(id: string) {
    const tmp = join(dir, 'tmp')
    mkdirSync(tmp, { recursive: true })
    const name = buildImageFilename({ id, mime: 'image/png', sessionId: 'sess-1' })
    writeFileSync(join(tmp, name), 'png')
    return { tmp, name, path: join(tmp, name) }
  }

  const sweepSession = (tmp: string) => () =>
    sweepImageTempDir(tmp, (n) => isSessionImageTempFile(n, 'sess-1'), draftReferencesFile(db))

  it('a imagem colada ainda no debounce é gravada pelo flush e o sweep a poupa', async () => {
    const img = pasted('kept')
    const sent = pasted('sent')
    await typed('p-exit', 'olha isso', [{ name: 'a.png', path: img.path }])
    expect(draftReferencesFile(db)(img.name)).toBe(false)

    const coord = createDraftFlushCoordinator()
    rendererWindow(coord, 1, 20)
    const swept = sweepAfterDraftFlush(() => coord.request(), sweepSession(img.tmp))
    await vi.advanceTimersByTimeAsync(20)

    expect(await swept).toBe(true)
    expect(existsSync(img.path)).toBe(true)
    expect(existsSync(sent.path)).toBe(false)
  })

  it('sem confirmação do flush, não apaga nada', async () => {
    const img = pasted('pending')
    await typed('p-exit2', 'pendente', [{ name: 'a.png', path: img.path }])
    const coord = createDraftFlushCoordinator()
    rendererWindow(coord, 1, null)
    const swept = sweepAfterDraftFlush(() => coord.request(), sweepSession(img.tmp))
    await vi.advanceTimersByTimeAsync(DRAFT_FLUSH_TIMEOUT_MS)

    expect(await swept).toBe(false)
    expect(existsSync(img.path)).toBe(true)
  })
})
