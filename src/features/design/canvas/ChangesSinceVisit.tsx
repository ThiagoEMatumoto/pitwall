import { useState } from 'react'
import { ChevronDown, Sparkles, X } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import { useDesignStore } from '@/store/designStore'

function viewArtboard(artboardId: string): void {
  const s = useDesignStore.getState()
  s.select(artboardId, [])
  s.fitToArtboard(artboardId)
}

// "Claude alterou N artboards desde sua visita": design_nodes_finish events
// that landed while the human was in another area or document.
export function ChangesSinceVisit() {
  const changes = useDesignStore((s) => s.unseenChanges)
  const artboards = useDesignStore((s) => s.artboards)
  const docId = useDesignStore((s) => s.docId)
  const markSeen = useDesignStore((s) => s.markSeen)
  const [open, setOpen] = useState(false)

  if (!docId || changes.length === 0) return null
  const touched = new Set(changes.map((c) => c.artboardId).filter(Boolean)).size
  const label =
    touched === 1
      ? 'Claude alterou 1 artboard desde sua visita'
      : `Claude alterou ${touched} artboards desde sua visita`

  return (
    <div className="pointer-events-none absolute inset-x-0 top-2 z-20 flex justify-center px-3">
      <div className="pointer-events-auto max-w-md rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] text-[11px] text-[var(--color-text)] shadow-md">
        <div className="flex items-center gap-2 px-2 py-1">
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
            className="flex min-w-0 flex-1 items-center gap-1.5 rounded px-1 py-0.5 transition hover:bg-[var(--color-surface-2)]"
          >
            <Icon as={Sparkles} size={12} className="shrink-0 text-[var(--color-accent)]" />
            <span className="truncate">{label}</span>
            <Icon
              as={ChevronDown}
              size={12}
              className={`shrink-0 opacity-70 transition ${open ? 'rotate-180' : ''}`}
            />
          </button>
          <button
            type="button"
            title="Dispensar"
            onClick={() => markSeen(docId)}
            className="flex h-5 w-5 items-center justify-center rounded text-[var(--color-text-dim)] transition hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text)]"
          >
            <Icon as={X} size={12} />
          </button>
        </div>
        {open && (
          <ul className="max-h-48 overflow-y-auto border-t border-[var(--color-border)] py-1">
            {[...changes].reverse().map((c) => {
              const meta = c.artboardId ? artboards[c.artboardId]?.meta : undefined
              return (
                <li key={`${c.artboardId}:${c.at}`}>
                  <button
                    type="button"
                    disabled={!meta}
                    onClick={() => meta && viewArtboard(meta.id)}
                    className="flex w-full flex-col items-start px-3 py-1 text-left transition enabled:hover:bg-[var(--color-surface-2)] disabled:opacity-50"
                  >
                    <span className="font-medium">{meta?.name ?? 'artboard removido'}</span>
                    {c.summary && (
                      <span className="text-[var(--color-text-dim)]">{c.summary}</span>
                    )}
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}
