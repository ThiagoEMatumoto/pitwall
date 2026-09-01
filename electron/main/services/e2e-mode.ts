// Kill-switch fail-closed do harness de e2e (`drive-app`).
//
// O harness lança o app buildado contra uma CÓPIA do userData real. A cópia
// isola o BANCO — não isola o mundo: git remoto, disco, rede e ~/.claude
// continuam sendo os do usuário. Em 31/08 um run do drive disparou o
// coordinator de sync, que deu `git push` de um bundle de teste no repo de
// backup REAL; o pull do boot seguinte importou aquilo no perfil do usuário e
// deixou 33 repos "fora do disco". A exclusão de `sync/` na cópia
// (e2e/driver/launch.ts) segue lá como defesa em profundidade, mas é
// fail-OPEN: cobre o vetor conhecido e nada mais.
//
// Este módulo é a proteção principal e é fail-CLOSED: uma flag no ambiente
// desliga TODOS os side-effects externos de uma vez. Sem a flag o
// comportamento é idêntico ao de sempre — o default é `false`.
export const E2E_ENV_FLAG = 'CM_E2E'

// Lido a cada chamada (sem cache): o boot guarda os inits e os serviços guardam
// a ação em si, então um cenário que dispare a ação por IPC bate no mesmo
// portão.
export function isE2E(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[E2E_ENV_FLAG] === '1'
}

// O que o modo desliga, na ordem em que o boot os iniciaria. Existe para virar
// UMA linha de log no boot: sem essa prova, uma validação futura não tem como
// afirmar que o kill-switch estava mesmo ativo durante o run.
export const E2E_DISABLED_SIDE_EFFECTS = [
  'sync (push/pull/import/flush-no-quit)',
  'auto-pull de repos',
  'auto-clone de repos faltantes',
  'scheduled jobs',
  'usage monitor',
  'calendar watcher',
  'feature watcher',
] as const

export function e2eBootLogLine(): string {
  return `[e2e] ${E2E_ENV_FLAG}=1 — side-effects externos DESLIGADOS: ${E2E_DISABLED_SIDE_EFFECTS.join(', ')}`
}
