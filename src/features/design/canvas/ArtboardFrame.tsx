// One artboard on the stage: a draggable name label, the sandboxed iframe
// running the design runtime, and the InteractionLayer that sits over it in
// edit mode (lifted in interaction mode, when the iframe takes the pointer
// and motion plays). Owns the ArtboardBridge lifecycle for this iframe.

import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { registerBridge, useDesignStore } from '@/store/designStore'
import { newNonce } from '@shared/design/ids'
import { DESIGN_TESTIDS } from '@shared/types/design'
import { ArtboardOverflowBadge } from './ArtboardOverflowBadge'
import { InteractionLayer } from './InteractionLayer'
import { ArtboardBridge } from './runtime-bridge'
import { artboardUrl } from './geometry'

interface Props {
  artboardId: string
}

const LABEL_HEIGHT = 20
const DRAG_THRESHOLD_PX = 2

interface LabelDrag {
  pointerId: number
  startX: number
  startY: number
  originX: number
  originY: number
  moved: boolean
}

export function ArtboardFrame({ artboardId }: Props) {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const bridgeRef = useRef<ArtboardBridge | null>(null)
  const dragRef = useRef<LabelDrag | null>(null)
  const loadedRef = useRef<{ url: string; reloadNonce: number } | null>(null)
  // Per-mount secret echoed in `init`; the runtime ignores inits without it.
  const token = useMemo(() => newNonce(), [])
  const [hasBridge, setHasBridge] = useState(false)

  const artboard = useDesignStore((s) => s.artboards[artboardId])
  const docId = useDesignStore((s) => s.docId)
  const mode = useDesignStore((s) => s.mode)
  const zoom = useDesignStore((s) => s.viewport.zoom)
  const reloadNonce = useDesignStore((s) => s.reloadNonce)
  const selected = useDesignStore((s) => s.selection.artboardId === artboardId)
  const selectedNodeIds = useDesignStore((s) =>
    s.selection.artboardId === artboardId ? s.selection.nodeIds : null,
  )
  const agentNodeIds = useDesignStore((s) => s.agentActivity[artboardId])
  const interaction = useDesignStore((s) => s.interaction)
  const sizing = useDesignStore((s) => s.artboards[artboardId]?.meta.sizing)
  const metaHeight = useDesignStore((s) => s.artboards[artboardId]?.meta.height)
  const reportFlowHeight = useDesignStore((s) => s.reportFlowHeight)
  const setArtboardReady = useDesignStore((s) => s.setArtboardReady)
  const endTextEdit = useDesignStore((s) => s.endTextEdit)
  const select = useDesignStore((s) => s.select)
  const commit = useDesignStore((s) => s.commit)
  const updateArtboardMeta = useDesignStore((s) => s.updateArtboardMeta)

  // Bridge before src: the runtime posts 'ready' on load and there is no
  // second chance to catch it.
  useEffect(() => {
    const iframe = iframeRef.current
    if (!iframe || !docId) return
    const bridge = new ArtboardBridge(iframe, artboardId, token)
    bridgeRef.current = bridge
    const unregister = registerBridge(artboardId, bridge)
    const offs = [
      bridge.on('ready', () => setArtboardReady(artboardId, true)),
      bridge.on('textEditEnd', (msg) => {
        const editing = useDesignStore.getState().textEditing
        if (editing?.artboardId === artboardId && editing.nodeId === msg.id) {
          endTextEdit({ text: msg.text, reason: msg.reason })
        }
      }),
    ]
    setHasBridge(true)
    return () => {
      for (const off of offs) off()
      unregister()
      bridge.dispose()
      bridgeRef.current = null
      setHasBridge(false)
      setArtboardReady(artboardId, false)
    }
    // The tree/tokens go through init below and through the store afterwards.
  }, [artboardId, docId, token, setArtboardReady, endTextEdit])

  // (Re)load the iframe. A src change makes the runtime post 'ready' again,
  // which rebuilds the init payload from the store at that moment, so ops
  // applied while the frame was still loading are not lost.
  useEffect(() => {
    const iframe = iframeRef.current
    const bridge = bridgeRef.current
    if (!iframe || !bridge || !docId || !useDesignStore.getState().artboards[artboardId]) return
    bridge.init(() => {
      const s = useDesignStore.getState()
      const state = s.artboards[artboardId]
      return {
        tree: state?.tree ?? {
          id: '',
          tag: 'div',
          kind: 'frame',
          style: {},
          attrs: {},
          children: [],
        },
        tokens: s.doc?.tokens ?? {},
        fonts: s.doc?.fonts ?? [],
        mode: s.mode,
        sizing: state?.meta.sizing ?? 'fixed',
        motion: s.mode === 'edit' && !s.interaction ? 'off' : 'on',
      }
    })
    const url = artboardUrl(artboardId, docId, mode, token)
    // The effect re-runs when hasBridge flips on the same commit that set the
    // src; assigning the same URL again would abort the in-flight load and
    // start over (net::ERR_ABORTED). Only reloadNonce may repeat a URL.
    const last = loadedRef.current
    if (last && last.url === url && last.reloadNonce === reloadNonce) return
    loadedRef.current = { url, reloadNonce }
    setArtboardReady(artboardId, false)
    iframe.src = url
  }, [artboardId, docId, mode, token, reloadNonce, setArtboardReady, hasBridge])

  // Flow: the iframe is as tall as its content. The runtime reports the
  // scroll size on every reflow; the store grows the frame at once and
  // persists the height once it settles.
  useEffect(() => {
    const bridge = bridgeRef.current
    if (!bridge || sizing !== 'flow') return
    return bridge.on('contentSize', (msg) => reportFlowHeight(artboardId, msg.h))
  }, [artboardId, sizing, reportFlowHeight, hasBridge])

  // Interaction: motion plays and, since the canvas never scrolls the iframe,
  // the whole artboard counts as in view (in-view entrances play like load).
  useEffect(() => {
    const bridge = bridgeRef.current
    if (!bridge || mode !== 'edit') return
    bridge.setMotionMode(interaction ? 'on' : 'off')
    if (interaction && metaHeight) bridge.scroll(0, metaHeight)
  }, [interaction, mode, metaHeight, hasBridge])

  // Narrow rectsChanged to the nodes the overlay draws and prime the cache.
  useEffect(() => {
    const bridge = bridgeRef.current
    if (!bridge) return
    const ids = [...(selectedNodeIds ?? []), ...(agentNodeIds ?? []).flatMap((a) => a.nodeIds)]
    bridge.watch(ids)
    if (ids.length) void bridge.getRects(ids).catch(() => undefined)
  }, [selectedNodeIds, agentNodeIds, hasBridge])

  if (!artboard) return null
  const { meta } = artboard

  const onLabelPointerDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0 || mode !== 'edit') return
    e.stopPropagation()
    e.currentTarget.setPointerCapture(e.pointerId)
    dragRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      originX: meta.x,
      originY: meta.y,
      moved: false,
    }
  }

  const onLabelPointerMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const d = dragRef.current
    if (!d || d.pointerId !== e.pointerId) return
    const dx = (e.clientX - d.startX) / zoom
    const dy = (e.clientY - d.startY) / zoom
    if (!d.moved && Math.abs(dx) < DRAG_THRESHOLD_PX && Math.abs(dy) < DRAG_THRESHOLD_PX) return
    d.moved = true
    commit(
      artboardId,
      [
        {
          type: 'setArtboard',
          patch: {
            x: Math.round(d.originX + dx),
            y: Math.round(d.originY + dy),
          },
        },
      ],
      { transient: true },
    )
  }

  const onLabelPointerUp = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const d = dragRef.current
    if (!d || d.pointerId !== e.pointerId) return
    dragRef.current = null
    e.currentTarget.releasePointerCapture(e.pointerId)
    if (!d.moved) {
      select(artboardId, [])
      return
    }
    const dx = (e.clientX - d.startX) / zoom
    const dy = (e.clientY - d.startY) / zoom
    updateArtboardMeta(artboardId, {
      x: Math.round(d.originX + dx),
      y: Math.round(d.originY + dy),
    })
  }

  return (
    <div
      className="absolute"
      style={{
        left: meta.x,
        top: meta.y,
        width: meta.width,
        height: meta.height,
      }}
      onPointerDown={(e) => {
        // Middle button / hand tool must reach the stage for panning.
        if (e.button === 0 && useDesignStore.getState().tool !== 'hand') e.stopPropagation()
      }}
    >
      <div
        title={meta.name}
        className={`absolute left-0 select-none overflow-hidden text-ellipsis whitespace-nowrap text-[11px] leading-5 ${
          selected ? 'text-[var(--color-accent)]' : 'text-[var(--color-text-muted)]'
        } ${mode === 'edit' ? 'cursor-grab active:cursor-grabbing' : ''}`}
        style={{
          top: -LABEL_HEIGHT / zoom,
          height: LABEL_HEIGHT / zoom,
          // Never wider than the artboard (pre-scale px), so neighbours'
          // labels cannot run into each other when zoomed out.
          maxWidth: meta.width * zoom,
          transform: `scale(${1 / zoom})`,
          transformOrigin: 'left top',
        }}
        onPointerDown={onLabelPointerDown}
        onPointerMove={onLabelPointerMove}
        onPointerUp={onLabelPointerUp}
        onPointerCancel={onLabelPointerUp}
      >
        {meta.name}
      </div>

      <iframe
        ref={iframeRef}
        title={meta.name}
        sandbox="allow-scripts"
        width={meta.width}
        height={meta.height}
        {...{ [DESIGN_TESTIDS.artboard]: artboardId }}
        className="block border-0"
        style={{
          width: meta.width,
          height: meta.height,
          pointerEvents: mode === 'edit' && !interaction ? 'none' : 'auto',
          boxShadow:
            '0 0 0 1px var(--color-border), 0 8px 24px color-mix(in srgb, var(--color-bg) 60%, transparent)',
        }}
      />

      {mode === 'edit' && !interaction && hasBridge && (
        <>
          <InteractionLayer artboardId={artboardId} bridge={bridgeRef.current!} />
          <ArtboardOverflowBadge artboardId={artboardId} bridge={bridgeRef.current!} />
        </>
      )}
    </div>
  )
}

// What the stage shows for an artboard far outside the viewport: the frame's
// footprint and name, no iframe (each one is a renderer process).
export function ArtboardPlaceholder({ artboardId }: Props) {
  const meta = useDesignStore((s) => s.artboards[artboardId]?.meta)
  const zoom = useDesignStore((s) => s.viewport.zoom)
  if (!meta) return null
  return (
    <div
      className="absolute"
      style={{ left: meta.x, top: meta.y, width: meta.width, height: meta.height }}
      {...{ [DESIGN_TESTIDS.artboard]: artboardId }}
      data-placeholder=""
    >
      <div
        className="absolute left-0 select-none overflow-hidden text-ellipsis whitespace-nowrap text-[11px] leading-5 text-[var(--color-text-muted)]"
        style={{
          top: -LABEL_HEIGHT / zoom,
          height: LABEL_HEIGHT / zoom,
          maxWidth: meta.width * zoom,
          transform: `scale(${1 / zoom})`,
          transformOrigin: 'left top',
        }}
      >
        {meta.name}
      </div>
      <div
        className="h-full w-full"
        style={{
          background: 'var(--color-surface-2)',
          boxShadow: '0 0 0 1px var(--color-border)',
        }}
      />
    </div>
  )
}
