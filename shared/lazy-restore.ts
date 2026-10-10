// Pref do lazy restore (opt-in), uma chave só para o escritor (Configurações →
// Sessão) e o leitor (main). Desligada = boot e entregas idênticos a antes da
// feature: todas as panes sobem eager e nada acorda pane dormindo.
export const LAZY_RESTORE_PREF = 'sessions.lazyRestore'
export const DEFAULT_LAZY_RESTORE = false
