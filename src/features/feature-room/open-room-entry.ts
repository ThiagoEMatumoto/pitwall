import { useFeatureRoomStore } from './feature-room-store'

// O item "Room" da navegação abre "Todas as mães". A sala de uma feature fica a
// um clique (tile, "Abrir sala") ou no seletor (Ctrl+`).
export function openRoomFromNav(): void {
  useFeatureRoomStore.getState().openAllMothers()
}
