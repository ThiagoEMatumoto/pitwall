// CRUD do mapa de sessões: posições por escopo, notas, grupos do usuário e os
// campos de memória de trabalho da sessão (propósito, grupo, "onde parei").
// Machine-local: nada daqui entra no sync.
import { randomUUID } from 'node:crypto'
import { getDb } from './db'
import type {
  CanvasCardView,
  CanvasEntityKind,
  CanvasNote,
  CanvasPosition,
  CanvasPositionInput,
  CanvasScope,
  CanvasState,
  CanvasViewStateInput,
  CardViewState,
  CreateCanvasNoteInput,
  CreateSessionGroupInput,
  SessionGroup,
  UpdateCanvasNoteInput,
  UpdateSessionGroupInput,
} from '../../../shared/types/canvas'

interface PositionRow {
  scope: string
  kind: CanvasEntityKind
  entity_id: string
  // NULL = linha só com view_state (cartão que nunca foi arrastado).
  x: number | null
  y: number | null
  w: number | null
  h: number | null
  view_state: string | null
}

const VIEW_STATES: ReadonlySet<string> = new Set<CardViewState>(['collapsed', 'open', 'terminal'])

interface NoteRow {
  id: string
  scope: string
  body_md: string
  attached_session_id: string | null
  color: string | null
  created_at: number
  updated_at: number
}

interface GroupRow {
  id: string
  scope: string
  name: string
  color: string | null
  created_at: number
}

function toPosition(r: PositionRow & { x: number; y: number }): CanvasPosition {
  return { scope: r.scope, kind: r.kind, entityId: r.entity_id, x: r.x, y: r.y, w: r.w, h: r.h }
}

function hasPosition(r: PositionRow): r is PositionRow & { x: number; y: number } {
  return r.x != null && r.y != null
}

function toNote(r: NoteRow): CanvasNote {
  return {
    id: r.id,
    scope: r.scope,
    bodyMd: r.body_md,
    attachedSessionId: r.attached_session_id,
    color: r.color,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

function toGroup(r: GroupRow): SessionGroup {
  return { id: r.id, scope: r.scope, name: r.name, color: r.color, createdAt: r.created_at }
}

export function getCanvas(scope: CanvasScope): CanvasState {
  const db = getDb()
  const positions = db
    .prepare('SELECT * FROM canvas_positions WHERE scope = ? ORDER BY kind, entity_id')
    .all(scope) as PositionRow[]
  // Notas e grupos de TODOS os escopos: uma nota presa a uma sessão aparece em
  // todo mapa que mostra a sessão, e uma sessão agrupada no mapa de um projeto
  // continua agrupada no global — o leitor (graph-to-flow) decide o que mostra.
  const notes = db.prepare('SELECT * FROM canvas_notes ORDER BY created_at, id').all() as NoteRow[]
  const groups = db
    .prepare('SELECT * FROM session_groups ORDER BY created_at, id')
    .all() as GroupRow[]
  const views: CanvasCardView[] = positions
    .filter((r) => r.kind === 'session' && r.view_state && VIEW_STATES.has(r.view_state))
    .map((r) => ({ sessionId: r.entity_id, viewState: r.view_state as CardViewState }))
  return {
    scope,
    positions: positions.filter(hasPosition).map(toPosition),
    views,
    notes: notes.map(toNote),
    groups: groups.map(toGroup),
  }
}

export function setPositions(scope: CanvasScope, items: CanvasPositionInput[]): void {
  const db = getDb()
  const upsert = db.prepare(
    `INSERT INTO canvas_positions (scope, kind, entity_id, x, y, w, h)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(scope, kind, entity_id) DO UPDATE SET x = excluded.x, y = excluded.y,
       w = excluded.w, h = excluded.h`,
  )
  db.transaction(() => {
    for (const p of items) upsert.run(scope, p.kind, p.entityId, p.x, p.y, p.w ?? null, p.h ?? null)
  })()
}

// Estado de exibição do cartão não é posição: sobrevive ao Organizar e a sair do
// grupo. Sem x/y a linha vira só view_state; sem nenhum dos dois, some.
function forgetPositions(where: string, ...params: unknown[]): void {
  const db = getDb()
  db.prepare(
    `UPDATE canvas_positions SET x = NULL, y = NULL, w = NULL, h = NULL
      WHERE view_state IS NOT NULL AND ${where}`,
  ).run(...params)
  db.prepare(`DELETE FROM canvas_positions WHERE view_state IS NULL AND ${where}`).run(...params)
}

export function clearPositions(scope: CanvasScope): void {
  const db = getDb()
  db.transaction(() => forgetPositions('scope = ?', scope))()
}

export function setViewStates(scope: CanvasScope, items: CanvasViewStateInput[]): void {
  const db = getDb()
  const upsert = db.prepare(
    `INSERT INTO canvas_positions (scope, kind, entity_id, view_state) VALUES (?, 'session', ?, ?)
     ON CONFLICT(scope, kind, entity_id) DO UPDATE SET view_state = excluded.view_state`,
  )
  db.transaction(() => {
    for (const v of items) upsert.run(scope, v.sessionId, v.viewState)
  })()
}

function getNote(id: string): CanvasNote {
  const row = getDb().prepare('SELECT * FROM canvas_notes WHERE id = ?').get(id) as
    NoteRow | undefined
  if (!row) throw new Error(`Nota não encontrada: ${id}`)
  return toNote(row)
}

export function createNote(input: CreateCanvasNoteInput): CanvasNote {
  const now = Date.now()
  const id = randomUUID()
  getDb()
    .prepare(
      `INSERT INTO canvas_notes (id, scope, body_md, attached_session_id, color, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.scope,
      input.bodyMd,
      input.attachedSessionId ?? null,
      input.color ?? null,
      now,
      now,
    )
  return getNote(id)
}

export function updateNote(input: UpdateCanvasNoteInput): CanvasNote {
  const prev = getNote(input.id)
  const next = {
    bodyMd: input.bodyMd ?? prev.bodyMd,
    attachedSessionId:
      input.attachedSessionId !== undefined ? input.attachedSessionId : prev.attachedSessionId,
    color: input.color !== undefined ? input.color : prev.color,
  }
  getDb()
    .prepare(
      `UPDATE canvas_notes SET body_md = ?, attached_session_id = ?, color = ?, updated_at = ?
        WHERE id = ?`,
    )
    .run(next.bodyMd, next.attachedSessionId, next.color, Date.now(), input.id)
  return getNote(input.id)
}

export function deleteNote(id: string): void {
  const db = getDb()
  db.transaction(() => {
    db.prepare('DELETE FROM canvas_notes WHERE id = ?').run(id)
    db.prepare(`DELETE FROM canvas_positions WHERE kind = 'note' AND entity_id = ?`).run(id)
  })()
}

function getGroup(id: string): SessionGroup {
  const row = getDb().prepare('SELECT * FROM session_groups WHERE id = ?').get(id) as
    GroupRow | undefined
  if (!row) throw new Error(`Grupo não encontrado: ${id}`)
  return toGroup(row)
}

export function createGroup(input: CreateSessionGroupInput): SessionGroup {
  const id = randomUUID()
  getDb()
    .prepare(
      'INSERT INTO session_groups (id, scope, name, color, created_at) VALUES (?, ?, ?, ?, ?)',
    )
    .run(id, input.scope, input.name.trim(), input.color ?? null, Date.now())
  return getGroup(id)
}

export function updateGroup(input: UpdateSessionGroupInput): SessionGroup {
  const prev = getGroup(input.id)
  getDb()
    .prepare('UPDATE session_groups SET name = ?, color = ? WHERE id = ?')
    .run(
      input.name?.trim() || prev.name,
      input.color !== undefined ? input.color : prev.color,
      input.id,
    )
  return getGroup(input.id)
}

// A posição de um membro é relativa ao grupo: reusada na lane, o cartão cairia em
// cima de outro. Sem ela, o layout põe o cartão no próximo slot livre.
const MEMBER_POSITIONS = `kind = 'session' AND scope = (SELECT scope FROM session_groups WHERE id = ?)
    AND entity_id IN (SELECT id FROM sessions WHERE group_id = ?)`

export function deleteGroup(id: string): void {
  const db = getDb()
  db.transaction(() => {
    forgetPositions(MEMBER_POSITIONS, id, id)
    db.prepare('UPDATE sessions SET group_id = NULL WHERE group_id = ?').run(id)
    db.prepare('DELETE FROM session_groups WHERE id = ?').run(id)
    db.prepare(`DELETE FROM canvas_positions WHERE kind = 'group' AND entity_id = ?`).run(id)
  })()
}

function updateSession(sql: string, sessionId: string, ...values: unknown[]): void {
  const res = getDb()
    .prepare(sql)
    .run(...values, sessionId)
  if (res.changes === 0) throw new Error(`Sessão não encontrada: ${sessionId}`)
}

export function setSessionGroup(sessionId: string, groupId: string | null): void {
  if (groupId) getGroup(groupId)
  const db = getDb()
  db.transaction(() => {
    if (!groupId) {
      forgetPositions(
        `kind = 'session' AND entity_id = ?
           AND scope = (SELECT g.scope FROM sessions s JOIN session_groups g ON g.id = s.group_id
                         WHERE s.id = ?)`,
        sessionId,
        sessionId,
      )
    }
    updateSession('UPDATE sessions SET group_id = ? WHERE id = ?', sessionId, groupId)
  })()
}

export function setSessionPurpose(sessionId: string, purpose: string | null): void {
  updateSession('UPDATE sessions SET purpose = ? WHERE id = ?', sessionId, purpose?.trim() || null)
}

export function setSessionSummary(sessionId: string, summary: string, at: number): void {
  updateSession(
    'UPDATE sessions SET last_summary = ?, last_summary_at = ? WHERE id = ?',
    sessionId,
    summary,
    at,
  )
}

export function sessionCcId(sessionId: string): string | null {
  const row = getDb().prepare('SELECT cc_session_id FROM sessions WHERE id = ?').get(sessionId) as
    { cc_session_id: string | null } | undefined
  if (!row) throw new Error(`Sessão não encontrada: ${sessionId}`)
  return row.cc_session_id
}
