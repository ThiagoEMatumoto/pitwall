// Hibernação por ociosidade: a pref (escritor = Configurações → Sessão, leitor =
// o tick no main) e o contrato dos contadores que a mesma seção exibe.
export const HIBERNATE_AFTER_MIN_PREF = 'sessions.hibernateAfterMin'
// 0 = desligado.
export const DEFAULT_HIBERNATE_AFTER_MIN = 0
export const MAX_HIBERNATE_AFTER_MIN = 24 * 60

// Filha de handoff concluído (done) e ociosa: janela própria, ligada por padrão.
// Não depende do lazyRestore: ela dorme sem aba e não vira pane dormant.
export const CHILD_HIBERNATE_AFTER_MIN_PREF = 'sessions.childHibernateAfterMin'
export const DEFAULT_CHILD_HIBERNATE_AFTER_MIN = 15

export function sanitizeHibernateAfterMin(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return 0
  return Math.min(Math.floor(raw), MAX_HIBERNATE_AFTER_MIN)
}

// O que a conversa é como filha de handoff: nunca foi ('none'), todos os handoffs
// dela terminaram em done ('done'), ou algum está em voo, falhou ou parou ('other').
export type HandoffChildKind = 'none' | 'done' | 'other'

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
  'handoff-child',
  'queue',
  'no-transcript',
  'scheduled',
  'background-task',
  'proc-tree',
  'guard-held',
  'exit-timeout',
] as const

export type HibernateRefusal = (typeof HIBERNATE_REFUSALS)[number]

export interface HibernateStats {
  // Minutos da hibernação geral no último tick (0 = desligada).
  afterMin: number
  // Minutos da janela da filha de handoff concluído (0 = desligada). O tick roda
  // com qualquer uma das duas ligada.
  childAfterMin: number
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
  // Filha de handoff concluído: dorme sem aba. O renderer tira a pane, se houver,
  // em vez de deixá-la dormant.
  child?: true
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

// Recusa do round-trip (null = pode hibernar). Sem resposta = sem pane. Com
// paneOptional (filha de handoff concluído) a resposta "nenhuma aba" libera; o
// silêncio segue recusando, porque não prova que o usuário não está nela.
export function paneCheckRefusal(
  check: PaneCheck | null,
  paneOptional = false,
): Extract<HibernateRefusal, 'no-pane' | 'pane-focused' | 'composer-busy'> | null {
  if (!check) return 'no-pane'
  if (!check.paneId && !paneOptional) return 'no-pane'
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
