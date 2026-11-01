import { useState } from 'react'
import { MoreHorizontal } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Icon } from '@/components/ui/Icon'
import { Menu } from '@/components/ui/Menu'
import { cx } from '@/features/brand'
import { useDesignStore } from '@/store/designStore'
import type { DesignFolder } from '@shared/types/design'
import type { DiagramFolder } from '@shared/types/ipc'
import { InlineInput } from '../InlineInput'
import { FOLDER_COLORS, folderColorCss, folderDotStyle } from './folder-colors'
import { dropId } from './hub-filter'
import { NavRow } from './NavRow'

type Mode = 'idle' | 'renaming' | 'color' | 'confirm-delete'

// Design and Diagrams folders share one shape (folder-store-core).
type HubFolder = DesignFolder | DiagramFolder

export const SIDEBAR_INPUT_CLASS =
  'my-0.5 h-7 w-full rounded-md border border-[var(--color-accent)] bg-[var(--color-bg)] px-2 text-[12px] text-[var(--color-text)] outline-none'

export function FolderDot({ color }: { color: string | null }) {
  return (
    <span
      aria-hidden
      data-folder-color={color ?? 'none'}
      className="h-2 w-2 shrink-0 rounded-full"
      style={folderDotStyle(color)}
    />
  )
}

function ColorPicker({
  folder,
  onPick,
  onClose,
}: {
  folder: HubFolder
  onPick: (color: string | null) => void
  onClose: () => void
}) {
  const options = [...FOLDER_COLORS.map((c) => ({ key: c.key as string | null, label: c.label })), { key: null, label: 'Sem cor' }]
  return (
    <div
      role="group"
      aria-label={`Cor da pasta ${folder.name}`}
      onKeyDown={(e) => e.key === 'Escape' && onClose()}
      className="flex flex-wrap items-center gap-1.5 px-2 pb-2 pt-1"
    >
      {options.map((o, i) => {
        const current = folder.color === o.key
        return (
          <button
            key={o.label}
            type="button"
            autoFocus={current || (i === 0 && !options.some((x) => x.key === folder.color))}
            aria-label={o.label}
            aria-pressed={current}
            title={o.label}
            onClick={() => onPick(o.key)}
            className={cx(
              'flex h-5 w-5 items-center justify-center rounded-full outline-none transition focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:ring-offset-1 focus-visible:ring-offset-[var(--color-surface)]',
              current ? 'ring-2 ring-[var(--color-text)]/70' : 'hover:scale-110 motion-reduce:hover:scale-100',
              o.key === null && 'border border-dashed border-[var(--color-text-dim)]',
            )}
            style={o.key ? { background: folderColorCss(o.key) } : undefined}
          />
        )
      })}
    </div>
  )
}

function DeleteConfirm({
  folder,
  itemsLabel,
  onConfirm,
  onCancel,
}: {
  folder: HubFolder
  itemsLabel: string
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <div
      role="alertdialog"
      aria-label={`Excluir a pasta ${folder.name}`}
      onKeyDown={(e) => e.key === 'Escape' && onCancel()}
      className="mx-1 mb-1.5 mt-0.5 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)]/60 px-2.5 py-2 text-[11px] text-[var(--color-text-dim)]"
    >
      <p className="text-[var(--color-text)]">Excluir “{folder.name}”?</p>
      <p className="mt-0.5">
        {folder.docCount > 0 ? `Os ${itemsLabel} dela vão para Sem pasta.` : 'A pasta está vazia.'}
      </p>
      <div className="mt-2 flex gap-1.5">
        <Button variant="danger" className="px-2.5 py-0.5 text-[11px]" onClick={onConfirm}>
          Excluir
        </Button>
        <Button autoFocus variant="ghost" className="px-2.5 py-0.5 text-[11px]" onClick={onCancel}>
          Cancelar
        </Button>
      </div>
    </div>
  )
}

export function FolderItem({ folder }: { folder: DesignFolder }) {
  const hubFolder = useDesignStore((s) => s.hubFolder)
  const setHubFolder = useDesignStore((s) => s.setHubFolder)
  const renameFolder = useDesignStore((s) => s.renameFolder)
  const recolorFolder = useDesignStore((s) => s.recolorFolder)
  const deleteFolder = useDesignStore((s) => s.deleteFolder)
  return (
    <FolderRow
      folder={folder}
      itemsLabel="designs"
      active={hubFolder === folder.id}
      onSelect={() => setHubFolder(folder.id)}
      onRename={(name) => void renameFolder(folder.id, name)}
      onRecolor={(color) => void recolorFolder(folder.id, color)}
      onDelete={() => void deleteFolder(folder.id)}
    />
  )
}

// Store-agnostic folder entry: the Diagrams hub binds it to its own store.
export function FolderRow({
  folder,
  itemsLabel,
  active,
  onSelect,
  onRename,
  onRecolor,
  onDelete,
}: {
  folder: HubFolder
  itemsLabel: string
  active: boolean
  onSelect: () => void
  onRename: (name: string) => void
  onRecolor: (color: string | null) => void
  onDelete: () => void
}) {
  const [mode, setMode] = useState<Mode>('idle')
  const [menuOpen, setMenuOpen] = useState(false)

  if (mode === 'renaming') {
    return (
      <li>
        <InlineInput
          placeholder="Nome da pasta"
          initial={folder.name}
          className={SIDEBAR_INPUT_CLASS}
          onSubmit={(name) => {
            setMode('idle')
            if (name !== folder.name) onRename(name)
          }}
          onCancel={() => setMode('idle')}
        />
      </li>
    )
  }

  return (
    <li>
      <NavRow
        dropId={dropId(folder.id)}
        active={active}
        onSelect={onSelect}
        leading={<FolderDot color={folder.color} />}
        label={folder.name}
        count={folder.docCount}
        trailing={
          <Menu
            open={menuOpen}
            onClose={() => setMenuOpen(false)}
            portal
            items={[
              { label: 'Renomear', onClick: () => setMode('renaming') },
              { label: 'Cor…', onClick: () => setMode('color') },
              { label: 'Excluir…', onClick: () => setMode('confirm-delete'), danger: true },
            ]}
          >
            <button
              type="button"
              aria-label={`Opções da pasta ${folder.name}`}
              aria-expanded={menuOpen}
              title="Opções"
              onClick={() => setMenuOpen((o) => !o)}
              className="mr-1 flex h-5 w-5 items-center justify-center rounded text-[var(--color-text-dim)] opacity-0 outline-none transition hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text)] focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] group-hover:opacity-100 group-focus-within:opacity-100 aria-expanded:opacity-100"
            >
              <Icon as={MoreHorizontal} size={12} />
            </button>
          </Menu>
        }
      />
      {mode === 'color' && (
        <ColorPicker
          folder={folder}
          onPick={(color) => {
            setMode('idle')
            onRecolor(color)
          }}
          onClose={() => setMode('idle')}
        />
      )}
      {mode === 'confirm-delete' && (
        <DeleteConfirm
          folder={folder}
          itemsLabel={itemsLabel}
          onConfirm={() => {
            setMode('idle')
            onDelete()
          }}
          onCancel={() => setMode('idle')}
        />
      )}
    </li>
  )
}
