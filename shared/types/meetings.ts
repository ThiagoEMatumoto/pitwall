// Reuniões v2 (notetaker): tipos compartilhados main ↔ renderer. Re-exportados
// em ./ipc pra que os consumidores sigam importando de '@shared/types/ipc'.

export type MeetingStatus = 'recording' | 'processing' | 'done' | 'error'
export type MeetingSpeaker = 'me' | 'them'
export type MeetingActionItemStatus = 'proposed' | 'created' | 'dismissed'
export type MeetingCaptureMode = 'pipewire' | 'fixture'
export type MeetingFloatingAction = 'show' | 'hide' | 'toggle'

export interface Meeting {
  id: string
  title: string
  status: MeetingStatus
  startedAt: number
  endedAt: number | null
  rawNotes: string
  summaryMd: string | null
  themLabel: string
  error: string | null
  sttModel: string | null
  summaryModel: string | null
  createdAt: number
  updatedAt: number
  segmentCount: number
  durationMs: number
}

export interface MeetingSegment {
  id: string
  meetingId: string
  speaker: MeetingSpeaker
  text: string
  startMs: number
  endMs: number
  chunkIndex: number
  createdAt: number
}

export interface MeetingActionItem {
  id: string
  meetingId: string
  title: string
  quote: string | null
  grounded: boolean
  status: MeetingActionItemStatus
  taskId: string | null
  createdAt: number
}

export interface MeetingLiveState {
  active: Meeting | null
  elapsedMs: number
  /** RMS 0..1 por trilha. */
  levels: { me: number; them: number }
  sttOk: boolean
  lastError: string | null
  captureMode: MeetingCaptureMode
}

export interface MeetingDetail {
  meeting: Meeting
  segments: MeetingSegment[]
  actionItems: MeetingActionItem[]
}

export interface MeetingSetupStatus {
  pipewire: boolean
  sink: string | null
  source: string | null
  stt: { ok: boolean; url: string | null; error: string | null }
}

export interface StartMeetingInput {
  title?: string
}

export interface UpdateMeetingInput {
  id: string
  title?: string
  rawNotes?: string
  themLabel?: string
}

export interface MeetingActionItemDecision {
  id: string
  /** 'created' força criar a task mesmo sem grounding. */
  status: 'dismissed' | 'created'
}

export type MeetingEvent =
  | { type: 'state'; state: MeetingLiveState }
  | { type: 'segment'; segment: MeetingSegment }
  | { type: 'meeting'; meeting: Meeting }
  | { type: 'action_items'; meetingId: string; items: MeetingActionItem[] }
