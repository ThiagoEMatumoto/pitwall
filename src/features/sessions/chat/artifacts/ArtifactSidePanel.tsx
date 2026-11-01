import { useCallback, useEffect, useRef, type KeyboardEvent, type PointerEvent } from 'react'
import { ArrowUpRight, X } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import { DesignPreview, DiagramPreview } from './ArtifactPreview'
import { EditingLabel, KIND_ICON, KIND_LABEL, openArtifactInEditor } from './ArtifactCard'
import { CHAT_MIN_WIDTH, PANEL_MIN_WIDTH, useArtifactPanelStore } from './artifactPanelStore'
import { useArtifactLive } from './useArtifactLive'
import type { ArtifactRef } from './artifact-refs'

const KEY_STEP_PX = 24

// Painel à direita do chat com o artefato ao vivo. Mora dentro da área da
// sessão (não troca a Area): a conversa continua ao lado e cada escrita do
// Claude redesenha o preview.
export function ArtifactSidePanel({ sessionId }: { sessionId: string }) {
  const entry = useArtifactPanelStore((s) => s.sessions[sessionId])
  if (!entry?.open) return null
  return (
    <OpenPanel
      key={`${entry.ref.kind}:${entry.ref.id}`}
      sessionId={sessionId}
      artifact={entry.ref}
    />
  )
}

function OpenPanel({ sessionId, artifact }: { sessionId: string; artifact: ArtifactRef }) {
  const width = useArtifactPanelStore((s) => s.width)
  const setWidth = useArtifactPanelStore((s) => s.setWidth)
  const close = useArtifactPanelStore((s) => s.close)
  const live = useArtifactLive(artifact)
  const asideRef = useRef<HTMLElement>(null)
  const drag = useRef<{ startX: number; startW: number } | null>(null)

  // O painel nunca come a conversa: limita pela largura do contêiner.
  const clamp = useCallback((w: number) => {
    const host = asideRef.current?.parentElement?.clientWidth ?? Infinity
    return Math.max(PANEL_MIN_WIDTH, Math.min(w, host - CHAT_MIN_WIDTH))
  }, [])

  useEffect(() => {
    const host = asideRef.current?.parentElement
    if (!host || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => {
      const w = asideRef.current?.offsetWidth ?? 0
      if (w > 0 && clamp(w) !== w && asideRef.current)
        asideRef.current.style.width = `${clamp(w)}px`
    })
    ro.observe(host)
    return () => ro.disconnect()
  }, [clamp])

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { startX: e.clientX, startW: asideRef.current?.offsetWidth ?? width }
  }
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag.current || !asideRef.current) return
    asideRef.current.style.width = `${clamp(drag.current.startW + drag.current.startX - e.clientX)}px`
  }
  const onPointerUp = () => {
    if (!drag.current) return
    drag.current = null
    setWidth(asideRef.current?.offsetWidth ?? width)
  }
  const onHandleKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    e.preventDefault()
    setWidth(clamp(width + (e.key === 'ArrowLeft' ? KEY_STEP_PX : -KEY_STEP_PX)))
  }
  const onPanelKey = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      close(sessionId)
    }
  }

  const title = live.title ?? (live.status === 'loading' ? 'Carregando…' : 'Sem título')

  return (
    <aside
      ref={asideRef}
      aria-label={`${KIND_LABEL[artifact.kind]}: ${title}`}
      onKeyDown={onPanelKey}
      style={{ width: clamp(width) }}
      className="relative flex h-full shrink-0 flex-col border-l border-[var(--color-border)] bg-[var(--color-bg)] pw-panel-in"
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Redimensionar painel"
        aria-valuenow={Math.round(width)}
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onKeyDown={onHandleKey}
        className="absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize after:absolute after:inset-y-0 after:left-1/2 after:w-px after:bg-transparent hover:after:bg-[var(--color-accent)]/60 focus-visible:outline-none focus-visible:after:bg-[var(--color-accent)]"
      />
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-[var(--color-border)] px-3">
        <Icon
          as={KIND_ICON[artifact.kind]}
          size={14}
          className="shrink-0 text-[var(--color-text-dim)]"
        />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-[var(--color-text)]" title={title}>
            {title}
          </div>
          {live.editing && (
            <div className="text-[11px]">
              <EditingLabel />
            </div>
          )}
        </div>
        <button
          type="button"
          disabled={live.status === 'missing'}
          onClick={() => openArtifactInEditor(artifact)}
          className="flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-[var(--color-text)] hover:bg-[var(--color-surface-2)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] disabled:opacity-40"
        >
          Abrir no editor
          <Icon as={ArrowUpRight} size={13} />
        </button>
        <button
          type="button"
          onClick={() => close(sessionId)}
          aria-label="Fechar painel"
          title="Fechar (Esc)"
          className="shrink-0 rounded-md p-1 text-[var(--color-text-dim)] hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
        >
          <Icon as={X} size={14} />
        </button>
      </header>
      <div className="min-h-0 flex-1 bg-[var(--color-surface)]">
        {live.status === 'missing' ? (
          <p className="flex h-full items-center justify-center px-6 text-center text-sm text-[var(--color-text-dim)]">
            Este {KIND_LABEL[artifact.kind].toLowerCase()} foi removido.
          </p>
        ) : artifact.kind === 'diagram' ? (
          <DiagramPreview id={artifact.id} live={live} />
        ) : (
          <DesignPreview docId={artifact.id} live={live} />
        )}
      </div>
    </aside>
  )
}
