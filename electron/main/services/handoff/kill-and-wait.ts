// Mata a PTY e ESPERA o exit — usado por quem precisa RELANÇAR uma sessão como
// filha (adoção, re-vínculo de sessão retomada como comum).
import { ptyManager } from '../pty-manager'

// Teto de espera pelo exit da PTY antiga. O ptyManager só remove a sessão do mapa
// no evento `exit` (assíncrono), e resumeHandoffChild tem um guard de "filha
// viva" que devolveria alreadyRunning sem relançar nada — sem esta espera, a
// adoção viraria um no-op silencioso.
const PTY_EXIT_TIMEOUT_MS = 5000

// Mata a PTY e ESPERA o exit. Ver PTY_EXIT_TIMEOUT_MS: sem esperar, o resume
// enxergaria a sessão como viva e não relançaria.
export function killAndWaitExit(sessionId: string): Promise<void> {
  if (!ptyManager.isRunning(sessionId)) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const onExit = (e: { sessionId: string }) => {
      if (e.sessionId !== sessionId) return
      clearTimeout(timer)
      ptyManager.off('exit', onExit)
      resolve()
    }
    const timer = setTimeout(() => {
      ptyManager.off('exit', onExit)
      reject(new Error('A sessão não encerrou a tempo para ser relançada como filha.'))
    }, PTY_EXIT_TIMEOUT_MS)
    ptyManager.on('exit', onExit)
    ptyManager.kill(sessionId)
  })
}
