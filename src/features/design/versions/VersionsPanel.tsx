// Version history of one artboard. VersionsButton is the toolbar entry
// (opens the panel in a Dialog); VersionsPanel is the list itself.

import { useCallback, useEffect, useState } from 'react'
import { History, RotateCcw, Sparkles, User } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Dialog } from '@/components/ui/Dialog'
import { Icon } from '@/components/ui/Icon'
import { api } from '@/lib/ipc'
import { relativeTime } from '@/lib/time'
import { showToast } from '@/features/notifications/toast-store'
import { useDesignStore } from '@/store/designStore'
import type { DesignVersionMeta } from '@shared/types/design'

export const VERSIONS_TESTIDS = {
  button: 'design-versions-button',
  row: 'data-version',
} as const

interface PanelProps {
  artboardId: string
  onRestored?: () => void
}

export function VersionsPanel({ artboardId, onRestored }: PanelProps) {
  const currentVersion = useDesignStore((s) => s.artboards[artboardId]?.version ?? 0)
  const resync = useDesignStore((s) => s.resync)
  const [versions, setVersions] = useState<DesignVersionMeta[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<number | null>(null)
  const [busy, setBusy] = useState<number | null>(null)

  const load = useCallback(async () => {
    try {
      const list = await api.design.versionsList(artboardId)
      setVersions([...list].sort((a, b) => b.version - a.version))
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [artboardId])

  // currentVersion in the deps: every commit (mine or Claude's) refreshes.
  useEffect(() => {
    void load()
  }, [load, currentVersion])

  async function restore(version: number): Promise<void> {
    setBusy(version)
    try {
      await api.design.versionRestore(artboardId, version)
      await resync(artboardId)
      showToast({
        title: `Versão ${version} restaurada`,
        body: 'Restaurar cria uma versão nova; nada foi apagado.',
      })
      onRestored?.()
    } catch (err) {
      showToast({
        title: 'Não foi possível restaurar',
        body: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setBusy(null)
      setConfirming(null)
    }
  }

  if (error)
    return <p className="text-xs text-[var(--color-danger)]">Falha ao carregar versões: {error}</p>
  if (!versions) return <p className="text-xs text-[var(--color-text-dim)]">Carregando…</p>
  if (versions.length === 0) {
    return <p className="text-xs text-[var(--color-text-dim)]">Nenhuma versão salva ainda.</p>
  }

  return (
    <ul className="flex flex-col divide-y divide-[var(--color-border)]">
      {versions.map((v) => {
        const isCurrent = v.version === currentVersion
        const AuthorIcon = v.author === 'claude' ? Sparkles : User
        return (
          <li
            key={v.id}
            {...{ [VERSIONS_TESTIDS.row]: v.version }}
            className="flex items-center gap-3 py-2"
          >
            <span
              className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-[var(--color-border)] ${
                v.author === 'claude'
                  ? 'text-[var(--color-accent)]'
                  : 'text-[var(--color-text-dim)]'
              }`}
              title={v.author === 'claude' ? 'Claude' : 'Você'}
            >
              <Icon as={AuthorIcon} size={14} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 text-sm text-[var(--color-text)]">
                <span className="tabular-nums text-[var(--color-text-dim)]">v{v.version}</span>
                <span className="truncate">{v.summary || 'Sem descrição'}</span>
                {isCurrent && (
                  <span className="shrink-0 rounded-full border border-[var(--color-accent)]/60 px-1.5 text-[10px] uppercase tracking-wider text-[var(--color-accent)]">
                    atual
                  </span>
                )}
              </div>
              <div className="text-[11px] text-[var(--color-text-dim)]">
                {relativeTime(v.createdAt)}
              </div>
            </div>
            {!isCurrent &&
              (confirming === v.version ? (
                <div className="flex items-center gap-1">
                  <Button
                    variant="primary"
                    className="px-3 py-0.5 text-xs"
                    loading={busy === v.version}
                    onClick={() => void restore(v.version)}
                  >
                    Restaurar
                  </Button>
                  <Button
                    variant="ghost"
                    className="px-3 py-0.5 text-xs"
                    onClick={() => setConfirming(null)}
                  >
                    Cancelar
                  </Button>
                </div>
              ) : (
                <Button
                  variant="ghost"
                  className="px-3 py-0.5 text-xs"
                  disabled={busy != null}
                  onClick={() => setConfirming(v.version)}
                  title="Restaurar esta versão"
                >
                  <Icon as={RotateCcw} size={13} />
                  Restaurar
                </Button>
              ))}
          </li>
        )
      })}
    </ul>
  )
}

// Toolbar entry. Mount next to the Preview button in DesignToolbar.
export function VersionsButton() {
  const artboardId = useDesignStore((s) => s.selection.artboardId)
  const name = useDesignStore((s) => (artboardId ? s.artboards[artboardId]?.meta.name : undefined))
  const [open, setOpen] = useState(false)

  return (
    <>
      <button
        type="button"
        data-testid={VERSIONS_TESTIDS.button}
        disabled={!artboardId}
        onClick={() => setOpen(true)}
        title={artboardId ? 'Histórico de versões' : 'Selecione um artboard para ver o histórico'}
        className="flex h-7 w-7 items-center justify-center rounded-md transition hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text)] disabled:opacity-40"
      >
        <Icon as={History} />
      </button>
      {artboardId && (
        <Dialog
          open={open}
          onClose={() => setOpen(false)}
          title={`Histórico — ${name ?? 'artboard'}`}
        >
          <VersionsPanel artboardId={artboardId} />
        </Dialog>
      )}
    </>
  )
}
