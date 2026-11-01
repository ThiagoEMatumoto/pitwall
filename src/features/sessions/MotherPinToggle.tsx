import { Crown } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'

// "Marcar como mãe" / "Desmarcar": o mesmo controle em todas as superfícies.
// Marcada = coroa preenchida em accent; desmarcada = contorno discreto.
export function MotherPinToggle({
  pinned,
  onToggle,
  hint,
  size = 12,
  className = '',
}: {
  pinned: boolean
  onToggle: () => void
  hint?: string
  size?: number
  className?: string
}) {
  const label = pinned ? 'Desmarcar como mãe' : 'Marcar como mãe'
  return (
    <button
      type="button"
      data-testid="mother-pin-toggle"
      aria-pressed={pinned}
      aria-label={label}
      title={hint ? `${label} (${hint})` : label}
      onClick={(e) => {
        e.stopPropagation()
        onToggle()
      }}
      className={`flex shrink-0 items-center justify-center rounded p-1 leading-none transition-[color,opacity,background-color] duration-150 ease-out motion-reduce:transition-none focus-visible:outline focus-visible:outline-1 focus-visible:outline-[var(--color-accent)] ${
        pinned
          ? 'text-[var(--color-accent)] hover:bg-[var(--color-surface-2)]'
          : 'text-[var(--color-text-dim)] hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text)]'
      } ${className}`}
    >
      <Icon as={Crown} size={size} className={pinned ? 'fill-current' : undefined} />
    </button>
  )
}
