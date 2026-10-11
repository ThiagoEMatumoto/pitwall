/** @vitest-environment node */
import type Database from 'better-sqlite3'
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: {} }))

import { openAppDb } from './db'
import {
  clearComposerDraft,
  draftReferencesFile,
  getComposerDraft,
  parseComposerDraftInput,
  saveComposerDraft,
} from './composer-drafts'
import { sweepImageTempDir } from './image-temp-sweep'
import { buildImageFilename, isImageTempFile } from './image-temp'
import {
  composerDraftKey,
  createDraftPersister,
  type DraftApi,
} from '../../../src/features/sessions/composer-draft-persister'

const KEY = composerDraftKey('pane-1', 'cc-1') as string

let dir: string
let dbPath: string
let db: Database.Database

// O persister do renderer ligado ao serviço do main sobre o MESMO arquivo — o
// IPC no meio é só transporte.
function realApi(conn: () => Database.Database): DraftApi {
  return {
    get: async (key) => getComposerDraft(conn(), key),
    save: async (draft) => saveComposerDraft(conn(), draft),
    clear: async (key) => clearComposerDraft(conn(), key),
  }
}

function reopen(): Database.Database {
  db.close()
  db = openAppDb(dbPath)
  return db
}

function newPersister() {
  return createDraftPersister({
    key: KEY,
    ccSessionId: 'cc-1',
    paneId: 'pane-1',
    api: realApi(() => db),
  })
}

async function typedAndPersisted(
  text: string,
  attachments = [] as { name: string; path: string }[],
) {
  const p = newPersister()
  await p.hydrate(() => {})
  p.update({ text, attachments })
  await vi.advanceTimersByTimeAsync(500)
  return p
}

beforeEach(() => {
  vi.useFakeTimers()
  dir = mkdtempSync(join(tmpdir(), 'cm-composer-draft-'))
  dbPath = join(dir, 'app.db')
  db = openAppDb(dbPath)
})

afterEach(() => {
  vi.useRealTimers()
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('rascunho durável do Composer (app.db real)', () => {
  it('grava só depois do debounce e uma nova conexão lê o rascunho íntegro', async () => {
    const p = newPersister()
    await p.hydrate(() => {})
    const text = 'refatora o parser\nlinha 2 — acentuação ✓'
    const attachments = [{ name: 'shot.png', path: join(dir, 'img-s1-abc.png') }]
    p.update({ text, attachments })

    await vi.advanceTimersByTimeAsync(499)
    expect(getComposerDraft(db, KEY)).toBeNull()
    await vi.advanceTimersByTimeAsync(1)

    const saved = getComposerDraft(reopen(), KEY)
    expect(saved).toMatchObject({
      key: KEY,
      ccSessionId: 'cc-1',
      paneId: 'pane-1',
      text,
      attachments,
    })
  })

  it('restaura no mount (hidratação) e o estado vazio do mount não apaga nada', async () => {
    await typedAndPersisted('rascunho do boot')
    reopen()

    const p = newPersister()
    p.update({ text: '', attachments: [] })
    const applied: string[] = []
    await p.hydrate((d) => applied.push(d.text))
    await vi.advanceTimersByTimeAsync(1000)

    expect(applied).toEqual(['rascunho do boot'])
    expect(getComposerDraft(db, KEY)?.text).toBe('rascunho do boot')
  })

  it('envio confirmado limpa o rascunho', async () => {
    const p = await typedAndPersisted('manda isso')
    const ok = await p.sendThenClear('manda isso', async () => true)
    expect(ok).toBe(true)
    expect(getComposerDraft(reopen(), KEY)).toBeNull()
  })

  it('envio recusado ou com erro NÃO limpa', async () => {
    const p = await typedAndPersisted('manda isso')
    expect(await p.sendThenClear('manda isso', async () => false)).toBe(false)
    expect(
      await p.sendThenClear('manda isso', async () => {
        throw new Error('session x not running')
      }),
    ).toBe(false)
    await vi.advanceTimersByTimeAsync(1000)
    expect(getComposerDraft(reopen(), KEY)?.text).toBe('manda isso')
  })

  it('texto digitado durante o envio vira o novo rascunho, não some', async () => {
    const p = await typedAndPersisted('primeiro')
    const ok = await p.sendThenClear('primeiro', async () => {
      p.update({ text: 'segundo', attachments: [] })
      return true
    })
    expect(ok).toBe(true)
    expect(getComposerDraft(reopen(), KEY)?.text).toBe('segundo')
  })

  it('a escrita sobe para FULL só na transação e devolve o synchronous do app', () => {
    saveComposerDraft(db, {
      key: KEY,
      ccSessionId: null,
      paneId: 'pane-1',
      text: 'x',
      attachments: [],
    })
    expect(db.pragma('synchronous', { simple: true })).toBe(1)
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal')
  })

  it('rejeita payload malformado na fronteira do IPC', () => {
    expect(() => parseComposerDraftInput({ key: '', text: 'a', attachments: [] })).toThrow()
    expect(() =>
      parseComposerDraftInput({
        key: 'k',
        text: 'a',
        ccSessionId: null,
        paneId: null,
        attachments: [{ name: 1 }],
      }),
    ).toThrow()
  })
})

describe('sweep de imagens coladas', () => {
  it('poupa a imagem referenciada por rascunho persistido e remove a órfã', async () => {
    const tmp = join(dir, 'tmp')
    const inText = buildImageFilename({ id: 'a', mime: 'image/png', sessionId: 's1' })
    const inChip = buildImageFilename({ id: 'b', mime: 'image/png', sessionId: 's1' })
    const orphan = buildImageFilename({ id: 'c', mime: 'image/png', sessionId: 's1' })
    const { mkdirSync } = await import('node:fs')
    mkdirSync(tmp)
    for (const n of [inText, inChip, orphan, 'outro.txt']) writeFileSync(join(tmp, n), 'x')

    // Uma pane com o caminho no texto; outra só com o chip (o texto foi editado).
    saveComposerDraft(db, {
      key: 'pane:a',
      ccSessionId: 'cc-a',
      paneId: 'a',
      text: `olha ${join(tmp, inText)} aqui`,
      attachments: [],
    })
    saveComposerDraft(db, {
      key: 'pane:b',
      ccSessionId: null,
      paneId: 'b',
      text: 'sem caminho',
      attachments: [{ name: 'b.png', path: join(tmp, inChip) }],
    })

    // Boot: nova conexão, mesmo predicado do sweepOrphanImageTemps.
    sweepImageTempDir(tmp, isImageTempFile, draftReferencesFile(reopen()))

    expect(readdirSync(tmp).sort()).toEqual([inText, inChip, 'outro.txt'].sort())
    expect(existsSync(join(tmp, orphan))).toBe(false)

    // Enviado o rascunho, o próximo sweep pode levar a imagem.
    clearComposerDraft(db, 'pane:a')
    sweepImageTempDir(tmp, isImageTempFile, draftReferencesFile(db))
    expect(existsSync(join(tmp, inText))).toBe(false)
    expect(existsSync(join(tmp, inChip))).toBe(true)
  })
})
