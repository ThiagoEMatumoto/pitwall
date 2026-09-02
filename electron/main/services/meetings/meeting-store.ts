import { randomUUID } from 'node:crypto'
import { getDb } from '../db'
import type {
  Meeting,
  MeetingActionItem,
  MeetingActionItemOwnerKind,
  MeetingActionItemStatus,
  MeetingDetail,
  MeetingDiarizationStatus,
  MeetingSegment,
  MeetingSpeaker,
  MeetingSpeakerTrack,
  MeetingStatus,
  MeetingVoice,
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
  last_error: string | null
  respawns: number
  mic_level_dbfs: number | null
  diarization: string | null
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
  speaker_id: string | null
  speaker_label: string | null
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
  owner: string | null
  owner_kind: string
}

interface SpeakerRow {
  id: string
  meeting_id: string
  label: string
  voice_id: string | null
  turn_count: number
}

interface VoiceRow {
  id: string
  name: string
  dim: number
  sample_count: number
  created_at: number
  updated_at: number
}

// durationMs de uma gravação em curso é medida contra o relógio: o valor só
// congela quando ended_at é gravado.
function rowToMeeting(row: MeetingRow, speakers: MeetingSpeaker[]): Meeting {
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
    speakers,
    lastError: row.last_error,
    respawns: row.respawns,
    micLevelDbfs: row.mic_level_dbfs,
    diarization: row.diarization as MeetingDiarizationStatus | null,
  }
}

function rowToSegment(row: SegmentRow): MeetingSegment {
  return {
    id: row.id,
    meetingId: row.meeting_id,
    speaker: row.speaker as MeetingSpeakerTrack,
    text: row.text,
    startMs: row.start_ms,
    endMs: row.end_ms,
    chunkIndex: row.chunk_index,
    createdAt: row.created_at,
    speakerId: row.speaker_id,
    speakerLabel: row.speaker_label,
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
    owner: row.owner,
    ownerKind: row.owner_kind as MeetingActionItemOwnerKind,
  }
}

function rowToSpeaker(row: SpeakerRow): MeetingSpeaker {
  return {
    id: row.id,
    meetingId: row.meeting_id,
    label: row.label,
    voiceId: row.voice_id,
    turnCount: row.turn_count,
  }
}

function rowToVoice(row: VoiceRow): MeetingVoice {
  return {
    id: row.id,
    name: row.name,
    dim: row.dim,
    sampleCount: row.sample_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

const SELECT_MEETING = `
  SELECT m.*,
    (SELECT COUNT(*) FROM meeting_v2_segments s WHERE s.meeting_id = m.id) AS segment_count
  FROM meetings_v2 m`

// Speakers de várias reuniões numa query só (list()/search() não fazem N+1).
function speakersByMeeting(meetingIds: string[]): Map<string, MeetingSpeaker[]> {
  const map = new Map<string, MeetingSpeaker[]>()
  if (meetingIds.length === 0) return map
  const placeholders = meetingIds.map(() => '?').join(', ')
  const rows = getDb()
    .prepare(
      `SELECT * FROM meeting_v2_speakers WHERE meeting_id IN (${placeholders}) ORDER BY rowid ASC`,
    )
    .all(...meetingIds) as SpeakerRow[]
  for (const row of rows) {
    const list = map.get(row.meeting_id) ?? []
    list.push(rowToSpeaker(row))
    map.set(row.meeting_id, list)
  }
  return map
}

function rowsToMeetings(rows: MeetingRow[]): Meeting[] {
  const speakers = speakersByMeeting(rows.map((r) => r.id))
  return rows.map((row) => rowToMeeting(row, speakers.get(row.id) ?? []))
}

function loadMeeting(id: string): Meeting | null {
  const row = getDb()
    .prepare(`${SELECT_MEETING} WHERE m.id = ?`)
    .get(id) as MeetingRow | undefined
  return row ? rowToMeeting(row, listSpeakers(id)) : null
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
  return rowsToMeetings(rows)
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
  return row ? rowToMeeting(row, listSpeakers(row.id)) : null
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

// Telemetria de captura (respawns do pw-record, nível do mic, diarização).
// Só grava os campos informados; não mexe em status/error.
export function setRuntimeInfo(
  id: string,
  info: {
    lastError?: string | null
    respawns?: number
    micLevelDbfs?: number | null
    diarization?: MeetingDiarizationStatus | null
  },
): Meeting {
  const current = requireMeeting(id)
  getDb()
    .prepare(
      `UPDATE meetings_v2 SET last_error = ?, respawns = ?, mic_level_dbfs = ?, diarization = ?, updated_at = ?
       WHERE id = ?`,
    )
    .run(
      info.lastError === undefined ? current.lastError : info.lastError,
      info.respawns ?? current.respawns,
      info.micLevelDbfs === undefined ? current.micLevelDbfs : info.micLevelDbfs,
      info.diarization === undefined ? current.diarization : info.diarization,
      Date.now(),
      id,
    )
  return requireMeeting(id)
}

export function remove(id: string): void {
  // Segmentos, action items e speakers saem via ON DELETE CASCADE (foreign_keys = ON em db.ts).
  getDb().prepare('DELETE FROM meetings_v2 WHERE id = ?').run(id)
}

// ---- segmentos ----

export function appendSegment(input: {
  meetingId: string
  speaker: MeetingSpeakerTrack
  text: string
  startMs: number
  endMs: number
  chunkIndex: number
  speakerId?: string | null
  speakerLabel?: string | null
}): MeetingSegment {
  const now = Date.now()
  const id = randomUUID()
  const speakerId = input.speakerId ?? null
  const speakerLabel = input.speakerLabel ?? null
  getDb()
    .prepare(
      `INSERT INTO meeting_v2_segments
         (id, meeting_id, speaker, text, start_ms, end_ms, chunk_index, created_at, speaker_id, speaker_label)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.meetingId,
      input.speaker,
      input.text,
      input.startMs,
      input.endMs,
      input.chunkIndex,
      now,
      speakerId,
      speakerLabel,
    )
  return {
    id,
    meetingId: input.meetingId,
    speaker: input.speaker,
    text: input.text,
    startMs: input.startMs,
    endMs: input.endMs,
    chunkIndex: input.chunkIndex,
    createdAt: now,
    speakerId,
    speakerLabel,
  }
}

export function listSegments(meetingId: string): MeetingSegment[] {
  const rows = getDb()
    .prepare('SELECT * FROM meeting_v2_segments WHERE meeting_id = ? ORDER BY start_ms ASC, chunk_index ASC')
    .all(meetingId) as SegmentRow[]
  return rows.map(rowToSegment)
}

/** Reescreve o label desnormalizado de todos os segmentos daquele speaker. Devolve quantos mudaram. */
export function updateSegmentsSpeaker(meetingId: string, speakerId: string, speakerLabel: string): number {
  const result = getDb()
    .prepare('UPDATE meeting_v2_segments SET speaker_label = ? WHERE meeting_id = ? AND speaker_id = ?')
    .run(speakerLabel, meetingId, speakerId)
  return result.changes
}

// ---- speakers ----

export function listSpeakers(meetingId: string): MeetingSpeaker[] {
  const rows = getDb()
    .prepare('SELECT * FROM meeting_v2_speakers WHERE meeting_id = ? ORDER BY rowid ASC')
    .all(meetingId) as SpeakerRow[]
  return rows.map(rowToSpeaker)
}

export function getSpeaker(id: string): MeetingSpeaker | null {
  const row = getDb().prepare('SELECT * FROM meeting_v2_speakers WHERE id = ?').get(id) as SpeakerRow | undefined
  return row ? rowToSpeaker(row) : null
}

export function getSpeakerCentroid(id: string): Buffer | null {
  const row = getDb().prepare('SELECT centroid FROM meeting_v2_speakers WHERE id = ?').get(id) as
    | { centroid: Buffer | null }
    | undefined
  return row?.centroid ?? null
}

// Label é único por reunião (UNIQUE no schema): repetir o label devolve o
// speaker existente atualizado em vez de lançar — a clusterização só sabe o nome.
export function upsertSpeaker(input: {
  meetingId: string
  label: string
  voiceId?: string | null
  centroid?: Buffer | null
  turnCount?: number
}): MeetingSpeaker {
  const db = getDb()
  const label = input.label.trim()
  if (!label) throw new Error('speaker label vazio')
  const existing = db
    .prepare('SELECT * FROM meeting_v2_speakers WHERE meeting_id = ? AND label = ?')
    .get(input.meetingId, label) as SpeakerRow | undefined
  if (existing) {
    return updateSpeaker(existing.id, {
      voiceId: input.voiceId,
      centroid: input.centroid,
      turnCount: input.turnCount,
    })
  }
  const id = randomUUID()
  db.prepare(
    `INSERT INTO meeting_v2_speakers (id, meeting_id, label, voice_id, centroid, turn_count)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, input.meetingId, label, input.voiceId ?? null, input.centroid ?? null, input.turnCount ?? 0)
  return {
    id,
    meetingId: input.meetingId,
    label,
    voiceId: input.voiceId ?? null,
    turnCount: input.turnCount ?? 0,
  }
}

export function updateSpeaker(
  id: string,
  patch: { label?: string; voiceId?: string | null; centroid?: Buffer | null; turnCount?: number },
): MeetingSpeaker {
  const db = getDb()
  const current = db.prepare('SELECT * FROM meeting_v2_speakers WHERE id = ?').get(id) as
    | (SpeakerRow & { centroid: Buffer | null })
    | undefined
  if (!current) throw new Error(`speaker not found: ${id}`)
  const label = patch.label?.trim() || current.label
  db.prepare(
    'UPDATE meeting_v2_speakers SET label = ?, voice_id = ?, centroid = ?, turn_count = ? WHERE id = ?',
  ).run(
    label,
    patch.voiceId === undefined ? current.voice_id : patch.voiceId,
    patch.centroid === undefined ? current.centroid : patch.centroid,
    patch.turnCount ?? current.turn_count,
    id,
  )
  return rowToSpeaker(db.prepare('SELECT * FROM meeting_v2_speakers WHERE id = ?').get(id) as SpeakerRow)
}

// ---- vozes conhecidas ----

const SELECT_VOICE = 'SELECT id, name, dim, sample_count, created_at, updated_at FROM meeting_v2_voices'

export function listVoices(): MeetingVoice[] {
  const rows = getDb().prepare(`${SELECT_VOICE} ORDER BY name COLLATE NOCASE ASC`).all() as VoiceRow[]
  return rows.map(rowToVoice)
}

export function getVoice(id: string): MeetingVoice | null {
  const row = getDb().prepare(`${SELECT_VOICE} WHERE id = ?`).get(id) as VoiceRow | undefined
  return row ? rowToVoice(row) : null
}

export function getVoiceEmbedding(id: string): Buffer | null {
  const row = getDb().prepare('SELECT embedding FROM meeting_v2_voices WHERE id = ?').get(id) as
    | { embedding: Buffer }
    | undefined
  return row?.embedding ?? null
}

export function findVoiceByName(name: string): MeetingVoice | null {
  const row = getDb()
    .prepare(`${SELECT_VOICE} WHERE name = ? COLLATE NOCASE LIMIT 1`)
    .get(name.trim()) as VoiceRow | undefined
  return row ? rowToVoice(row) : null
}

export function createVoice(input: { name: string; embedding: Buffer; dim: number; sampleCount?: number }): MeetingVoice {
  const name = input.name.trim()
  if (!name) throw new Error('voice name vazio')
  if (input.embedding.length === 0) throw new Error('voice embedding vazio')
  const now = Date.now()
  const id = randomUUID()
  getDb()
    .prepare(
      `INSERT INTO meeting_v2_voices (id, name, embedding, dim, sample_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, name, input.embedding, input.dim, input.sampleCount ?? 1, now, now)
  return { id, name, dim: input.dim, sampleCount: input.sampleCount ?? 1, createdAt: now, updatedAt: now }
}

export function updateVoice(
  id: string,
  patch: { name?: string; embedding?: Buffer; sampleCount?: number },
): MeetingVoice {
  const db = getDb()
  const current = db.prepare('SELECT * FROM meeting_v2_voices WHERE id = ?').get(id) as
    | (VoiceRow & { embedding: Buffer })
    | undefined
  if (!current) throw new Error(`voice not found: ${id}`)
  db.prepare(
    'UPDATE meeting_v2_voices SET name = ?, embedding = ?, sample_count = ?, updated_at = ? WHERE id = ?',
  ).run(
    patch.name?.trim() || current.name,
    patch.embedding ?? current.embedding,
    patch.sampleCount ?? current.sample_count,
    Date.now(),
    id,
  )
  return rowToVoice(db.prepare(`${SELECT_VOICE} WHERE id = ?`).get(id) as VoiceRow)
}

export function deleteVoice(id: string): void {
  // Speakers que apontavam pra voz ficam com voice_id NULL (ON DELETE SET NULL).
  getDb().prepare('DELETE FROM meeting_v2_voices WHERE id = ?').run(id)
}

// ---- action items ----

// Substitui o conjunto inteiro: re-extrair o resumo descarta a lista anterior.
export function replaceActionItems(
  meetingId: string,
  items: Array<{
    title: string
    quote: string | null
    grounded: boolean
    status: MeetingActionItemStatus
    taskId: string | null
    owner?: string | null
    ownerKind?: MeetingActionItemOwnerKind
  }>,
): MeetingActionItem[] {
  const db = getDb()
  const insert = db.prepare(
    `INSERT INTO meeting_v2_action_items
       (id, meeting_id, title, quote, grounded, status, task_id, created_at, owner, owner_kind)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM meeting_v2_action_items WHERE meeting_id = ?').run(meetingId)
    const now = Date.now()
    for (const item of items) {
      insert.run(
        randomUUID(),
        meetingId,
        item.title,
        item.quote,
        item.grounded ? 1 : 0,
        item.status,
        item.taskId,
        now,
        item.owner ?? null,
        item.ownerKind ?? 'unknown',
      )
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

export function setActionItemOwner(
  id: string,
  owner: string | null,
  ownerKind: MeetingActionItemOwnerKind,
): MeetingActionItem {
  const db = getDb()
  const current = db.prepare('SELECT * FROM meeting_v2_action_items WHERE id = ?').get(id) as
    | ActionItemRow
    | undefined
  if (!current) throw new Error(`action item not found: ${id}`)
  const normalized = owner?.trim() || null
  db.prepare('UPDATE meeting_v2_action_items SET owner = ?, owner_kind = ? WHERE id = ?').run(normalized, ownerKind, id)
  return rowToActionItem({ ...current, owner: normalized, owner_kind: ownerKind })
}

// ---- busca ----

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
  return rowsToMeetings(rows).map((meeting) => {
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
