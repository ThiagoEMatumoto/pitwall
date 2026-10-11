import type Database from 'better-sqlite3'
import type {
  ComposerDraft,
  ComposerDraftAttachment,
  ComposerDraftInput,
  VersionedDraftInput,
} from '../../../shared/types/composer-draft'
import { findTranscriptPath } from './transcript-path'

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

function writeDraftRow(db: Database.Database, draft: ComposerDraftInput, now: number): void {
  if (isEmptyDraft(draft)) {
    db.prepare('DELETE FROM composer_drafts WHERE draft_key = ?').run(draft.key)
    return
  }
  const attachments = JSON.stringify(draft.attachments.map(({ name, path }) => ({ name, path })))
  db.prepare(
    `INSERT OR REPLACE INTO composer_drafts
       (draft_key, cc_session_id, pane_id, text, attachments, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(draft.key, draft.ccSessionId, draft.paneId, draft.text, attachments, now)
}

// Rascunho vazio = sem rascunho: grava a remoção, não uma linha em branco.
export function saveComposerDraft(
  db: Database.Database,
  draft: ComposerDraftInput,
  now: number = Date.now(),
): void {
  writeDurably(db, () => writeDraftRow(db, draft, now))
}

// Write-through de cada tecla: uma transação, no synchronous da conexão (NORMAL).
// O commit no WAL sobrevive a kill -9 do processo; a queda de energia fica a cargo
// do saveComposerDraft (FULL) que o debounce do renderer manda logo depois.
export function saveComposerDraftsFast(
  db: Database.Database,
  drafts: ComposerDraftInput[],
  now: number = Date.now(),
): void {
  db.transaction(() => {
    for (const d of drafts) writeDraftRow(db, d, now)
  })()
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

// Sem gravação há mais que isto, o rascunho de pane fechada vai embora mesmo com
// a conversa ainda em disco.
export const DRAFT_GC_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000
// Rascunho cuja conversa não tem transcript só vai embora depois desta folga: cobre
// a sessão que ainda não gravou o JSONL e o crash no meio do Desfazer.
export const DRAFT_GC_ORPHAN_GRACE_MS = 7 * 24 * 60 * 60 * 1000

export interface OpenPaneRef {
  paneId?: string | null
  ccSessionId?: string | null
}

type DraftRef = Pick<DraftRow, 'draft_key' | 'pane_id' | 'cc_session_id' | 'updated_at'>

function hasTranscriptOnDisk(ccSessionId: string): boolean {
  return findTranscriptPath(ccSessionId) !== null
}

// GC dos rascunhos de panes fechadas. Fora do conjunto aberto (abertas + dormant)
// NÃO basta: o rascunho só sai se a conversa não tem mais transcript em disco (com
// a folga acima) ou se está há mais de `maxAgeMs` sem gravação. Devolve as chaves
// removidas.
export function gcComposerDrafts(
  db: Database.Database,
  openPanes: OpenPaneRef[],
  opts: {
    now?: number
    maxAgeMs?: number
    hasTranscript?: (ccSessionId: string) => boolean
  } = {},
): string[] {
  const now = opts.now ?? Date.now()
  const maxAgeMs = opts.maxAgeMs ?? DRAFT_GC_MAX_AGE_MS
  const hasTranscript = opts.hasTranscript ?? hasTranscriptOnDisk
  const paneIds = new Set(openPanes.map((p) => p.paneId).filter(Boolean))
  const ccs = new Set(openPanes.map((p) => p.ccSessionId).filter(Boolean))
  const rows = db
    .prepare(
      'SELECT draft_key, pane_id, cc_session_id, updated_at FROM composer_drafts WHERE updated_at < ?',
    )
    .all(now - DRAFT_GC_ORPHAN_GRACE_MS) as DraftRef[]
  const isOpen = (r: DraftRef) =>
    (r.pane_id !== null && paneIds.has(r.pane_id)) ||
    (r.cc_session_id !== null && ccs.has(r.cc_session_id))
  const stale = rows.filter(
    (r) =>
      !isOpen(r) &&
      (r.updated_at < now - maxAgeMs || !r.cc_session_id || !hasTranscript(r.cc_session_id)),
  )
  if (stale.length === 0) return []
  writeDurably(db, () => {
    const del = db.prepare('DELETE FROM composer_drafts WHERE draft_key = ?')
    for (const r of stale) del.run(r.draft_key)
  })
  return stale.map((r) => r.draft_key)
}

// GC acionado pelo renderer DEPOIS de um restore bem-sucedido, nunca às cegas no
// boot: com o restore bloqueado (crash-loop) as panes ainda não voltaram e o
// open_panes não diz quais vivem. Protege a união das panes que o renderer tem
// agora com as do open_panes gravado; open_panes ilegível = não apaga nada.
export function gcComposerDraftsAfterRestore(
  db: Database.Database,
  rendererPanes: OpenPaneRef[],
  opts: { now?: number; hasTranscript?: (ccSessionId: string) => boolean } = {},
): string[] {
  const row = db.prepare('SELECT open_panes FROM workspace_state WHERE id = 1').get() as
    { open_panes: string | null } | undefined
  let saved: OpenPaneRef[] = []
  if (row?.open_panes) {
    try {
      const parsed: unknown = JSON.parse(row.open_panes)
      if (!Array.isArray(parsed)) return []
      saved = parsed as OpenPaneRef[]
    } catch {
      return []
    }
  }
  return gcComposerDrafts(db, [...saved, ...rendererPanes], opts)
}

function joinDrafts(rows: DraftRow[]): { text: string; attachments: ComposerDraftAttachment[] } {
  const text = rows
    .map((r) => r.text)
    .filter((t) => t.length > 0)
    .join('\n\n')
  const attachments: ComposerDraftAttachment[] = []
  for (const a of rows.flatMap((r) => parseAttachments(r.attachments))) {
    if (!attachments.some((x) => x.path === a.path)) attachments.push(a)
  }
  return { text, attachments }
}

// Pane nova de uma conversa (reabrir pela lista dá outro paneId): sem rascunho
// próprio, herda os de panes fechadas da MESMA conversa — juntados do mais antigo
// ao mais novo, então nada se perde se houver mais de um. Os rascunhos de panes
// ainda abertas (`openPaneIds`) e o do quick look ('cc:') não são tocados. Devolve
// o rascunho adotado (null = nada a adotar).
export function adoptComposerDraft(
  db: Database.Database,
  target: { paneId: string; ccSessionId: string; openPaneIds: string[] },
  now: number = Date.now(),
): ComposerDraft | null {
  const key = `pane:${target.paneId}`
  if (getComposerDraft(db, key)) return null
  const open = new Set(target.openPaneIds)
  const rows = (
    db
      .prepare(
        `SELECT * FROM composer_drafts
         WHERE cc_session_id = ? AND pane_id IS NOT NULL AND draft_key != ?
         ORDER BY updated_at ASC`,
      )
      .all(target.ccSessionId, key) as DraftRow[]
  ).filter((r) => !open.has(r.pane_id as string))
  if (rows.length === 0) return null
  const merged = joinDrafts(rows)
  writeDurably(db, () => {
    db.prepare(
      `INSERT INTO composer_drafts
         (draft_key, cc_session_id, pane_id, text, attachments, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      key,
      target.ccSessionId,
      target.paneId,
      merged.text,
      JSON.stringify(merged.attachments),
      now,
    )
    const del = db.prepare('DELETE FROM composer_drafts WHERE draft_key = ?')
    for (const r of rows) del.run(r.draft_key)
  })
  return getComposerDraft(db, key)
}

// Fim definitivo da conversa (Encerrar confirmado, depois do Desfazer): apaga os
// rascunhos dela — da pane encerrada, de panes fechadas e do quick look —, menos
// os de panes que seguem abertas. Devolve as chaves removidas.
export function clearSessionDrafts(
  db: Database.Database,
  target: { ccSessionId: string | null; paneId: string | null; openPaneIds: string[] },
): string[] {
  const open = new Set(target.openPaneIds)
  const rows = db
    .prepare('SELECT * FROM composer_drafts WHERE cc_session_id = ? OR draft_key = ?')
    .all(target.ccSessionId, target.paneId ? `pane:${target.paneId}` : null) as DraftRow[]
  const gone = rows.filter((r) => !r.pane_id || !open.has(r.pane_id))
  if (gone.length === 0) return []
  writeDurably(db, () => {
    const del = db.prepare('DELETE FROM composer_drafts WHERE draft_key = ?')
    for (const r of gone) del.run(r.draft_key)
  })
  return gone.map((r) => r.draft_key)
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
export function parseVersionedDraftInput(raw: unknown): VersionedDraftInput {
  const o = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  if (typeof o.writer !== 'string' || o.writer.length === 0) throw new Error('rascunho sem autor')
  if (typeof o.seq !== 'number' || !Number.isSafeInteger(o.seq) || o.seq < 0) {
    throw new Error('rascunho sem versão')
  }
  return { ...parseComposerDraftInput(raw), writer: o.writer, seq: o.seq }
}

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
