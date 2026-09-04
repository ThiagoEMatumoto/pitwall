// Root → selection path over the canvas. It exists to make the scope visible:
// after a double click the same click starts selecting one level deeper, and
// the breadcrumb is the only thing saying where "one level" starts. Clicking a
// crumb enters it (selection + scope), so a wrong dive is one click to undo.

import { ChevronRight } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import { getNodeIndex, useDesignStore } from '@/store/designStore'
import { rowLabel } from '../sidebar/LayerRow'
import { crumbTarget, nodePath } from './scope-path'

export function SelectionBreadcrumb() {
  const mode = useDesignStore((s) => s.mode)
  const artboardId = useDesignStore((s) => s.selection.artboardId)
  const nodeIds = useDesignStore((s) => s.selection.nodeIds)
  const scopeId = useDesignStore((s) => s.scopeId)
  const artboard = useDesignStore((s) => (artboardId ? s.artboards[artboardId] : undefined))
  const select = useDesignStore((s) => s.select)
  const setScope = useDesignStore((s) => s.setScope)

  if (mode !== 'edit' || !artboardId || !artboard) return null

  const index = getNodeIndex(artboardId)
  const targetId = nodeIds.length === 1 ? nodeIds[0] : scopeId
  const path =
    targetId && index?.has(targetId)
      ? nodePath(targetId, (id) => index.get(id)?.parentId ?? null)
      : [artboard.tree.id]

  const enter = (i: number): void => {
    const target = crumbTarget(path, i)
    select(artboardId, target.nodeId ? [target.nodeId] : [])
    setScope(target.scopeId)
  }

  return (
    <nav
      aria-label="Caminho da seleção"
      className="absolute bottom-3 left-3 flex max-w-[60%] items-center gap-0.5 overflow-x-auto rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-xs text-[var(--color-text-dim)]"
    >
      {path.map((id, i) => {
        const node = index?.get(id)?.node
        const label = i === 0 ? artboard.meta.name : node ? rowLabel(node) : id
        const last = i === path.length - 1
        return (
          <span key={id} className="flex shrink-0 items-center gap-0.5">
            {i > 0 && <Icon as={ChevronRight} size={12} />}
            <button
              type="button"
              onClick={() => enter(i)}
              title={id === scopeId ? `${label} (escopo atual)` : `Entrar em ${label}`}
              className={`max-w-[10rem] truncate rounded-md px-1.5 py-0.5 transition hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text)] ${
                id === scopeId
                  ? 'text-[var(--color-accent)]'
                  : last
                    ? 'text-[var(--color-text)]'
                    : ''
              }`}
            >
              {label}
            </button>
          </span>
        )
      })}
      {nodeIds.length > 1 && (
        <span className="flex shrink-0 items-center gap-0.5">
          <Icon as={ChevronRight} size={12} />
          <span className="px-1.5 py-0.5 text-[var(--color-text)]">
            {nodeIds.length} selecionados
          </span>
        </span>
      )}
    </nav>
  )
}
