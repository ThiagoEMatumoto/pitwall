import { useEffect, useState, type ComponentType } from 'react'
import type { LucideProps } from 'lucide-react'
import {
  Circle,
  Frame,
  Hand,
  Image,
  Maximize2,
  Minus,
  MousePointer2,
  Play,
  Plus,
  Sparkles,
  Square,
  Type,
  X,
} from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import { Button } from '@/components/ui/Button'
import { ControlPill } from '@/features/brand'
import { useDesignStore, type DesignTool } from '@/store/designStore'
import { DESIGN_TESTIDS } from '@shared/types/design'
import { STAGE_MAX_ZOOM, STAGE_MIN_ZOOM, clampStageZoom } from './canvas/CanvasStage'

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
  'flex h-7 w-7 items-center justify-center rounded-md transition disabled:opacity-40 hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text)]'

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
        className="max-w-[16rem] truncate rounded-md px-2 py-1 text-sm font-medium text-[var(--color-text)] transition hover:bg-[var(--color-surface-2)]"
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
      className="w-56 rounded-md border border-[var(--color-accent)] bg-[var(--color-bg)] px-2 py-1 text-sm text-[var(--color-text)] outline-none"
    />
  )
}

function AgentBadge() {
  const activity = useDesignStore((s) => s.agentActivity)
  const artboards = useDesignStore((s) => s.artboards)
  const entries = Object.values(activity).flat()
  if (entries.length === 0) return null
  const latest = entries.reduce((a, b) => (b.at > a.at ? b : a))
  const target = latest.artboardId ? (artboards[latest.artboardId]?.meta.name ?? 'artboard') : 'documento'
  return (
    <>
      <style>{`
        @keyframes pw-design-shimmer { from { background-position: 200% 0 } to { background-position: -200% 0 } }
        .pw-design-shimmer {
          background: linear-gradient(90deg, transparent 0%, color-mix(in srgb, var(--color-accent) 22%, transparent) 50%, transparent 100%);
          background-size: 200% 100%;
          animation: pw-design-shimmer 1.6s linear infinite;
        }
      `}</style>
      <ControlPill
        icon={Sparkles}
        tone="accent"
        label={`Claude editando ▸ ${target}`}
        title={latest.summary ?? latest.tool}
        className="pw-design-shimmer"
      />
    </>
  )
}

export function DesignToolbar() {
  const tool = useDesignStore((s) => s.tool)
  const setTool = useDesignStore((s) => s.setTool)
  const zoom = useDesignStore((s) => s.viewport.zoom)
  const zoomTo = useDesignStore((s) => s.zoomTo)
  const fitToContent = useDesignStore((s) => s.fitToContent)
  const mode = useDesignStore((s) => s.mode)
  const startPreview = useDesignStore((s) => s.startPreview)
  const exitPreview = useDesignStore((s) => s.exitPreview)
  const setAskOpen = useDesignStore((s) => s.setAskOpen)
  const hasDoc = useDesignStore((s) => s.docId !== null)
  const previewTarget = useDesignStore(
    (s) => s.selection.artboardId ?? s.doc?.pages.find((p) => p.id === s.pageId)?.artboards[0]?.id ?? null,
  )

  const inPreview = mode === 'preview'

  return (
    <div className="flex h-11 shrink-0 items-center gap-2 border-b border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-[var(--color-text-dim)]">
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
          onClick={() => zoomTo(1)}
          title="Zoom 100% (Ctrl+1)"
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
      </div>

      <span className="mx-1 h-5 w-px bg-[var(--color-border)]" />

      {hasDoc && <DocTitle />}

      <div className="flex-1" />

      <AgentBadge />

      {hasDoc && (
        <Button variant="ghost" className="px-3 py-1 text-xs" onClick={() => setAskOpen(true)}>
          <Icon as={Sparkles} size={13} />
          Ask Claude
        </Button>
      )}

      <button
        type="button"
        data-testid={DESIGN_TESTIDS.previewButton}
        disabled={!hasDoc || (!inPreview && !previewTarget)}
        onClick={() => (inPreview ? exitPreview() : previewTarget && startPreview(previewTarget))}
        title={inPreview ? 'Sair do preview (Esc)' : 'Preview'}
        className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs transition disabled:opacity-40 ${
          inPreview
            ? 'border-[var(--color-accent)] bg-[color-mix(in_srgb,var(--color-accent)_16%,transparent)] text-[var(--color-accent)]'
            : 'border-[var(--color-border)] hover:border-[var(--color-accent)]/60 hover:text-[var(--color-text)]'
        }`}
      >
        <Icon as={inPreview ? X : Play} size={13} />
        {inPreview ? 'Sair' : 'Preview'}
      </button>
    </div>
  )
}
