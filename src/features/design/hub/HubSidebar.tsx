import { useState } from 'react'
import { Archive, Clock, Inbox, Plus } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import { useDesignStore } from '@/store/designStore'
import { InlineInput } from '../InlineInput'
import { FolderItem, SIDEBAR_INPUT_CLASS } from './FolderItem'
import { dropId } from './hub-filter'
import { NavRow } from './NavRow'

export function HubSidebar() {
  const docs = useDesignStore((s) => s.docs)
  const folders = useDesignStore((s) => s.folders)
  const hubFolder = useDesignStore((s) => s.hubFolder)
  const setHubFolder = useDesignStore((s) => s.setHubFolder)
  const createFolder = useDesignStore((s) => s.createFolder)
  const [creating, setCreating] = useState(false)

  const unfiled = docs.filter((d) => d.folderId === null).length

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-[var(--color-border)] bg-[var(--color-surface)]">
      <div className="px-4 pb-3 pt-4">
        <h2 className="text-sm font-semibold text-[var(--color-text)]">Designs</h2>
      </div>
      <nav aria-label="Seções de designs" className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        <NavRow
          active={hubFolder === 'recent'}
          onSelect={() => setHubFolder('recent')}
          leading={<Icon as={Clock} size={14} className="shrink-0 opacity-80" />}
          label="Recentes"
          count={docs.length}
        />

        <div className="mt-5 flex items-center justify-between px-2 pb-1">
          <span className="text-[11px] font-medium text-[var(--color-text-dim)]">Pastas</span>
          <button
            type="button"
            aria-label="Nova pasta"
            title="Nova pasta"
            onClick={() => setCreating(true)}
            className="flex h-5 w-5 items-center justify-center rounded text-[var(--color-text-dim)] outline-none transition hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text)] focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
          >
            <Icon as={Plus} size={12} />
          </button>
        </div>
        {creating && (
          <InlineInput
            placeholder="Nome da pasta"
            className={SIDEBAR_INPUT_CLASS}
            onSubmit={(name) => {
              setCreating(false)
              void createFolder(name).then((f) => f && setHubFolder(f.id))
            }}
            onCancel={() => setCreating(false)}
          />
        )}
        <ul className="flex flex-col gap-px">
          {folders.map((f) => (
            <FolderItem key={f.id} folder={f} />
          ))}
        </ul>
        {folders.length === 0 && !creating && (
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="w-full rounded-md px-2 py-1.5 text-left text-[11px] leading-relaxed text-[var(--color-text-dim)] outline-none transition hover:text-[var(--color-text)] focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
          >
            Crie uma pasta para agrupar designs por projeto ou cliente.
          </button>
        )}

        <div className="mt-5 flex flex-col gap-px border-t border-[var(--color-border)] pt-3">
          <NavRow
            dropId={dropId(null)}
            active={hubFolder === 'unfiled'}
            onSelect={() => setHubFolder('unfiled')}
            leading={<Icon as={Inbox} size={14} className="shrink-0 opacity-80" />}
            label="Sem pasta"
            count={unfiled}
          />
          <NavRow
            active={hubFolder === 'archived'}
            onSelect={() => setHubFolder('archived')}
            leading={<Icon as={Archive} size={14} className="shrink-0 opacity-80" />}
            label="Arquivados"
          />
        </div>
      </nav>
    </aside>
  )
}
