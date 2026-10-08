import type { Feature, FeatureLoopSnapshot, HandoffWakeHealth } from './ipc'

// Um vínculo feature → OKR já resolvido em títulos (feature_links + objectives/key_results).
export interface RoomObjectiveLink {
  objectiveId: string
  objectiveTitle: string
  krId: string | null
  krTitle: string | null
}

// handoff_events da feature, com as sessões do handoff NO MOMENTO DA LEITURA
// (child/mother atuais: o bastão move; aceito, a timeline é "dos handoffs").
export interface RoomTimelineEvent {
  id: string
  handoffId: string
  event: string
  fromStatus: string | null
  toStatus: string
  detail: string | null
  at: number
  childSessionId: string | null
  motherSessionId: string | null
  task: string
}

export interface RoomSnapshot {
  featureId: string
  feature: Feature
  objectiveChain: RoomObjectiveLink[]
  timeline: RoomTimelineEvent[] // mais novo primeiro, LIMIT ROOM_TIMELINE_LIMIT
  loop: Pick<FeatureLoopSnapshot, 'pulse' | 'liveness' | 'issues'>
  wakeHealth: HandoffWakeHealth
}

export const ROOM_TIMELINE_LIMIT = 200
