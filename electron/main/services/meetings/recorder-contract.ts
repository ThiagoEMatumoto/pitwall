// Ponto de costura entre as waves: o IPC (W0) só conhece estas interfaces; a
// captura/STT (W1-A), tray/janela flutuante (W1-B) e resumo/extração (W2)
// registram suas implementações nos registries abaixo em initMeetings.
import type {
  Meeting,
  MeetingActionItem,
  MeetingActionItemDecision,
  MeetingDetection,
  MeetingDetectionAction,
  MeetingFloatingAction,
  MeetingLiveState,
  MeetingSetupStatus,
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

export const setupCheckRegistry = {
  current: null as (() => Promise<MeetingSetupStatus>) | null,
}

export const floatingRegistry = {
  current: null as ((action: MeetingFloatingAction) => void) | null,
}

export const resummarizeRegistry = {
  current: null as ((meetingId: string) => Promise<Meeting>) | null,
}

export const actionItemRegistry = {
  current: null as ((input: MeetingActionItemDecision) => Promise<MeetingActionItem>) | null,
}

// Pós-processamento após stop() (resumo + extração de tarefas, W2). Quem
// registra é dono de levar a reunião de 'processing' a 'done'/'error'; sem
// registro, o gravador marca 'done' direto.
export const postProcessRegistry = {
  current: null as ((meetingId: string) => Promise<void>) | null,
}
