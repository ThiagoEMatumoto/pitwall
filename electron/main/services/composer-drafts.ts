import type Database from 'better-sqlite3'
import type {
  ComposerDraft,
  ComposerDraftAttachment,
  ComposerDraftInput,
} from '../../../shared/types/composer-draft'

interface DraftRow {
  draft_key: string
  cc_session_id: string | null
  pane_id: string | null
  text: string
  attachments: string
  updated_at: number
}

// O app.db roda em WAL com synchronous=NORMAL: o commit sobrevive a kill -9 (o
// WAL já está no page cache do kernel), mas NÃO a queda de energia — o WAL só é
// fsyncado no checkpoint. Para o rascunho, FULL vale só nesta escrita: a conexão
// é única e síncrona (better-sqlite3), então nenhum outro statement intercala
// entre o set e o restore. Custo: um fsync do WAL por gravação (debounce de 500ms).
function writeDurably(db: Database.Database, write: () => void): void {
  const previous = db.pragma('synchronous', { simple: true }) as number
  db.pragma('synchronous = FULL')
  try {
    db.transaction(write)()
  } finally {
    db.pragma(`synchronous = ${Number(previous)}`)
  }
}

function isEmptyDraft(d: Pick<ComposerDraftInput, 'text' | 'attachments'>): boolean {
  return d.text.length === 0 && d.attachments.length === 0
}

// Rascunho vazio = sem rascunho: grava a remoção, não uma linha em branco.
export function saveComposerDraft(
  db: Database.Database,
  draft: ComposerDraftInput,
  now: number = Date.now(),
): void {
  if (isEmptyDraft(draft)) return clearComposerDraft(db, draft.key)
  const attachments = JSON.stringify(draft.attachments.map(({ name, path }) => ({ name, path })))
  writeDurably(db, () => {
    db.prepare(
      `INSERT OR REPLACE INTO composer_drafts
         (draft_key, cc_session_id, pane_id, text, attachments, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(draft.key, draft.ccSessionId, draft.paneId, draft.text, attachments, now)
  })
}

export function clearComposerDraft(db: Database.Database, key: string): void {
  writeDurably(db, () => {
    db.prepare('DELETE FROM composer_drafts WHERE draft_key = ?').run(key)
  })
}

function parseAttachments(raw: string): ComposerDraftAttachment[] {
  try {
    const list: unknown = JSON.parse(raw)
    if (!Array.isArray(list)) return []
    return list.filter(isAttachment)
  } catch {
    return []
  }
}

export function getComposerDraft(db: Database.Database, key: string): ComposerDraft | null {
  const row = db.prepare('SELECT * FROM composer_drafts WHERE draft_key = ?').get(key) as
    DraftRow | undefined
  if (!row) return null
  return {
    key: row.draft_key,
    ccSessionId: row.cc_session_id,
    paneId: row.pane_id,
    text: row.text,
    attachments: parseAttachments(row.attachments),
    updatedAt: row.updated_at,
  }
}

// Predicado do sweep de imagens: o arquivo aparece em algum rascunho persistido
// (no texto OU nos anexos — remover o chip não tira o caminho do prompt)?
export function draftReferencesFile(db: Database.Database): (filename: string) => boolean {
  const rows = db.prepare('SELECT text, attachments FROM composer_drafts').all() as Array<
    Pick<DraftRow, 'text' | 'attachments'>
  >
  return (filename) =>
    rows.some((r) => r.text.includes(filename) || r.attachments.includes(filename))
}

function isAttachment(v: unknown): v is ComposerDraftAttachment {
  if (typeof v !== 'object' || v === null) return false
  const o = v as Record<string, unknown>
  return typeof o.name === 'string' && typeof o.path === 'string'
}

function isNullableString(v: unknown): v is string | null {
  return v === null || typeof v === 'string'
}

// Fronteira do IPC: o payload vem do renderer.
export function parseComposerDraftInput(raw: unknown): ComposerDraftInput {
  if (typeof raw !== 'object' || raw === null) throw new Error('rascunho inválido')
  const o = raw as Record<string, unknown>
  if (typeof o.key !== 'string' || o.key.length === 0) throw new Error('rascunho sem chave')
  if (typeof o.text !== 'string') throw new Error('rascunho sem texto')
  if (!isNullableString(o.ccSessionId) || !isNullableString(o.paneId)) {
    throw new Error('rascunho com identidade inválida')
  }
  if (!Array.isArray(o.attachments) || !o.attachments.every(isAttachment)) {
    throw new Error('rascunho com anexos inválidos')
  }
  return {
    key: o.key,
    ccSessionId: o.ccSessionId,
    paneId: o.paneId,
    text: o.text,
    attachments: o.attachments,
  }
}
