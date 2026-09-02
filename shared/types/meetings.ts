// Reuniões v2 (notetaker): tipos compartilhados main ↔ renderer. Re-exportados
// em ./ipc pra que os consumidores sigam importando de '@shared/types/ipc'.

export type MeetingStatus = 'recording' | 'processing' | 'done' | 'error'
/** Trilha de captura: 'me' = microfone, 'them' = áudio do sistema. */
export type MeetingSpeakerTrack = 'me' | 'them'
export type MeetingActionItemStatus = 'proposed' | 'created' | 'dismissed'
export type MeetingActionItemOwnerKind = 'me' | 'named' | 'unknown'
export type MeetingCaptureMode = 'pipewire' | 'fixture'
export type MeetingFloatingAction = 'show' | 'hide' | 'toggle'
export type MeetingDetectionAction = 'record' | 'ignore'
/** Estado da diarização gravado na reunião (null = reunião anterior à 047). */
export type MeetingDiarizationStatus = 'on' | 'off' | 'unavailable'
export type MeetingDiarizationLiveStatus = MeetingDiarizationStatus | 'loading'

/** Falante identificado dentro de uma reunião (trilha 'them'; 'me' não diariza). */
export interface MeetingSpeaker {
  id: string
  meetingId: string
  label: string
  /** Voz conhecida vinculada (null = ainda "Participante N"). */
  voiceId: string | null
  turnCount: number
}

/** Voz conhecida entre reuniões (embedding fica no main; a UI só vê metadados). */
export interface MeetingVoice {
  id: string
  name: string
  dim: number
  sampleCount: number
  createdAt: number
  updatedAt: number
}

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
  speakers: MeetingSpeaker[]
  /** Último erro de captura (respawn do pw-record etc.) — não muda o status. */
  lastError: string | null
  respawns: number
  micLevelDbfs: number | null
  diarization: MeetingDiarizationStatus | null
}

export interface MeetingSegment {
  id: string
  meetingId: string
  speaker: MeetingSpeakerTrack
  text: string
  startMs: number
  endMs: number
  chunkIndex: number
  createdAt: number
  speakerId: string | null
  speakerLabel: string | null
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
  owner: string | null
  ownerKind: MeetingActionItemOwnerKind
}

/** Decisão em lote sobre itens propostos (substitui a decisão unitária). */
export interface MeetingActionItemBatch {
  meetingId: string
  ids: string[]
  action: 'create' | 'dismiss'
  overrides?: Record<string, { owner?: string | null; title?: string }>
}

/** App de chamada com stream de microfone aberto no PipeWire. */
export interface MeetingDetection {
  app: string
  binary: string
  pid: number
  streamId: number
  since: number
  ignored: boolean
}

export interface MeetingLiveState {
  active: Meeting | null
  elapsedMs: number
  /** RMS 0..1 por trilha. */
  levels: { me: number; them: number }
  sttOk: boolean
  lastError: string | null
  captureMode: MeetingCaptureMode
  detection: MeetingDetection | null
  /** streamId da detecção que originou a gravação ativa (auto-stop vinculado). */
  linkedStreamId: number | null
  /** Mic medido abaixo do limiar no start — o app avisa, nunca altera volume. */
  micWarning: { dbfs: number; source: string } | null
  diarization: MeetingDiarizationLiveStatus
}

export interface MeetingDetail {
  meeting: Meeting
  segments: MeetingSegment[]
  actionItems: MeetingActionItem[]
}

export type MeetingModelState = 'ready' | 'missing'
export type MeetingDownloadableModelState = MeetingModelState | 'downloading'

export interface MeetingSetupStatus {
  pipewire: boolean
  sink: string | null
  source: string | null
  stt: { ok: boolean; url: string | null; error: string | null }
  micLevel: { dbfs: number | null; source: string | null; low: boolean }
  diarization: {
    supported: boolean
    addon: boolean
    models: {
      segmentation: MeetingModelState
      embedding: MeetingDownloadableModelState
      progress: number | null
    }
  }
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

export interface RenameMeetingSpeakerInput {
  meetingId: string
  speakerId: string
  name: string
}

export type MeetingEvent =
  | { type: 'state'; state: MeetingLiveState }
  | { type: 'segment'; segment: MeetingSegment }
  | { type: 'meeting'; meeting: Meeting }
  | { type: 'action_items'; meetingId: string; items: MeetingActionItem[] }
  | { type: 'model_progress'; model: 'embedding'; progress: number; done: boolean; error: string | null }
