import { ChevronRight } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'

// Linha clicável de telemetria: mesma altura, mesmo foco, mesmo chevron em
// todo o chat — linhas de ferramenta, grupo e raciocínio falam a mesma língua.
export const ROW_BUTTON =
  'flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1 text-left text-xs transition-colors duration-150 hover:bg-[var(--color-surface-2)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--color-accent)]'

export function Chevron({ open }: { open: boolean }) {
  return (
    <Icon
      as={ChevronRight}
      size={12}
      className={`shrink-0 text-[var(--color-text-dim)] transition-transform duration-200 ease-out motion-reduce:transition-none ${open ? 'rotate-90' : ''}`}
    />
  )
}
