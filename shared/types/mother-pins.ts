import type { Session } from './ipc'

// "Essa é a mãe": papel marcado pelo humano, por conversa (cc_session_id ?? sessions.id).
export interface MotherPin {
  key: string
  pinnedAt: number
}

export interface SetMotherPinInput {
  sessionId: string
  pinned: boolean
}

export interface ImportMotherPinsInput {
  // Chaves de conversa já resolvidas (pins da Room).
  keys: string[]
  // sessions.id a resolver no main (pin do MotherDock).
  sessionIds: string[]
}

export interface PromoteMotherInput {
  sessionId: string
  // 'when-idle': com turno em andamento, relança no fim do turno.
  restart: 'now' | 'when-idle'
}

export interface PromoteMotherResult {
  pinKey: string
  released: number
  transferred: number
  restart: 'not-needed' | 'restarting' | 'scheduled'
}

// 'relaunching' sai ANTES do kill (a aba fica no lugar em vez de fechar com o exit);
// 'restarted' leva a sessão relançada, que a mesma aba adota.
export interface MotherRestartEvent {
  sessionId: string
  state: 'scheduled' | 'relaunching' | 'restarted' | 'failed'
  ccSessionId?: string
  newSessionId?: string
  session?: Session
  error?: string
}
