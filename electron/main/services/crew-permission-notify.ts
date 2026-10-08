import { getDb } from './db'
import { isActiveCrewChild } from './handoff-store'
import { getMainWindow, getNotifPrefs, getRendererFocusedSession, notify } from './notifications'
import { tuiMenuWatch, type TuiMenuWatch } from './tui-menu-watch'
import { permissionSummary, sanitizeSummary } from '../../../shared/tui/permission-request'

// A filha do Crew Dock não notifica fim de turno (o dock já mostra), mas um
// pedido de permissão TRAVA o agente até alguém responder — e o dock não diz o
// quê. Este aviso é só pra esse caso; o fim de turno segue suprimido em
// session-activity. Uma notificação por aparição do menu (menuSeq).
const lastNotified = new Map<string, number>()

export function notifyCrewPermission(sessionId: string, watch: TuiMenuWatch = tuiMenuWatch): void {
  const menu = watch.current(sessionId)?.menu
  const seq = watch.currentMenuSeq(sessionId)
  if (!menu || seq == null) {
    if (!watch.has(sessionId)) lastNotified.delete(sessionId)
    return
  }
  if (menu.kind !== 'permission' || lastNotified.get(sessionId) === seq) return

  const row = getDb()
    .prepare('SELECT cc_session_id, title FROM sessions WHERE id = ?')
    .get(sessionId) as { cc_session_id: string | null; title: string | null } | undefined
  if (!row?.cc_session_id || !isActiveCrewChild(row.cc_session_id)) return
  lastNotified.set(sessionId, seq)

  const prefs = getNotifPrefs()
  if (!prefs.enabled || !prefs.sessionWaiting) return
  if (getMainWindow()?.isFocused() && getRendererFocusedSession() === row.cc_session_id) return

  const alias = sanitizeSummary(row.title ?? '', 40) || 'Filha'
  const summary = permissionSummary(menu)
  notify({
    title: summary ? `${alias} pede permissão: ${summary}` : `${alias} pede permissão`,
    body: 'Responda pelo quick look da filha ou pela fila de atenção.',
    ccSessionId: row.cc_session_id,
  })
}

export function resetCrewPermissionNotifyForTests(): void {
  lastNotified.clear()
}
