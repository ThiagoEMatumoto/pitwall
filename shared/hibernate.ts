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
  'pane-focused',
  'composer-busy',
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
  'background-task',
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
  // Aba confirmada pelo renderer antes do /exit (null = hibernada sem confirmação).
  paneId: string | null
}

// main → renderer, logo antes do /exit: qual aba mostra esta PTY agora?
export interface PaneCheckRequest {
  requestId: string
  sessionId: string
  ccSessionId: string
}

// paneId null = nenhuma aba acordada mostra a PTY. O resto diz se o usuário
// está nela: o Composer não passa pelo PTY, então nem o lastIoAt nem a guarda
// input-dirty enxergam alguém escrevendo ou lendo a aba.
export interface PaneCheckResult {
  requestId: string
  paneId: string | null
  // Aba ativa numa janela com foco.
  focused: boolean
  // Rascunho com texto ou anexo no Composer da aba.
  composerHasText: boolean
  composerFocused: boolean
}

export type PaneCheck = Omit<PaneCheckResult, 'requestId'>

// Recusa do round-trip (null = pode hibernar). Sem resposta = sem pane.
export function paneCheckRefusal(
  check: PaneCheck | null,
): Extract<HibernateRefusal, 'no-pane' | 'pane-focused' | 'composer-busy'> | null {
  if (!check?.paneId) return 'no-pane'
  if (check.focused) return 'pane-focused'
  if (check.composerHasText || check.composerFocused) return 'composer-busy'
  return null
}

// Por que o tick não roda. A ordem é a da checagem: o valor do boot vem antes
// porque, com ele desligado, a pref ao vivo não muda nada até o próximo boot.
export type HibernateDisabledReason =
  'lazy-restore-off-at-boot' | 'lazy-restore-off' | 'after-min-off'

// Contrato de sessions:hibernate-stats (o que a seção de Settings exibe).
export interface HibernateStatsView {
  hibernated: number
  refusals: Record<string, number>
  enabled: boolean
  reasonDisabled?: HibernateDisabledReason
}
