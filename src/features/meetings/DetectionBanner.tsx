import { Mic } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Icon } from '@/components/ui/Icon'
import type { MeetingDetection, MeetingDetectionAction, MeetingLiveState } from '../../../shared/types/ipc'

/** Detecção que ainda pede decisão: nada gravando e o usuário não mandou ignorar. */
export function pendingDetection(live: MeetingLiveState | null): MeetingDetection | null {
  if (!live || live.active || !live.detection || live.detection.ignored) return null
  return live.detection
}

interface Props {
  live: MeetingLiveState | null
  onDecide: (action: MeetingDetectionAction) => void
  compact?: boolean
}

export function DetectionBanner({ live, onDecide, compact = false }: Props) {
  const detection = pendingDetection(live)
  if (!detection) return null

  const buttonSize = compact ? 'px-2.5 py-0.5 text-[11px]' : 'px-3 py-1 text-xs'

  return (
    <div
      role="status"
      className={`flex items-center gap-3 border-b border-[var(--color-border)] bg-[color-mix(in_srgb,var(--color-warning)_10%,transparent)] text-[var(--color-text)] ${
        compact ? 'px-3 py-1.5 text-xs' : 'px-6 py-2.5 text-sm'
      }`}
    >
      <span className="shrink-0 text-[var(--color-warning)]">
        <Icon as={Mic} size={compact ? 12 : 14} />
      </span>
      <span className="min-w-0 flex-1 truncate">
        <strong className="font-semibold">{detection.app}</strong> está usando o microfone — parece uma reunião.
      </span>
      <span className="flex shrink-0 items-center gap-1.5">
        <Button className={buttonSize} onClick={() => onDecide('record')}>
          Gravar
        </Button>
        <Button variant="ghost" className={buttonSize} onClick={() => onDecide('ignore')}>
          Ignorar
        </Button>
      </span>
    </div>
  )
}
