/** @vitest-environment node */
import type Database from 'better-sqlite3'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: {} }))

import { openAppDb } from './db'
import {
  clearComposerDraft,
  DRAFT_GC_MAX_AGE_MS,
  draftReferencesFile,
  gcComposerDraftsAtBoot,
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
    getSync: (key) => getComposerDraft(conn(), key),
    save: async (draft) => saveComposerDraft(conn(), draft),
    saveSync: (draft) => saveComposerDraft(conn(), draft),
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

describe('hidratação × digitação (corrida)', () => {
  it('digitou antes da leitura terminar: salvo e digitado são juntados, nada se perde', async () => {
    await typedAndPersisted('salvo antes do reboot', [{ name: 'a.png', path: '/x/img-s-a.png' }])
    reopen()

    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const api = realApi(() => db)
    const p = createDraftPersister({
      key: KEY,
      ccSessionId: 'cc-1',
      paneId: 'pane-1',
      api: { ...api, get: async (k) => (await gate, api.get(k)) },
    })
    const applied: Array<{ text: string; merged: boolean }> = []
    const reading = p.hydrate((d, merged) => applied.push({ text: d.text, merged }))
    p.update({ text: 'digitado no boot', attachments: [{ name: 'b.png', path: '/x/img-s-b.png' }] })
    await vi.advanceTimersByTimeAsync(1000)
    // Antes da leitura, nada é gravado: o salvo segue intacto.
    expect(getComposerDraft(db, KEY)?.text).toBe('salvo antes do reboot')

    release()
    await reading
    expect(applied).toEqual([{ text: 'salvo antes do reboot\n\ndigitado no boot', merged: true }])
    await vi.advanceTimersByTimeAsync(500)
    expect(getComposerDraft(reopen(), KEY)).toMatchObject({
      text: 'salvo antes do reboot\n\ndigitado no boot',
      attachments: [
        { name: 'a.png', path: '/x/img-s-a.png' },
        { name: 'b.png', path: '/x/img-s-b.png' },
      ],
    })
  })

  it('memória do remount (seed) vale mais que o banco: sem merge, sem leitura', async () => {
    await typedAndPersisted('versão antiga')
    const p = newPersister()
    p.seed({ text: 'versão antiga + mais', attachments: [] })
    p.flushSync()
    expect(getComposerDraft(reopen(), KEY)?.text).toBe('versão antiga + mais')
  })

  it('flushSync e dispose gravam na hora, sem esperar o debounce', async () => {
    const p = newPersister()
    await p.hydrate(() => {})
    p.update({ text: 'blur', attachments: [] })
    p.flushSync()
    expect(getComposerDraft(db, KEY)?.text).toBe('blur')
    p.update({ text: 'desmontou', attachments: [] })
    p.dispose()
    expect(getComposerDraft(reopen(), KEY)?.text).toBe('desmontou')
  })
})

describe('GC de rascunhos no boot', () => {
  const NOW = 1_800_000_000_000
  const OLD = NOW - DRAFT_GC_MAX_AGE_MS - 1
  const RECENT = NOW - DRAFT_GC_MAX_AGE_MS + 60_000

  function draft(paneId: string | null, cc: string | null, at: number) {
    const key = paneId ? `pane:${paneId}` : `cc:${cc}`
    saveComposerDraft(db, { key, ccSessionId: cc, paneId, text: `t-${key}`, attachments: [] }, at)
    return key
  }

  function setOpenPanes(panes: unknown) {
    db.prepare(
      `INSERT INTO workspace_state (id, open_panes, last_opened_at) VALUES (1, ?, 0)
       ON CONFLICT(id) DO UPDATE SET open_panes = excluded.open_panes`,
    ).run(typeof panes === 'string' ? panes : JSON.stringify(panes))
  }

  const keys = () =>
    (
      db.prepare('SELECT draft_key FROM composer_drafts ORDER BY draft_key').all() as {
        draft_key: string
      }[]
    ).map((r) => r.draft_key)

  it('apaga só os de panes sumidas há mais de 7 dias; vivas e dormant ficam', () => {
    const live = draft('p-live', 'cc-live', OLD)
    const sleeping = draft('p-dormant', 'cc-dormant', OLD)
    const goneOld = draft('p-gone-old', 'cc-gone', OLD)
    const goneRecent = draft('p-gone-recent', 'cc-gone2', RECENT)
    const quickLookLive = draft(null, 'cc-live', OLD)
    const quickLookGone = draft(null, 'cc-x', OLD)
    // O open_panes tem as abertas E as dormant (o snapshot é o mesmo).
    setOpenPanes([
      { ccSessionId: 'cc-live', paneId: 'p-live' },
      { ccSessionId: 'cc-dormant', paneId: 'p-dormant' },
    ])

    expect(gcComposerDraftsAtBoot(reopen(), NOW).sort()).toEqual([goneOld, quickLookGone].sort())
    expect(keys()).toEqual([quickLookLive, goneRecent, live, sleeping].sort())
  })

  it('open_panes ilegível: não apaga nada', () => {
    draft('p-gone-old', 'cc-gone', OLD)
    setOpenPanes('{nao é json')
    expect(gcComposerDraftsAtBoot(db, NOW)).toEqual([])
    expect(keys()).toEqual(['pane:p-gone-old'])
  })

  it('libera as imagens só dos rascunhos coletados (GC antes do sweep do boot)', () => {
    const tmp = join(dir, 'tmp-gc')
    mkdirSync(tmp)
    const kept = buildImageFilename({ id: 'k', mime: 'image/png', sessionId: 's1' })
    const freed = buildImageFilename({ id: 'f', mime: 'image/png', sessionId: 's1' })
    for (const n of [kept, freed]) writeFileSync(join(tmp, n), 'x')
    saveComposerDraft(
      db,
      {
        key: 'pane:p-live',
        ccSessionId: 'cc-live',
        paneId: 'p-live',
        text: 'vivo',
        attachments: [{ name: 'k.png', path: join(tmp, kept) }],
      },
      OLD,
    )
    saveComposerDraft(
      db,
      {
        key: 'pane:p-gone',
        ccSessionId: 'cc-gone',
        paneId: 'p-gone',
        text: 'sumiu',
        attachments: [{ name: 'f.png', path: join(tmp, freed) }],
      },
      OLD,
    )
    setOpenPanes([{ ccSessionId: 'cc-live', paneId: 'p-live' }])

    gcComposerDraftsAtBoot(db, NOW)
    sweepImageTempDir(tmp, isImageTempFile, draftReferencesFile(db))
    expect(readdirSync(tmp)).toEqual([kept])
  })
})

describe('sweep de imagens coladas', () => {
  it('poupa a imagem referenciada por rascunho persistido e remove a órfã', async () => {
    const tmp = join(dir, 'tmp')
    const inText = buildImageFilename({ id: 'a', mime: 'image/png', sessionId: 's1' })
    const inChip = buildImageFilename({ id: 'b', mime: 'image/png', sessionId: 's1' })
    const orphan = buildImageFilename({ id: 'c', mime: 'image/png', sessionId: 's1' })
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
