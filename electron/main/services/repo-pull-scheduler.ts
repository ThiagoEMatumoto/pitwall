import { getPref } from './prefs-store'
import { pullAllWithToasts } from '../ipc/git'
import { isE2E } from './e2e-mode'

// Cron de auto-pull dos repos de projeto, LIGADO por padrão (opt-out). Extraído
// de index.ts pra poder ser chamado também pelo handler prefs:set — sem isso,
// ligar o toggle ou mudar o intervalo com o app já aberto só tinha efeito depois
// de reiniciar (o agendamento só era montado uma vez, no boot).

export const AUTO_PULL_ENABLED_KEY = 'autoPullEnabled'
export const AUTO_PULL_INTERVAL_MINUTES_KEY = 'autoPullIntervalMinutes'

let autoPullTimer: ReturnType<typeof setInterval> | null = null

// Pull ff-only best-effort de todos os repos locais, gated pela pref
// autoPullEnabled (default TRUE: sem a pref gravada, roda). Best-effort:
// qualquer falha é logada e o boot/tick segue.
export async function runAutoPullNow(): Promise<void> {
  // `git pull` nos repos REAIS do usuário — num run anterior do harness isto
  // rodou nos 31. O boot já não agenda sob e2e; aqui fecha o disparo por IPC.
  if (isE2E()) return
  if (!getPref(AUTO_PULL_ENABLED_KEY, true)) return
  try {
    await pullAllWithToasts('auto')
  } catch (err) {
    console.error('[repo-sync] auto-pull falhou:', err)
  }
}

// (Re)agenda o cron de auto-pull conforme as prefs. Chamado no boot e no handler
// prefs:set quando autoPullEnabled/autoPullIntervalMinutes muda — o intervalo
// (default 30min) é lido a cada agendamento. Guardamos a ref pra limpar no
// shutdown/reagendamento. Não roda o tick imediato — quem chama decide se dispara
// um runAutoPullNow() à parte (o boot faz isso, ver index.ts).
export function rescheduleAutoPull(): void {
  if (autoPullTimer) {
    clearInterval(autoPullTimer)
    autoPullTimer = null
  }
  if (!getPref(AUTO_PULL_ENABLED_KEY, true)) return
  const minutes = Math.max(1, getPref(AUTO_PULL_INTERVAL_MINUTES_KEY, 30))
  autoPullTimer = setInterval(() => void runAutoPullNow(), minutes * 60 * 1000)
}

// Limpa o timer (usado no shutdown do app).
export function stopAutoPull(): void {
  if (autoPullTimer) {
    clearInterval(autoPullTimer)
    autoPullTimer = null
  }
}
