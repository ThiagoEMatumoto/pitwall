import { useCallback, useEffect, useState } from 'react'
import { Check, ExternalLink } from 'lucide-react'
import type { DiagramLibraryItem } from '../../../shared/types/ipc'
import {
  DIAGRAM_LIBRARY_CATALOG_PAGE,
  DIAGRAM_LIBRARY_CATEGORY_LABELS,
  type DiagramLibraryCatalogEntry,
  type DiagramLibraryCategory,
} from '../../../shared/diagram-library-catalog'
import { diagramsApi } from '@/lib/ipc'
import { showToast } from '@/features/notifications/toast-store'
import { Button } from '@/components/ui/Button'
import { Dialog } from '@/components/ui/Dialog'
import { Icon } from '@/components/ui/Icon'

const CATEGORY_ORDER: DiagramLibraryCategory[] = ['cloud', 'uml-er', 'flow', 'architecture']

// Estado por entrada só para o que é transitório; "instalada" vem do main
// (derivado da biblioteca), então sobrevive a install feito pelo MCP.
type Pending = { kind: 'installing' | 'removing' } | { kind: 'error'; message: string }

interface Props {
  open: boolean
  onClose: () => void
  // O editor aplica a biblioteca nova (updateLibrary) — o dialog não conhece o Excalidraw.
  onLibraryChanged: (items: DiagramLibraryItem[]) => void
}

function openCatalogPage() {
  // O main abre https em browser externo (setWindowOpenHandler).
  window.open(DIAGRAM_LIBRARY_CATALOG_PAGE)
}

export function LibraryCatalogDialog({ open, onClose, onLibraryChanged }: Props) {
  const [entries, setEntries] = useState<DiagramLibraryCatalogEntry[] | null>(null)
  const [installed, setInstalled] = useState<Set<string>>(new Set())
  const [loadError, setLoadError] = useState<string | null>(null)
  const [pending, setPending] = useState<Record<string, Pending>>({})

  const refresh = useCallback(async () => {
    try {
      const state = await diagramsApi.library.catalog()
      setEntries(state.entries)
      setInstalled(new Set(state.installedIds))
      setLoadError(null)
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  useEffect(() => {
    if (!open) return
    void refresh()
    return diagramsApi.library.onUpdated(() => void refresh())
  }, [open, refresh])

  const setEntryPending = (id: string, value: Pending | null) =>
    setPending((prev) => {
      const { [id]: _drop, ...rest } = prev
      return value ? { ...rest, [id]: value } : rest
    })

  const install = async (entry: DiagramLibraryCatalogEntry) => {
    setEntryPending(entry.id, { kind: 'installing' })
    try {
      const { added, items } = await diagramsApi.library.installCatalog(entry.id)
      setInstalled((prev) => new Set(prev).add(entry.id))
      setEntryPending(entry.id, null)
      onLibraryChanged(items)
      showToast({ title: `${entry.name}: ${added} shapes adicionados`, durationMs: 2500 })
    } catch (err) {
      setEntryPending(entry.id, {
        kind: 'error',
        message: err instanceof Error ? err.message : String(err),
      })
    }
  }

  const remove = async (entry: DiagramLibraryCatalogEntry) => {
    setEntryPending(entry.id, { kind: 'removing' })
    try {
      const items = await diagramsApi.library.removeCatalog(entry.id)
      setInstalled((prev) => {
        const next = new Set(prev)
        next.delete(entry.id)
        return next
      })
      setEntryPending(entry.id, null)
      onLibraryChanged(items)
    } catch (err) {
      setEntryPending(entry.id, {
        kind: 'error',
        message: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Catálogo de bibliotecas"
      widthClassName="w-[40rem]"
      footer={
        <button
          type="button"
          onClick={openCatalogPage}
          className="mr-auto inline-flex items-center gap-1 text-xs text-[var(--color-text-dim)] transition hover:text-[var(--color-text)]"
        >
          Mais bibliotecas em libraries.excalidraw.com
          <Icon as={ExternalLink} size={12} />
        </button>
      }
    >
      <p className="mb-5 text-[13px] text-[var(--color-text-dim)]">
        Shapes prontos do repositório oficial do Excalidraw (licença MIT). A instalação baixa o
        arquivo na hora e vale para todos os diagramas.
      </p>

      {loadError && (
        <p role="alert" className="text-sm text-[var(--color-danger)]">
          Não deu para carregar o catálogo: {loadError}
        </p>
      )}

      {!entries && !loadError && (
        <div aria-busy="true" aria-label="Carregando catálogo" className="flex flex-col gap-2">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-14 animate-pulse rounded-lg bg-[var(--color-surface-2)]" />
          ))}
        </div>
      )}

      {entries && (
        <div className="flex flex-col gap-6">
          {CATEGORY_ORDER.map((category) => {
            const group = entries.filter((e) => e.category === category)
            if (group.length === 0) return null
            return (
              <section key={category} aria-label={DIAGRAM_LIBRARY_CATEGORY_LABELS[category]}>
                <h3 className="mb-2 text-sm font-semibold text-[var(--color-text)]">
                  {DIAGRAM_LIBRARY_CATEGORY_LABELS[category]}
                </h3>
                <ul className="divide-y divide-[var(--color-border)] rounded-lg border border-[var(--color-border)]">
                  {group.map((entry) => (
                    <CatalogRow
                      key={entry.id}
                      entry={entry}
                      installed={installed.has(entry.id)}
                      pending={pending[entry.id]}
                      onInstall={() => void install(entry)}
                      onRemove={() => void remove(entry)}
                    />
                  ))}
                </ul>
              </section>
            )
          })}
        </div>
      )}
    </Dialog>
  )
}

interface RowProps {
  entry: DiagramLibraryCatalogEntry
  installed: boolean
  pending: Pending | undefined
  onInstall: () => void
  onRemove: () => void
}

function CatalogRow({ entry, installed, pending, onInstall, onRemove }: RowProps) {
  const busy = pending?.kind === 'installing' || pending?.kind === 'removing'
  const error = pending?.kind === 'error' ? pending.message : null

  return (
    <li className="flex flex-col gap-2 px-3 py-2.5" data-testid={`catalog-entry-${entry.id}`}>
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-[var(--color-text)]">{entry.name}</div>
          <div className="truncate text-xs text-[var(--color-text-dim)]">{entry.description}</div>
        </div>
        {installed && !busy ? (
          <div className="flex shrink-0 items-center gap-2">
            <span className="inline-flex items-center gap-1 text-xs font-medium text-[var(--color-accent)]">
              <Icon as={Check} size={14} />
              Instalada
            </span>
            <Button
              variant="danger"
              className="px-3 py-1 text-xs"
              onClick={onRemove}
              aria-label={`Remover ${entry.name}`}
            >
              Remover
            </Button>
          </div>
        ) : (
          <Button
            variant="ghost"
            className="px-3 py-1 shrink-0 text-xs"
            loading={busy}
            onClick={onInstall}
            aria-label={`Instalar ${entry.name}`}
          >
            {pending?.kind === 'installing'
              ? 'Instalando…'
              : pending?.kind === 'removing'
                ? 'Removendo…'
                : error
                  ? 'Tentar de novo'
                  : 'Instalar'}
          </Button>
        )}
      </div>
      {error && (
        <div role="alert" className="flex flex-wrap items-baseline gap-x-2 text-xs">
          <span className="text-[var(--color-danger)]">{error}</span>
          <button
            type="button"
            onClick={openCatalogPage}
            className="text-[var(--color-text-dim)] underline underline-offset-2 transition hover:text-[var(--color-text)]"
          >
            Abrir no catálogo
          </button>
        </div>
      )}
    </li>
  )
}
