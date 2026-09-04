import { useState } from 'react'
import { FileText, LayoutTemplate, MoreHorizontal, Plus } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import { Menu } from '@/components/ui/Menu'
import { activeMarker } from '@/features/brand'
import { api } from '@/lib/ipc'
import { useDesignStore } from '@/store/designStore'
import { customPreset } from '@shared/types/design'
import { ArtboardSizeDialog } from '../ArtboardSizeDialog'
import { formatArtboardSize, formatPresetSize, groupPresets } from '../artboard-format'

function InlineInput({
  placeholder,
  initial = '',
  onSubmit,
  onCancel,
}: {
  placeholder: string
  initial?: string
  onSubmit: (value: string) => void
  onCancel: () => void
}) {
  const [value, setValue] = useState(initial)
  function submit(): void {
    const v = value.trim()
    if (v) onSubmit(v)
    else onCancel()
  }
  return (
    <input
      autoFocus
      type="text"
      value={value}
      placeholder={placeholder}
      onChange={(e) => setValue(e.target.value)}
      onBlur={submit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') submit()
        if (e.key === 'Escape') onCancel()
      }}
      className="mx-2 my-1 h-6 w-[calc(100%-16px)] rounded-md border border-[var(--color-accent)] bg-[var(--color-bg)] px-2 text-[11px] text-[var(--color-text)] outline-none"
    />
  )
}

function Header({ title, onAdd, addTitle }: { title: string; onAdd?: () => void; addTitle?: string }) {
  return (
    <div className="flex items-center justify-between px-3 py-1.5">
      <span className="text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-dim)]">{title}</span>
      {onAdd && (
        <button
          type="button"
          title={addTitle}
          onClick={onAdd}
          className="flex h-5 w-5 items-center justify-center rounded text-[var(--color-text-dim)] transition hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text)]"
        >
          <Icon as={Plus} size={12} />
        </button>
      )}
    </div>
  )
}

const PRESET_GROUPS = groupPresets()

const rowClass = (active: boolean) =>
  `group flex w-full items-center gap-2 px-3 py-1 text-left text-[11px] transition ${
    active
      ? `bg-[var(--color-surface-2)] text-[var(--color-text)] ${activeMarker}`
      : 'text-[var(--color-text-dim)] hover:bg-[var(--color-surface-2)]/60 hover:text-[var(--color-text)]'
  }`

export function DocsPanel() {
  const docs = useDesignStore((s) => s.docs)
  const docId = useDesignStore((s) => s.docId)
  const doc = useDesignStore((s) => s.doc)
  const pageId = useDesignStore((s) => s.pageId)
  const artboards = useDesignStore((s) => s.artboards)
  const selectedArtboard = useDesignStore((s) => s.selection.artboardId)
  const openDoc = useDesignStore((s) => s.openDoc)
  const createDoc = useDesignStore((s) => s.createDoc)
  const renameDoc = useDesignStore((s) => s.renameDoc)
  const archiveDoc = useDesignStore((s) => s.archiveDoc)
  const loadDocs = useDesignStore((s) => s.loadDocs)
  const selectPage = useDesignStore((s) => s.selectPage)
  const createPage = useDesignStore((s) => s.createPage)
  const createArtboard = useDesignStore((s) => s.createArtboard)
  const duplicateArtboard = useDesignStore((s) => s.duplicateArtboard)
  const requestDeleteArtboard = useDesignStore((s) => s.requestDeleteArtboard)
  const updateArtboardMeta = useDesignStore((s) => s.updateArtboardMeta)
  const select = useDesignStore((s) => s.select)
  const fitToArtboard = useDesignStore((s) => s.fitToArtboard)

  const [creating, setCreating] = useState(false)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [menuFor, setMenuFor] = useState<string | null>(null)
  const [presetsOpen, setPresetsOpen] = useState(false)
  const [customOpen, setCustomOpen] = useState(false)
  const [artboardMenuFor, setArtboardMenuFor] = useState<string | null>(null)
  const [renamingArtboard, setRenamingArtboard] = useState<string | null>(null)

  const presetSections = [
    ...PRESET_GROUPS.map((g) => ({
      title: g.label,
      items: g.presets.map((p) => ({
        label: `${p.label} · ${formatPresetSize(p)}`,
        onClick: () => void createArtboard(p),
      })),
    })),
    {
      title: 'Outro',
      items: [{ label: 'Personalizado…', onClick: () => setCustomOpen(true) }],
    },
  ]

  const pageArtboards = Object.values(artboards)
    .map((a) => a.meta)
    .filter((m) => m.pageId === pageId)
    .sort((a, b) => a.position - b.position)

  async function rename(id: string, title: string): Promise<void> {
    setRenaming(null)
    if (id === docId) await renameDoc(title)
    else {
      await api.design.documentUpdate({ id, title })
      await loadDocs()
    }
  }

  return (
    <div className="flex flex-col border-b border-[var(--color-border)]">
      <Header title="Documentos" onAdd={() => setCreating(true)} addTitle="Novo documento" />
      {creating && (
        <InlineInput
          placeholder="Nome do documento"
          onSubmit={(title) => {
            setCreating(false)
            void createDoc(title)
          }}
          onCancel={() => setCreating(false)}
        />
      )}
      <ul className="max-h-48 overflow-y-auto">
        {docs.length === 0 && !creating && (
          <li className="px-3 py-2 text-[11px] text-[var(--color-text-dim)]">Nenhum documento ainda.</li>
        )}
        {docs.map((d) =>
          renaming === d.id ? (
            <li key={d.id}>
              <InlineInput
                placeholder="Nome"
                initial={d.title}
                onSubmit={(t) => void rename(d.id, t)}
                onCancel={() => setRenaming(null)}
              />
            </li>
          ) : (
            <li key={d.id} className={rowClass(d.id === docId)}>
              <button type="button" onClick={() => void openDoc(d.id)} className="flex min-w-0 flex-1 items-center gap-2">
                <Icon as={FileText} size={12} className="shrink-0 opacity-70" />
                <span className="truncate">{d.title}</span>
              </button>
              <Menu
                open={menuFor === d.id}
                onClose={() => setMenuFor(null)}
                portal
                items={[
                  { label: 'Renomear', onClick: () => setRenaming(d.id) },
                  { label: 'Arquivar', onClick: () => void archiveDoc(d.id), danger: true },
                ]}
              >
                <button
                  type="button"
                  title="Opções"
                  onClick={() => setMenuFor(menuFor === d.id ? null : d.id)}
                  className="flex h-5 w-5 items-center justify-center rounded opacity-0 transition group-hover:opacity-100 hover:bg-[var(--color-surface-2)]"
                >
                  <Icon as={MoreHorizontal} size={12} />
                </button>
              </Menu>
            </li>
          ),
        )}
      </ul>

      {doc && (
        <>
          <Header title="Páginas" onAdd={() => void createPage(`Página ${doc.pages.length + 1}`)} addTitle="Nova página" />
          <ul>
            {doc.pages.map((p) => (
              <li key={p.id}>
                <button type="button" onClick={() => selectPage(p.id)} className={rowClass(p.id === pageId)}>
                  <span className="truncate">{p.name}</span>
                </button>
              </li>
            ))}
          </ul>

          <div className="flex items-center justify-between px-3 py-1.5">
            <span className="text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-dim)]">Artboards</span>
            <Menu
              open={presetsOpen}
              onClose={() => setPresetsOpen(false)}
              portal
              sections={presetSections}
            >
              <button
                type="button"
                title="Novo artboard"
                onClick={() => setPresetsOpen((o) => !o)}
                className="flex h-5 items-center gap-0.5 rounded px-1 text-[11px] text-[var(--color-text-dim)] transition hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text)]"
              >
                <Icon as={Plus} size={12} /> Artboard
              </button>
            </Menu>
          </div>
          <ul className="max-h-40 overflow-y-auto">
            {pageArtboards.length === 0 && (
              <li className="px-3 py-1 text-[11px] text-[var(--color-text-dim)]">Nenhum artboard. Crie um acima.</li>
            )}
            {pageArtboards.map((m) =>
              renamingArtboard === m.id ? (
                <li key={m.id}>
                  <InlineInput
                    placeholder="Nome"
                    initial={m.name}
                    onSubmit={(name) => {
                      setRenamingArtboard(null)
                      updateArtboardMeta(m.id, { name })
                    }}
                    onCancel={() => setRenamingArtboard(null)}
                  />
                </li>
              ) : (
                <li key={m.id} className={rowClass(m.id === selectedArtboard)}>
                  <button
                    type="button"
                    onClick={() => {
                      select(m.id, [])
                      fitToArtboard(m.id)
                    }}
                    className="flex min-w-0 flex-1 items-center gap-2"
                  >
                    <Icon as={LayoutTemplate} size={12} className="shrink-0 opacity-70" />
                    <span className="truncate">{m.name}</span>
                    <span className="ml-auto tabular-nums text-[10px] opacity-60">
                      {formatArtboardSize(m)}
                    </span>
                  </button>
                  <Menu
                    open={artboardMenuFor === m.id}
                    onClose={() => setArtboardMenuFor(null)}
                    portal
                    items={[
                      { label: 'Renomear', onClick: () => setRenamingArtboard(m.id) },
                      { label: 'Duplicar', onClick: () => void duplicateArtboard(m.id) },
                      {
                        label: 'Excluir',
                        onClick: () => requestDeleteArtboard(m.id),
                        danger: true,
                      },
                    ]}
                  >
                    <button
                      type="button"
                      title="Opções"
                      onClick={() => setArtboardMenuFor(artboardMenuFor === m.id ? null : m.id)}
                      className="flex h-5 w-5 items-center justify-center rounded opacity-0 transition group-hover:opacity-100 hover:bg-[var(--color-surface-2)]"
                    >
                      <Icon as={MoreHorizontal} size={12} />
                    </button>
                  </Menu>
                </li>
              ),
            )}
          </ul>

          {customOpen && (
            <ArtboardSizeDialog
              title="Novo artboard"
              initial={{ width: 1440, height: 900 }}
              onClose={() => setCustomOpen(false)}
              onSubmit={(width, height) => void createArtboard(customPreset(width, height))}
            />
          )}
        </>
      )}
    </div>
  )
}
