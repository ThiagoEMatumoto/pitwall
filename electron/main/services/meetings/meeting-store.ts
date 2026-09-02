import { randomUUID } from 'node:crypto'
import { getDb } from '../db'
import type {
  Meeting,
  MeetingActionItem,
  MeetingActionItemStatus,
  MeetingDetail,
  MeetingSegment,
  MeetingSpeaker,
  MeetingStatus,
  UpdateMeetingInput,
} from '../../../../shared/types/meetings'

// ---- rows <-> entidades ----

interface MeetingRow {
  id: string
  title: string
  status: string
  started_at: number
  ended_at: number | null
  raw_notes: string
  summary_md: string | null
  them_label: string
  error: string | null
  stt_model: string | null
  summary_model: string | null
  created_at: number
  updated_at: number
  segment_count: number
}

interface SegmentRow {
  id: string
  meeting_id: string
  speaker: string
  text: string
  start_ms: number
  end_ms: number
  chunk_index: number
  created_at: number
}

interface ActionItemRow {
  id: string
  meeting_id: string
  title: string
  quote: string | null
  grounded: number
  status: string
  task_id: string | null
  created_at: number
}

// durationMs de uma gravação em curso é medida contra o relógio: o valor só
// congela quando ended_at é gravado.
function rowToMeeting(row: MeetingRow): Meeting {
  return {
    id: row.id,
    title: row.title,
    status: row.status as MeetingStatus,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    rawNotes: row.raw_notes,
    summaryMd: row.summary_md,
    themLabel: row.them_label,
    error: row.error,
    sttModel: row.stt_model,
    summaryModel: row.summary_model,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    segmentCount: row.segment_count,
    durationMs: Math.max(0, (row.ended_at ?? Date.now()) - row.started_at),
  }
}

function rowToSegment(row: SegmentRow): MeetingSegment {
  return {
    id: row.id,
    meetingId: row.meeting_id,
    speaker: row.speaker as MeetingSpeaker,
    text: row.text,
    startMs: row.start_ms,
    endMs: row.end_ms,
    chunkIndex: row.chunk_index,
    createdAt: row.created_at,
  }
}

function rowToActionItem(row: ActionItemRow): MeetingActionItem {
  return {
    id: row.id,
    meetingId: row.meeting_id,
    title: row.title,
    quote: row.quote,
    grounded: row.grounded === 1,
    status: row.status as MeetingActionItemStatus,
    taskId: row.task_id,
    createdAt: row.created_at,
  }
}

const SELECT_MEETING = `
  SELECT m.*,
    (SELECT COUNT(*) FROM meeting_v2_segments s WHERE s.meeting_id = m.id) AS segment_count
  FROM meetings_v2 m`

function loadMeeting(id: string): Meeting | null {
  const row = getDb()
    .prepare(`${SELECT_MEETING} WHERE m.id = ?`)
    .get(id) as MeetingRow | undefined
  return row ? rowToMeeting(row) : null
}

function requireMeeting(id: string): Meeting {
  const meeting = loadMeeting(id)
  if (!meeting) throw new Error(`meeting not found: ${id}`)
  return meeting
}

function listActionItems(meetingId: string): MeetingActionItem[] {
  const rows = getDb()
    .prepare('SELECT * FROM meeting_v2_action_items WHERE meeting_id = ? ORDER BY created_at ASC, rowid ASC')
    .all(meetingId) as ActionItemRow[]
  return rows.map(rowToActionItem)
}

// ---- API pública ----

export function list(): Meeting[] {
  const rows = getDb()
    .prepare(`${SELECT_MEETING} ORDER BY m.started_at DESC`)
    .all() as MeetingRow[]
  return rows.map(rowToMeeting)
}

export function get(id: string): MeetingDetail | null {
  const meeting = loadMeeting(id)
  if (!meeting) return null
  return { meeting, segments: listSegments(id), actionItems: listActionItems(id) }
}

export function getActive(): Meeting | null {
  const row = getDb()
    .prepare(`${SELECT_MEETING} WHERE m.status = 'recording' ORDER BY m.started_at DESC LIMIT 1`)
    .get() as MeetingRow | undefined
  return row ? rowToMeeting(row) : null
}

export function create(input: { title?: string }): Meeting {
  const now = Date.now()
  const id = randomUUID()
  const title = input.title?.trim() || `Reunião ${new Date(now).toLocaleString('pt-BR')}`
  getDb()
    .prepare(
      `INSERT INTO meetings_v2 (id, title, status, started_at, created_at, updated_at)
       VALUES (?, ?, 'recording', ?, ?, ?)`,
    )
    .run(id, title, now, now, now)
  return requireMeeting(id)
}

export function update(input: UpdateMeetingInput): Meeting {
  const current = requireMeeting(input.id)
  getDb()
    .prepare(
      `UPDATE meetings_v2 SET title = ?, raw_notes = ?, them_label = ?, updated_at = ? WHERE id = ?`,
    )
    .run(
      input.title?.trim() || current.title,
      input.rawNotes ?? current.rawNotes,
      input.themLabel?.trim() || current.themLabel,
      Date.now(),
      input.id,
    )
  return requireMeeting(input.id)
}

// `error` só faz sentido em status 'error': qualquer outra transição limpa.
export function setStatus(
  id: string,
  status: MeetingStatus,
  opts: { endedAt?: number; error?: string } = {},
): Meeting {
  const current = requireMeeting(id)
  getDb()
    .prepare(
      `UPDATE meetings_v2 SET status = ?, ended_at = ?, error = ?, updated_at = ? WHERE id = ?`,
    )
    .run(status, opts.endedAt ?? current.endedAt, opts.error ?? null, Date.now(), id)
  return requireMeeting(id)
}

export function setSummary(id: string, summaryMd: string, summaryModel: string): Meeting {
  requireMeeting(id)
  getDb()
    .prepare(
      `UPDATE meetings_v2 SET summary_md = ?, summary_model = ?, updated_at = ? WHERE id = ?`,
    )
    .run(summaryMd, summaryModel, Date.now(), id)
  return requireMeeting(id)
}

export function setSttModel(id: string, sttModel: string): Meeting {
  requireMeeting(id)
  getDb()
    .prepare('UPDATE meetings_v2 SET stt_model = ?, updated_at = ? WHERE id = ?')
    .run(sttModel, Date.now(), id)
  return requireMeeting(id)
}

export function remove(id: string): void {
  // Segmentos e action items saem via ON DELETE CASCADE (foreign_keys = ON em db.ts).
  getDb().prepare('DELETE FROM meetings_v2 WHERE id = ?').run(id)
}

export function appendSegment(input: {
  meetingId: string
  speaker: MeetingSpeaker
  text: string
  startMs: number
  endMs: number
  chunkIndex: number
}): MeetingSegment {
  const now = Date.now()
  const id = randomUUID()
  getDb()
    .prepare(
      `INSERT INTO meeting_v2_segments (id, meeting_id, speaker, text, start_ms, end_ms, chunk_index, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, input.meetingId, input.speaker, input.text, input.startMs, input.endMs, input.chunkIndex, now)
  return {
    id,
    meetingId: input.meetingId,
    speaker: input.speaker,
    text: input.text,
    startMs: input.startMs,
    endMs: input.endMs,
    chunkIndex: input.chunkIndex,
    createdAt: now,
  }
}

export function listSegments(meetingId: string): MeetingSegment[] {
  const rows = getDb()
    .prepare('SELECT * FROM meeting_v2_segments WHERE meeting_id = ? ORDER BY start_ms ASC, chunk_index ASC')
    .all(meetingId) as SegmentRow[]
  return rows.map(rowToSegment)
}

// Substitui o conjunto inteiro: re-extrair o resumo descarta a lista anterior.
export function replaceActionItems(
  meetingId: string,
  items: Array<{
    title: string
    quote: string | null
    grounded: boolean
    status: MeetingActionItemStatus
    taskId: string | null
  }>,
): MeetingActionItem[] {
  const db = getDb()
  const insert = db.prepare(
    `INSERT INTO meeting_v2_action_items (id, meeting_id, title, quote, grounded, status, task_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM meeting_v2_action_items WHERE meeting_id = ?').run(meetingId)
    const now = Date.now()
    for (const item of items) {
      insert.run(randomUUID(), meetingId, item.title, item.quote, item.grounded ? 1 : 0, item.status, item.taskId, now)
    }
  })
  tx()
  return listActionItems(meetingId)
}

export function getActionItem(id: string): MeetingActionItem | null {
  const row = getDb().prepare('SELECT * FROM meeting_v2_action_items WHERE id = ?').get(id) as
    | ActionItemRow
    | undefined
  return row ? rowToActionItem(row) : null
}

export interface MeetingSearchHit {
  meeting: Meeting
  matchedIn: 'title' | 'notes' | 'summary' | 'transcript'
  snippet: string
}

function escapeLike(q: string): string {
  return q.replace(/[\\%_]/g, (c) => `\\${c}`)
}

function snippetAround(text: string, q: string, radius = 80): string {
  const idx = text.toLowerCase().indexOf(q.toLowerCase())
  if (idx === -1) return text.slice(0, radius * 2)
  const start = Math.max(0, idx - radius)
  const end = Math.min(text.length, idx + q.length + radius)
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`
}

// LIKE simples em título/notas/resumo/segmentos (sem FTS nesta release). O
// trecho devolvido é o do primeiro campo que casou, nessa ordem.
export function search(q: string, limit = 20): MeetingSearchHit[] {
  const needle = q.trim()
  if (!needle) return []
  const like = `%${escapeLike(needle)}%`
  const db = getDb()
  const rows = db
    .prepare(
      `${SELECT_MEETING}
       WHERE m.title LIKE ? ESCAPE '\\'
          OR m.raw_notes LIKE ? ESCAPE '\\'
          OR m.summary_md LIKE ? ESCAPE '\\'
          OR EXISTS (SELECT 1 FROM meeting_v2_segments s WHERE s.meeting_id = m.id AND s.text LIKE ? ESCAPE '\\')
       ORDER BY m.started_at DESC LIMIT ?`,
    )
    .all(like, like, like, like, limit) as MeetingRow[]
  const firstSegment = db.prepare(
    `SELECT text FROM meeting_v2_segments WHERE meeting_id = ? AND text LIKE ? ESCAPE '\\' ORDER BY start_ms ASC LIMIT 1`,
  )
  const lower = needle.toLowerCase()
  return rows.map((row) => {
    const meeting = rowToMeeting(row)
    if (meeting.title.toLowerCase().includes(lower)) {
      return { meeting, matchedIn: 'title', snippet: meeting.title }
    }
    if (meeting.rawNotes.toLowerCase().includes(lower)) {
      return { meeting, matchedIn: 'notes', snippet: snippetAround(meeting.rawNotes, needle) }
    }
    if (meeting.summaryMd?.toLowerCase().includes(lower)) {
      return { meeting, matchedIn: 'summary', snippet: snippetAround(meeting.summaryMd, needle) }
    }
    const seg = firstSegment.get(meeting.id, like) as { text: string } | undefined
    return { meeting, matchedIn: 'transcript', snippet: snippetAround(seg?.text ?? '', needle) }
  })
}

export function setActionItemStatus(
  id: string,
  status: MeetingActionItemStatus,
  taskId?: string,
): MeetingActionItem {
  const db = getDb()
  const current = db.prepare('SELECT * FROM meeting_v2_action_items WHERE id = ?').get(id) as
    | ActionItemRow
    | undefined
  if (!current) throw new Error(`action item not found: ${id}`)
  db.prepare('UPDATE meeting_v2_action_items SET status = ?, task_id = ? WHERE id = ?').run(
    status,
    taskId ?? current.task_id,
    id,
  )
  return rowToActionItem({ ...current, status, task_id: taskId ?? current.task_id })
}
