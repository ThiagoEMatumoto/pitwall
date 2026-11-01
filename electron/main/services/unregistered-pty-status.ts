import { tuiMenuWatch } from './tui-menu-watch'
import type { SessionGraphStatus } from '../../../shared/types/session-graph'

// PTY viva sem session file do CLI (ou com o PID do arquivo morto): o claude ainda
// não se registrou. O diálogo de trust vem ANTES desse registro, então tratar a
// ausência como 'ended' sumia com a sessão da strip justo quando ela precisa de
// você. Menu na tela = waiting; senão está subindo.
export function unregisteredPtyStatus(ptyId: string): Extract<SessionGraphStatus, 'waiting' | 'starting'> {
  return tuiMenuWatch.current(ptyId)?.menu ? 'waiting' : 'starting'
}
