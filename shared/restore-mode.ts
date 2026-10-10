// Pref do lazy restore, uma chave só para o escritor (Configurações → Sessão) e o
// leitor (restore-plan no main). 'lazy' = só as eager sobem no boot.
export const RESTORE_MODE_PREF = 'sessions.restoreMode'
export type RestoreMode = 'lazy' | 'eager'
export const DEFAULT_RESTORE_MODE: RestoreMode = 'lazy'
