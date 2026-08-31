import { Columns3, LayoutGrid, LayoutList } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'

// 'wall' é o default: a queixa que abriu a Fase 4 é feature esquecida, e uma
// lista plana não tem primeiro plano. Lista e board continuam a um clique.
export type ViewMode = 'wall' | 'list' | 'board'

export function ViewToggle({ value, onChange }: { value: ViewMode; onChange: (v: ViewMode) => void }) {
  return (
    <div className="inline-flex rounded-md border border-[var(--color-border)] p-0.5">
      <button
        type="button"
        onClick={() => onChange('wall')}
        title="Parede"
        data-testid="features-view-wall"
        className={`inline-flex items-center gap-1 rounded px-2 py-1 text-xs transition ${
          value === 'wall'
            ? 'bg-[var(--color-surface-2)] text-[var(--color-text)]'
            : 'text-[var(--color-text-dim)] hover:text-[var(--color-text)]'
        }`}
      >
        <Icon as={LayoutGrid} size={13} />
        Parede
      </button>
      <button
        type="button"
        onClick={() => onChange('list')}
        title="Lista"
        className={`inline-flex items-center gap-1 rounded px-2 py-1 text-xs transition ${
          value === 'list'
            ? 'bg-[var(--color-surface-2)] text-[var(--color-text)]'
            : 'text-[var(--color-text-dim)] hover:text-[var(--color-text)]'
        }`}
      >
        <Icon as={LayoutList} size={13} />
        Lista
      </button>
      <button
        type="button"
        onClick={() => onChange('board')}
        title="Board"
        className={`inline-flex items-center gap-1 rounded px-2 py-1 text-xs transition ${
          value === 'board'
            ? 'bg-[var(--color-surface-2)] text-[var(--color-text)]'
            : 'text-[var(--color-text-dim)] hover:text-[var(--color-text)]'
        }`}
      >
        <Icon as={Columns3} size={13} />
        Board
      </button>
    </div>
  )
}
