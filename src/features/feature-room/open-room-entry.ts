import { useRoomPanelStore } from './room-panel-store'

// O item "Room" da navegação leva à visão de projeto com o painel da Room aberto
// (o destino padrão desde que a Room virou painel). A área 'room' em tela cheia
// segue no botão ⤢ do painel.
export function openRoomFromNav(): void {
  useRoomPanelStore.getState().show()
}
