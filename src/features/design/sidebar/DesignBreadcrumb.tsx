import { ChevronRight } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import { useDesignStore, type HubSection } from '@/store/designStore'
import { FolderDot } from '../hub/FolderItem'

const crumbClass =
  'rounded px-1 py-0.5 outline-none transition hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text)] focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]'

// Editor mode: Designs / <Pasta> / <Doc>. The first two close the document
// and land on that hub section.
export function DesignBreadcrumb() {
  const doc = useDesignStore((s) => s.doc)
  const folders = useDesignStore((s) => s.folders)
  const closeDoc = useDesignStore((s) => s.closeDoc)
  const setHubFolder = useDesignStore((s) => s.setHubFolder)
  if (!doc) return null

  const folder = folders.find((f) => f.id === doc.folderId)
  const back = (section: HubSection) => {
    setHubFolder(section)
    void closeDoc()
  }

  return (
    <nav
      aria-label="Caminho do design"
      className="flex min-w-0 shrink-0 items-center gap-0.5 border-b border-[var(--color-border)] px-2 py-2 text-[11px] text-[var(--color-text-dim)]"
    >
      <button type="button" onClick={() => back('recent')} className={`shrink-0 ${crumbClass}`}>
        Designs
      </button>
      <Icon as={ChevronRight} size={11} aria-hidden className="shrink-0 opacity-60" />
      {/* The folder keeps its name (up to 40%); the document title truncates. */}
      <button
        type="button"
        onClick={() => back(folder ? folder.id : 'unfiled')}
        className={`flex max-w-[40%] shrink-0 items-center gap-1.5 ${crumbClass}`}
      >
        {folder && <FolderDot color={folder.color} />}
        <span className="min-w-0 truncate">{folder?.name ?? (doc.folderId ? 'Pasta' : 'Sem pasta')}</span>
      </button>
      <Icon as={ChevronRight} size={11} aria-hidden className="shrink-0 opacity-60" />
      <span aria-current="page" className="min-w-0 flex-1 truncate px-1 font-medium text-[var(--color-text)]">
        {doc.title}
      </span>
    </nav>
  )
}
