// Ponto de costura entre as waves: o IPC (W0) só conhece estas interfaces; a
// captura/STT (W1-A), tray/janela flutuante (W1-B) e resumo/extração (W2)
// registram suas implementações nos registries abaixo em initMeetings.
import type {
  Meeting,
  MeetingActionItem,
  MeetingActionItemDecision,
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
}

export const recorderRegistry = { current: null as MeetingRecorder | null }

export function getRecorder(): MeetingRecorder {
  if (!recorderRegistry.current) throw new Error('Gravador não inicializado')
  return recorderRegistry.current
}

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
