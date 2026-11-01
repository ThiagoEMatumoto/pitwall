/** @vitest-environment node */
import type Database from 'better-sqlite3'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: {} }))

// HOME temporário ANTES de importar: o localizador de transcript real
// (transcript-path) fixa ~/.claude/projects no import.
const home = mkdtempSync(join(tmpdir(), 'cm-draft-gc-home-'))
process.env.HOME = home

const { openAppDb } = await import('./db')
const {
  DRAFT_GC_MAX_AGE_MS,
  DRAFT_GC_ORPHAN_GRACE_MS,
  draftReferencesFile,
  gcComposerDraftsAfterRestore,
  saveComposerDraft,
} = await import('./composer-drafts')
const { findTranscriptPath } = await import('./transcript-path')
const { sweepImageTempDir } = await import('./image-temp-sweep')
const { buildImageFilename, isImageTempFile } = await import('./image-temp')

const DAY = 24 * 60 * 60 * 1000
const NOW = 1_800_000_000_000

const dir = mkdtempSync(join(tmpdir(), 'cm-draft-gc-'))
let db: Database.Database

// Layout real do Claude Code: ~/.claude/projects/<cwd-encoded>/<cc>.jsonl
function writeTranscript(cc: string) {
  const projectDir = join(home, '.claude', 'projects', '-home-user-repo')
  mkdirSync(projectDir, { recursive: true })
  writeFileSync(join(projectDir, `${cc}.jsonl`), '{"type":"user"}\n')
}

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

beforeEach(() => {
  db?.close()
  rmSync(join(home, '.claude'), { recursive: true, force: true })
  db = openAppDb(join(mkdtempSync(join(dir, 'db-')), 'app.db'))
})

afterAll(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
  rmSync(home, { recursive: true, force: true })
})

describe('GC de rascunhos (pós-restore)', () => {
  it('usa o localizador real: o transcript criado no HOME temporário é achado', () => {
    writeTranscript('cc-real')
    expect(findTranscriptPath('cc-real')).toContain(join(home, '.claude', 'projects'))
  })

  it('rascunho de 10 dias de pane fechada com transcript em disco é mantido', () => {
    writeTranscript('cc-kept')
    const key = draft('p-closed', 'cc-kept', NOW - 10 * DAY)
    expect(gcComposerDraftsAfterRestore(db, [], { now: NOW })).toEqual([])
    expect(keys()).toEqual([key])
  })

  it('rascunho de pane fechada sem transcript em disco é apagado', () => {
    const key = draft('p-closed', 'cc-no-transcript', NOW - 10 * DAY)
    expect(gcComposerDraftsAfterRestore(db, [], { now: NOW })).toEqual([key])
    expect(keys()).toEqual([])
  })

  it('31 dias sem gravação: apagado mesmo com transcript', () => {
    writeTranscript('cc-old')
    const key = draft('p-closed', 'cc-old', NOW - 31 * DAY)
    expect(gcComposerDraftsAfterRestore(db, [], { now: NOW })).toEqual([key])
  })

  it('sem transcript, mas dentro da folga: mantido (sessão nova, crash no Desfazer)', () => {
    const key = draft('p-closed', 'cc-fresh', NOW - DRAFT_GC_ORPHAN_GRACE_MS + 60_000)
    expect(gcComposerDraftsAfterRestore(db, [], { now: NOW })).toEqual([])
    expect(keys()).toEqual([key])
  })

  it('pane aberta (renderer ou open_panes) nunca é coletada, nem velha nem sem transcript', () => {
    const old = NOW - DRAFT_GC_MAX_AGE_MS - DAY
    const inRenderer = draft('p-renderer', 'cc-a', old)
    const inSaved = draft('p-saved', 'cc-b', old)
    const quickLookOpen = draft(null, 'cc-a', old)
    const gone = draft('p-gone', 'cc-c', old)
    setOpenPanes([{ ccSessionId: 'cc-b', paneId: 'p-saved' }])

    const removed = gcComposerDraftsAfterRestore(
      db,
      [{ paneId: 'p-renderer', ccSessionId: 'cc-a' }],
      { now: NOW },
    )
    expect(removed).toEqual([gone])
    expect(keys()).toEqual([quickLookOpen, inRenderer, inSaved].sort())
  })

  it('open_panes ilegível: não apaga nada', () => {
    draft('p-gone', 'cc-gone', NOW - 40 * DAY)
    setOpenPanes('{nao é json')
    expect(gcComposerDraftsAfterRestore(db, [], { now: NOW })).toEqual([])
    expect(keys()).toEqual(['pane:p-gone'])
  })

  it('o sweep de imagens libera só as dos rascunhos coletados', () => {
    const tmp = join(dir, `tmp-gc-${Date.now()}`)
    mkdirSync(tmp)
    const kept = buildImageFilename({ id: 'k', mime: 'image/png', sessionId: 's1' })
    const freed = buildImageFilename({ id: 'f', mime: 'image/png', sessionId: 's1' })
    for (const n of [kept, freed]) writeFileSync(join(tmp, n), 'x')
    writeTranscript('cc-kept')
    for (const [paneId, cc, file] of [
      ['p-kept', 'cc-kept', kept],
      ['p-gone', 'cc-gone', freed],
    ]) {
      saveComposerDraft(
        db,
        {
          key: `pane:${paneId}`,
          ccSessionId: cc,
          paneId,
          text: 'x',
          attachments: [{ name: 'i.png', path: join(tmp, file) }],
        },
        NOW - 10 * DAY,
      )
    }

    gcComposerDraftsAfterRestore(db, [], { now: NOW })
    sweepImageTempDir(tmp, isImageTempFile, draftReferencesFile(db))
    expect(readdirSync(tmp)).toEqual([kept])
  })
})
