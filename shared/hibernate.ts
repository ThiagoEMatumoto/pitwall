// Hibernação por ociosidade: a pref (escritor = Configurações → Sessão, leitor =
// o tick no main) e o contrato dos contadores que a mesma seção exibe.
export const HIBERNATE_AFTER_MIN_PREF = 'sessions.hibernateAfterMin'
// 0 = desligado.
export const DEFAULT_HIBERNATE_AFTER_MIN = 0
export const MAX_HIBERNATE_AFTER_MIN = 24 * 60

export function sanitizeHibernateAfterMin(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return 0
  return Math.min(Math.floor(raw), MAX_HIBERNATE_AFTER_MIN)
}

// Um motivo por recusa (o primeiro gate que falhou). Na dúvida, o gate recusa.
export const HIBERNATE_REFUSALS = [
  'no-pane',
  'io-recent',
  'status-missing',
  'status-dead',
  'status-not-idle',
  'status-recent',
  'handoff',
  'queue',
  'agent-msg',
  'no-transcript',
  'scheduled',
  'proc-tree',
  'guard-held',
  'exit-timeout',
] as const

export type HibernateRefusal = (typeof HIBERNATE_REFUSALS)[number]

export interface HibernateStats {
  // Minutos da pref no último tick (0 = desligado, nenhum tick roda).
  afterMin: number
  hibernated: number
  refused: Record<HibernateRefusal, number>
  lastTickAt: number | null
}

// Main → renderer, ANTES do pty:exit da mesma PTY: a pane vira dormant em vez
// de fechar com o toast de sessão encerrada.
export interface SessionHibernatedEvent {
  sessionId: string
  ccSessionId: string
}
