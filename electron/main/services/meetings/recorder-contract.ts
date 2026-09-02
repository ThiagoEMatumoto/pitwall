// Ponto de costura entre as waves: o IPC (W0) só conhece estas interfaces; a
// captura/STT (W1-A), diarização (W1-B), tray/janela flutuante e resumo/
// extração (W2) registram suas implementações nos registries abaixo em
// initMeetings.
import type {
  Meeting,
  MeetingActionItem,
  MeetingActionItemBatch,
  MeetingDetection,
  MeetingDetectionAction,
  MeetingDiarizationLiveStatus,
  MeetingFloatingAction,
  MeetingLiveState,
  MeetingSetupStatus,
  RenameMeetingSpeakerInput,
} from '../../../../shared/types/meetings'

export type { MeetingSetupStatus } from '../../../../shared/types/meetings'

export interface MeetingRecorder {
  start(opts: { title?: string }): Promise<Meeting>
  stop(): Promise<Meeting>
  getState(): MeetingLiveState
  appendQuickNote(meetingId: string, text: string): Meeting
  /** Reemite o evento 'state' (sem throttle) — usado pelo detector a cada transição. */
  refreshState(): void
}

export const recorderRegistry = { current: null as MeetingRecorder | null }

export function getRecorder(): MeetingRecorder {
  if (!recorderRegistry.current) throw new Error('Gravador não inicializado')
  return recorderRegistry.current
}

// Detecção de reunião via PipeWire (W1-A). O recorder lê a detecção corrente
// pra vincular a gravação ao stream; o IPC encaminha a decisão do usuário.
export interface MeetingDetector {
  getDetection(): MeetingDetection | null
  decide(action: MeetingDetectionAction): void
}

export const detectorRegistry = { current: null as MeetingDetector | null }

// Diarização da trilha 'them' (W1-B). Turnos são relativos ao início do chunk;
// quem chama soma startMs pra obter tempo absoluto da reunião.
export interface DiarizedTurn {
  startMs: number
  endMs: number
  speakerId: string
  speakerLabel: string
}

export interface MeetingDiarizer {
  process(input: { meetingId: string; chunkIndex: number; pcm: Buffer; startMs: number }): Promise<DiarizedTurn[]>
  status(): MeetingDiarizationLiveStatus
  /** Descarta centroides/estado da reunião (fim da gravação ou reinício). */
  reset(meetingId: string): void
  /** Sobe o worker cedo (primeiro start()); opcional — process() também o sobe. */
  warmup?(): Promise<void>
}

export const diarizerRegistry = { current: null as MeetingDiarizer | null }

export const setupCheckRegistry = {
  current: null as (() => Promise<MeetingSetupStatus>) | null,
}

export const floatingRegistry = {
  current: null as ((action: MeetingFloatingAction) => void) | null,
}

export const resummarizeRegistry = {
  current: null as ((meetingId: string) => Promise<Meeting>) | null,
}

// Renomear um speaker: label + segmentos + voz conhecida (W2-B).
export const speakerRenameRegistry = {
  current: null as ((input: RenameMeetingSpeakerInput) => Promise<Meeting>) | null,
}

// Download do modelo de embedding (W1-B); progresso sai como MeetingEvent 'model_progress'.
export const modelDownloadRegistry = {
  current: null as (() => Promise<void>) | null,
}

// Decisão em lote sobre itens propostos (W2-A). Devolve a lista completa da reunião.
export const actionItemBatchRegistry = {
  current: null as ((input: MeetingActionItemBatch) => Promise<MeetingActionItem[]>) | null,
}

// Pós-processamento após stop() (resumo + extração de tarefas, W2). Quem
// registra é dono de levar a reunião de 'processing' a 'done'/'error'; sem
// registro, o gravador marca 'done' direto.
export const postProcessRegistry = {
  current: null as ((meetingId: string) => Promise<void>) | null,
}
