import type { EffortLevel, Feature, FeatureLoopSnapshot, HandoffWakeHealth } from './ipc'

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

// Iniciar a sessão-mãe pela Room (room:start-mother). O system prompt de papel é
// montado no main: o renderer manda só o objetivo, que vira sessions.purpose.
export interface StartMotherInput {
  featureId: string
  repoId: string
  purpose: string // 1..500 chars, mesmo limite do canvas:purpose-set
  model?: string | null
  effort?: EffortLevel | null
}

export interface StartMotherResult {
  sessionId: string // sessions.id (interno): o session.id que o Terminal usa
  ccSessionId: string | null
  cwd: string
  // Do início do handler até a linha existir com cc_session_id. O id nasce no
  // INSERT (o claude sobe com --session-id), então "iniciando" na UI é esperar o
  // 1º chat:transcript-update, não o ccSessionId.
  ccSessionIdReadyMs: number
}

export interface MotherPreflightRepo {
  repoId: string
  label: string
  valid: boolean // linha em repos e diretório no disco
  hasWorktree: boolean // worktree da feature registrado e existente
  cwd: string | null // onde a mãe subiria (worktree > raiz do repo)
}

export interface MotherPreflight {
  featureExists: boolean
  mcpReady: boolean
  // Texto para o humano quando !mcpReady: o motivo e a ação para religar.
  mcpBlockReason: string | null
  repos: MotherPreflightRepo[] // repos vinculados à feature
  repo: MotherPreflightRepo | null // o repoId pedido, mesmo fora da feature
  suggestedPurpose: string | null // feature.objective ?? feature.title
  // claude recebe --session-id no spawn: o ccSessionId existe já no INSERT.
  ccSessionIdAtSpawn: boolean
}
