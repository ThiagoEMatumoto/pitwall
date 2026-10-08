import { DoorOpen } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import { useFeatureRoomStore } from './feature-room-store'

// Ação secundária "Abrir Room" ao lado do clique principal de um card de feature.
// O stopPropagation mantém o card (ou a linha) com o destino que já tinha.
export function OpenRoomButton({
  featureId,
  testId = 'open-room',
  className = '',
}: {
  featureId: string
  testId?: string
  className?: string
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      data-feature-id={featureId}
      onClick={(e) => {
        e.stopPropagation()
        useFeatureRoomStore.getState().openRoom(featureId)
      }}
      title="Abrir Room da feature"
      aria-label="Abrir Room da feature"
      className={`flex shrink-0 items-center gap-1 rounded-md border border-[var(--color-border)] px-1.5 py-0.5 text-[10px] text-[var(--color-text-dim)] transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] ${className}`}
    >
      <Icon as={DoorOpen} size={11} />
      Room
    </button>
  )
}
