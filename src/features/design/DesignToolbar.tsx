import { useEffect, useState, type ComponentType } from 'react'
import type { LucideProps } from 'lucide-react'
import {
  Circle,
  Focus,
  Frame,
  Hand,
  Image,
  Keyboard,
  Maximize2,
  Minus,
  MousePointer2,
  MousePointerClick,
  Play,
  Plus,
  Sparkles,
  Square,
  Type,
  X,
} from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import { Button } from '@/components/ui/Button'
import { useDesignStore, type DesignTool } from '@/store/designStore'
import { DESIGN_TESTIDS } from '@shared/types/design'
import { AgentActivityBadge } from './AgentActivityBadge'
import { DocumentExportMenu } from './DocumentExportMenu'
import { STAGE_MAX_ZOOM, STAGE_MIN_ZOOM, clampStageZoom } from './canvas/CanvasStage'
import { SHORTCUTS_PANEL_TOGGLE_EVENT } from './canvas/useCanvasShortcuts'
import { VersionsButton } from './versions/VersionsPanel'

interface ToolDef {
  id: DesignTool
  label: string
  shortcut: string
  icon: ComponentType<LucideProps>
}

const TOOLS: ToolDef[] = [
  { id: 'move', label: 'Mover', shortcut: 'V', icon: MousePointer2 },
  { id: 'hand', label: 'Mão', shortcut: 'H', icon: Hand },
  { id: 'frame', label: 'Frame', shortcut: 'F', icon: Frame },
  { id: 'rect', label: 'Retângulo', shortcut: 'R', icon: Square },
  { id: 'ellipse', label: 'Elipse', shortcut: 'O', icon: Circle },
  { id: 'text', label: 'Texto', shortcut: 'T', icon: Type },
  { id: 'image', label: 'Imagem', shortcut: '', icon: Image },
]

const ZOOM_STEP = 1.25

const iconButton =
  'flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition disabled:opacity-40 hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text)]'

function DocTitle() {
  const title = useDesignStore((s) => s.doc?.title ?? '')
  const renameDoc = useDesignStore((s) => s.renameDoc)
  const [draft, setDraft] = useState(title)
  const [editing, setEditing] = useState(false)

  useEffect(() => {
    if (!editing) setDraft(title)
  }, [title, editing])

  const commit = (): void => {
    setEditing(false)
    const next = draft.trim()
    if (next && next !== title) void renameDoc(next)
    else setDraft(title)
  }

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        title="Renomear documento"
        className="max-w-full truncate rounded-md px-2 py-1 text-sm font-medium text-[var(--color-text)] transition hover:bg-[var(--color-surface-2)]"
      >
        {title || 'Sem título'}
      </button>
    )
  }
  return (
    <input
      autoFocus
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit()
        if (e.key === 'Escape') {
          setDraft(title)
          setEditing(false)
        }
      }}
      className="w-full max-w-sm rounded-md border border-[var(--color-accent)] bg-[var(--color-bg)] px-2 py-1 text-sm text-[var(--color-text)] outline-none"
    />
  )
}

export function DesignToolbar() {
  const tool = useDesignStore((s) => s.tool)
  const setTool = useDesignStore((s) => s.setTool)
  const zoom = useDesignStore((s) => s.viewport.zoom)
  const zoomTo = useDesignStore((s) => s.zoomTo)
  const fitToContent = useDesignStore((s) => s.fitToContent)
  const fitToSelection = useDesignStore((s) => s.fitToSelection)
  const hasSelection = useDesignStore((s) => s.selection.artboardId !== null)
  const mode = useDesignStore((s) => s.mode)
  const startPreview = useDesignStore((s) => s.startPreview)
  const exitPreview = useDesignStore((s) => s.exitPreview)
  const interaction = useDesignStore((s) => s.interaction)
  const setInteraction = useDesignStore((s) => s.setInteraction)
  const setAskOpen = useDesignStore((s) => s.setAskOpen)
  const hasDoc = useDesignStore((s) => s.docId !== null)
  const previewTarget = useDesignStore(
    (s) =>
      s.selection.artboardId ??
      s.doc?.pages.find((p) => p.id === s.pageId)?.artboards[0]?.id ??
      null,
  )

  const inPreview = mode === 'preview'

  return (
    // @container: below 64rem the action labels give way to their icons, so
    // Interagir/Preview stay reachable on a laptop with both side panels open.
    <div className="@container flex h-11 shrink-0 items-center gap-2 border-b border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-[var(--color-text-dim)]">
      <div className="flex items-center gap-0.5">
        {TOOLS.map((t) => (
          <button
            key={t.id}
            type="button"
            disabled={!hasDoc || inPreview}
            onClick={() => setTool(t.id)}
            title={t.shortcut ? `${t.label} (${t.shortcut})` : t.label}
            aria-pressed={tool === t.id}
            className={`${iconButton} ${
              tool === t.id ? 'bg-[var(--color-surface-2)] text-[var(--color-accent)]' : ''
            }`}
          >
            <Icon as={t.icon} />
          </button>
        ))}
      </div>

      <span className="mx-1 h-5 w-px bg-[var(--color-border)]" />

      <div className="flex items-center gap-0.5">
        <button
          type="button"
          disabled={!hasDoc || zoom <= STAGE_MIN_ZOOM}
          onClick={() => zoomTo(clampStageZoom(zoom / ZOOM_STEP))}
          title="Diminuir zoom (Ctrl+−)"
          className={iconButton}
        >
          <Icon as={Minus} />
        </button>
        <button
          type="button"
          disabled={!hasDoc}
          onClick={() => void fitToSelection(1)}
          title="Zoom 100% na seleção (Ctrl+1)"
          className="min-w-[3.5rem] rounded-md px-1.5 py-1 text-center text-xs tabular-nums transition hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text)] disabled:opacity-40"
        >
          {Math.round(zoom * 100)}%
        </button>
        <button
          type="button"
          disabled={!hasDoc || zoom >= STAGE_MAX_ZOOM}
          onClick={() => zoomTo(clampStageZoom(zoom * ZOOM_STEP))}
          title="Aumentar zoom (Ctrl++)"
          className={iconButton}
        >
          <Icon as={Plus} />
        </button>
        <button
          type="button"
          disabled={!hasDoc}
          onClick={fitToContent}
          title="Ajustar à tela (Ctrl+0)"
          className={iconButton}
        >
          <Icon as={Maximize2} />
        </button>
        <button
          type="button"
          disabled={!hasDoc || !hasSelection}
          onClick={() => void fitToSelection()}
          title="Enquadrar seleção (Shift+2)"
          className={iconButton}
        >
          <Icon as={Focus} />
        </button>
      </div>

      <span className="mx-1 h-5 w-px bg-[var(--color-border)]" />

      {/* The title owns the slack and is the only thing that truncates; the
          agent badge and the actions on the right never get squeezed. */}
      <div className="flex min-w-[10rem] flex-1 items-center">{hasDoc && <DocTitle />}</div>

      <div className="min-w-0 shrink">
        <AgentActivityBadge />
      </div>

      {hasDoc && (
        <Button
          variant="ghost"
          className="shrink-0 px-3 py-1 text-xs"
          title="Ask Claude (/)"
          onClick={() => setAskOpen(true)}
        >
          <Icon as={Sparkles} size={13} />
          <span className="hidden @5xl:inline">Ask Claude</span>
        </Button>
      )}

      {hasDoc && (
        <button
          type="button"
          onClick={() => window.dispatchEvent(new CustomEvent(SHORTCUTS_PANEL_TOGGLE_EVENT))}
          title="Atalhos do teclado (Ctrl+Shift+?)"
          className={iconButton}
        >
          <Icon as={Keyboard} />
        </button>
      )}

      {hasDoc && <DocumentExportMenu />}

      {hasDoc && <VersionsButton />}

      <button
        type="button"
        data-testid="design-interact"
        disabled={!hasDoc || inPreview}
        aria-pressed={interaction}
        onClick={() => setInteraction(!interaction)}
        title={
          interaction
            ? 'Sair do modo interagir (Esc)'
            : 'Interagir: clicar, passar o mouse e ver as animações no canvas'
        }
        className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1 text-xs transition disabled:opacity-40 ${
          interaction
            ? 'border-[var(--color-accent)] bg-[color-mix(in_srgb,var(--color-accent)_16%,transparent)] text-[var(--color-accent)]'
            : 'border-[var(--color-border)] hover:border-[var(--color-accent)]/60 hover:text-[var(--color-text)]'
        }`}
      >
        <Icon as={MousePointerClick} size={13} />
        <span className="hidden @5xl:inline">Interagir</span>
      </button>

      <button
        type="button"
        data-testid={DESIGN_TESTIDS.previewButton}
        disabled={!hasDoc || (!inPreview && !previewTarget)}
        onClick={() => (inPreview ? exitPreview() : previewTarget && startPreview(previewTarget))}
        title={inPreview ? 'Sair do preview (Esc)' : 'Abrir o preview do artboard selecionado'}
        className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1 text-xs transition disabled:opacity-40 ${
          inPreview
            ? 'border-[var(--color-accent)] bg-[color-mix(in_srgb,var(--color-accent)_16%,transparent)] text-[var(--color-accent)]'
            : 'border-[var(--color-border)] hover:border-[var(--color-accent)]/60 hover:text-[var(--color-text)]'
        }`}
      >
        <Icon as={inPreview ? X : Play} size={13} />
        <span className="hidden @5xl:inline">{inPreview ? 'Sair' : 'Preview'}</span>
      </button>
    </div>
  )
}
