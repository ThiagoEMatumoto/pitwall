import { useState, type CSSProperties } from 'react'
import { useDraggable } from '@dnd-kit/core'
import { MoreHorizontal } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import { Menu } from '@/components/ui/Menu'
import { cx } from '@/features/brand'
import { relativeTime } from '@/lib/time'
import { useDesignStore } from '@/store/designStore'
import type { DesignDocumentMeta, DesignFolder } from '@shared/types/design'
import { useFreshActivity } from '../AgentActivityBadge'
import { AgentWorkingDot } from '../AgentWorkingDot'
import { InlineInput } from '../InlineInput'
import { moveSection } from './doc-menu'
import { DocThumb } from './DocThumb'
import { folderDotStyle } from './folder-colors'

// Entrance stagger stops growing after a dozen cards: a long grid would
// otherwise keep the last rows invisible for seconds.
const MAX_STAGGER = 12

function WorkingPill({ docId }: { docId: string }) {
  const fresh = useFreshActivity(useDesignStore((s) => s.activityByDoc[docId]))
  if (fresh.length === 0) return null
  return (
    <span className="flex items-center gap-1.5 rounded-full bg-[color-mix(in_srgb,var(--color-bg)_82%,transparent)] px-2 py-0.5 text-[10px] font-medium text-[var(--color-text)]">
      <AgentWorkingDot docId={docId} />
      <span aria-hidden>Claude</span>
    </span>
  )
}

export function FolderChip({ folder }: { folder: DesignFolder }) {
  return (
    <span className="flex min-w-0 items-center gap-1">
      <span
        aria-hidden
        className="h-1.5 w-1.5 shrink-0 rounded-full"
        style={folderDotStyle(folder.color)}
      />
      <span className="truncate">{folder.name}</span>
    </span>
  )
}

export function DocCard({
  doc,
  index,
  showFolder,
}: {
  doc: DesignDocumentMeta
  index: number
  showFolder: boolean
}) {
  const folders = useDesignStore((s) => s.folders)
  const openDoc = useDesignStore((s) => s.openDoc)
  const moveDoc = useDesignStore((s) => s.moveDoc)
  const archiveDoc = useDesignStore((s) => s.archiveDoc)
  const unarchiveDoc = useDesignStore((s) => s.unarchiveDoc)
  const retitleDoc = useDesignStore((s) => s.retitleDoc)
  const isNew = useDesignStore(
    (s) => (s.lastFinishAt[doc.id] ?? 0) > (s.lastSeenAt[doc.id] ?? 0),
  )
  const [menuOpen, setMenuOpen] = useState(false)
  const [renaming, setRenaming] = useState(false)
  // Selecting text in the rename field must not pick the card up.
  const { setNodeRef, listeners, isDragging } = useDraggable({ id: doc.id, disabled: renaming })

  const archived = doc.status === 'archived'
  const folder = showFolder ? folders.find((f) => f.id === doc.folderId) : undefined

  return (
    <article
      ref={setNodeRef}
      {...listeners}
      data-testid="doc-card"
      className={cx(
        'group relative home-rise motion-reduce:animate-none',
        isDragging && 'opacity-40',
      )}
      style={{ '--i': Math.min(index, MAX_STAGGER) } as CSSProperties}
    >
      <div className="glass-card flex h-full flex-col overflow-hidden transition duration-200 ease-out group-hover:-translate-y-px group-hover:border-[var(--color-accent-dim)]/40 group-focus-within:border-[var(--color-accent-dim)]/60 motion-reduce:transition-none motion-reduce:group-hover:translate-y-0">
        <div className="relative aspect-[16/10] overflow-hidden border-b border-white/[0.04] bg-[var(--color-surface-2)]">
          <DocThumb key={doc.thumbnailVersion ?? 'none'} docId={doc.id} version={doc.thumbnailVersion} />
          <div className="pointer-events-none absolute inset-x-2 top-2 flex items-start justify-between gap-2">
            {isNew ? (
              <span
                title="Claude mudou este design desde a sua última visita"
                className="rounded-full bg-[var(--color-accent)] px-1.5 py-0.5 text-[10px] font-semibold leading-none text-[var(--color-bg)]"
              >
                novo
              </span>
            ) : (
              <span />
            )}
            <WorkingPill docId={doc.id} />
          </div>
        </div>

        <div className="flex items-start gap-1 px-3 pb-2.5 pt-2">
          <div className="min-w-0 flex-1">
            {renaming ? (
              <InlineInput
                placeholder="Nome do design"
                initial={doc.title}
                className="relative z-10 h-6 w-full rounded-md border border-[var(--color-accent)] bg-[var(--color-bg)] px-1.5 text-[13px] text-[var(--color-text)] outline-none"
                onSubmit={(title) => {
                  setRenaming(false)
                  if (title !== doc.title) void retitleDoc(doc.id, title)
                }}
                onCancel={() => setRenaming(false)}
              />
            ) : (
              // Stretched over the whole card: one tab stop, the card is the target.
              <button
                type="button"
                onClick={() => void openDoc(doc.id)}
                className="block w-full truncate text-left text-[13px] font-medium leading-6 text-[var(--color-text)] outline-none after:absolute after:inset-0 after:rounded-xl focus-visible:after:ring-2 focus-visible:after:ring-[var(--color-accent)]"
              >
                {doc.title}
              </button>
            )}
            <div className="flex min-w-0 items-center gap-1.5 text-[11px] text-[var(--color-text-dim)]">
              <span className="shrink-0 tabular-nums">{relativeTime(doc.updatedAt)}</span>
              {folder && (
                <>
                  <span aria-hidden>·</span>
                  <FolderChip folder={folder} />
                </>
              )}
            </div>
          </div>

          {/* Pointer events from the portaled menu bubble here through React,
              not up to the draggable card. */}
          <div className="relative z-10" onPointerDown={(e) => e.stopPropagation()}>
            <Menu
              open={menuOpen}
              onClose={() => setMenuOpen(false)}
              portal
              sections={[
                {
                  title: 'Design',
                  items: [
                    { label: 'Renomear', onClick: () => setRenaming(true) },
                    archived
                      ? { label: 'Desarquivar', onClick: () => void unarchiveDoc(doc.id) }
                      : { label: 'Arquivar', onClick: () => void archiveDoc(doc.id), danger: true },
                  ],
                },
                moveSection(folders, doc.folderId, (folderId) => void moveDoc(doc.id, folderId)),
              ]}
            >
              <button
                type="button"
                aria-label={`Opções de ${doc.title}`}
                title="Opções"
                onClick={() => setMenuOpen((o) => !o)}
                className="flex h-6 w-6 items-center justify-center rounded-md text-[var(--color-text-dim)] opacity-0 outline-none transition hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text)] focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] group-hover:opacity-100 group-focus-within:opacity-100 aria-expanded:opacity-100"
                aria-expanded={menuOpen}
              >
                <Icon as={MoreHorizontal} size={14} />
              </button>
            </Menu>
          </div>
        </div>
      </div>
    </article>
  )
}

// What follows the pointer while dragging: the card's thumbnail and title.
export function DragChip({ doc }: { doc: DesignDocumentMeta }) {
  return (
    <div className="glass-card flex w-56 cursor-grabbing items-center gap-2 overflow-hidden p-1.5 pr-3 shadow-2xl">
      <div className="aspect-[16/10] w-14 shrink-0 overflow-hidden rounded-md bg-[var(--color-surface-2)]">
        <DocThumb docId={doc.id} version={doc.thumbnailVersion} />
      </div>
      <span className="truncate text-[12px] font-medium text-[var(--color-text)]">{doc.title}</span>
    </div>
  )
}
