// Content taller (or wider) than a fixed artboard is clipped by the iframe
// with no hint that anything is missing. The runtime reports its scroll size
// (contentSize); this badge names the overflow and offers to grow the
// artboard to fit (Figma's "resize to fit") or to switch it to flow, where
// the height follows the content. Flow artboards never show it.

import { useEffect, useState } from 'react'
import { useDesignStore } from '@/store/designStore'
import { overflowApplies, overflowLabel, overflowOf, type OverflowSize } from './artboard-overflow'
import type { ArtboardBridge } from './runtime-bridge'

interface Props {
  artboardId: string
  bridge: ArtboardBridge
}

export const OVERFLOW_TESTID = 'design-overflow-badge'
const MIN_ARTBOARD_SCREEN_WIDTH = 320

export function ArtboardOverflowBadge({ artboardId, bridge }: Props) {
  const [content, setContent] = useState<OverflowSize | null>(null)
  const meta = useDesignStore((s) => s.artboards[artboardId]?.meta)
  const zoom = useDesignStore((s) => s.viewport.zoom)
  const updateArtboardMeta = useDesignStore((s) => s.updateArtboardMeta)

  useEffect(() => {
    setContent(null)
    return bridge.on('contentSize', (msg) => setContent({ w: msg.w, h: msg.h }))
  }, [bridge])

  if (!meta || !content || !overflowApplies(meta)) return null
  const over = overflowOf(content, meta)
  if (!over) return null
  // The badge keeps its screen size; zoomed out it would be wider than the
  // artboard and land on the neighbour's, so it waits for a closer view.
  if (meta.width * zoom < MIN_ARTBOARD_SCREEN_WIDTH) return null

  const grow = (): void =>
    updateArtboardMeta(artboardId, {
      width: over.w ? meta.width + over.w : meta.width,
      height: over.h ? meta.height + over.h : meta.height,
    })
  const toFlow = (): void => updateArtboardMeta(artboardId, { sizing: 'flow' })
  const action =
    'rounded border border-[var(--color-border)] px-1.5 py-0.5 text-[var(--color-text-muted)] transition hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text)]'

  return (
    <div
      data-testid={OVERFLOW_TESTID}
      className="absolute right-0 flex items-center gap-2 whitespace-nowrap rounded-md border border-[var(--color-warning)] bg-[var(--color-surface)] px-2 py-1 text-[11px] text-[var(--color-text)] shadow-md"
      style={{
        bottom: 0,
        transform: `translateY(100%) scale(${1 / zoom})`,
        transformOrigin: 'right top',
        marginTop: 4 / zoom,
      }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <span className="text-[var(--color-warning)]">{overflowLabel(over)}</span>
      <button type="button" onClick={grow} className={action}>
        Ajustar artboard
      </button>
      {over.h > 0 && (
        <button
          type="button"
          onClick={toFlow}
          title="A altura passa a seguir o conteúdo"
          className={action}
        >
          Converter em fluxo
        </button>
      )}
    </div>
  )
}
