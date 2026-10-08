import { openFeatureSwitcher } from '@/features/session-canvas/FeatureSwitcher'
import { isProjectKey } from '@/features/session-canvas/feature-switcher-model'
import { useFeatureMruStore } from '@/features/session-canvas/feature-mru-store'
import { useMapFocusStore } from '@/features/session-canvas/map-focus-store'
import { useFeatureRoomStore } from './feature-room-store'

// A feature que o item "Room" da navegação abre: a última Room aberta, senão a
// feature em foco no mapa, senão a mais recente do seletor (Ctrl+`).
export function roomEntryFeatureId(): string | null {
  return (
    useFeatureRoomStore.getState().featureId ??
    useMapFocusStore.getState().featureId ??
    useFeatureMruStore.getState().order.find((k) => !isProjectKey(k)) ??
    null
  )
}

// Sem nenhuma feature conhecida, abre o seletor: confirmar nele leva à Room.
export function openRoomFromNav(): void {
  const featureId = roomEntryFeatureId()
  if (featureId) useFeatureRoomStore.getState().openRoom(featureId)
  else openFeatureSwitcher()
}
