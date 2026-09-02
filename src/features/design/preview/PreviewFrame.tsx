// One artboard rendered in preview mode inside the PreviewMode overlay. Owns
// its own ArtboardBridge and does NOT register it in the store: the canvas
// bridge for the same artboard keeps serving the inspector/overlay.

import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { useDesignStore } from '@/store/designStore'
import { newNonce } from '@shared/design/ids'
import type { DesignTransition } from '@shared/types/design'
import { ArtboardBridge } from '../canvas/runtime-bridge'
import { artboardUrl } from '../canvas/geometry'

interface Props {
  artboardId: string
  style: CSSProperties
  // Hidden frames stay mounted so revisiting them is instant.
  hidden: boolean
  onNavigate: (toArtboardId: string, transition: DesignTransition) => void
}

export function PreviewFrame({ artboardId, style, hidden, onNavigate }: Props) {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const bridgeRef = useRef<ArtboardBridge | null>(null)
  const onNavigateRef = useRef(onNavigate)
  onNavigateRef.current = onNavigate
  const token = useMemo(() => newNonce(), [])
  const [hasBridge, setHasBridge] = useState(false)
  const [rendered, setRendered] = useState(false)

  const docId = useDesignStore((s) => s.docId)
  const artboard = useDesignStore((s) => s.artboards[artboardId])
  const tokens = useDesignStore((s) => s.doc?.tokens)
  const fonts = useDesignStore((s) => s.doc?.fonts)
  const reloadNonce = useDesignStore((s) => s.reloadNonce)

  // Bridge before src: the runtime posts 'ready' once on load.
  useEffect(() => {
    const iframe = iframeRef.current
    if (!iframe || !docId) return
    const bridge = new ArtboardBridge(iframe, artboardId, token)
    bridgeRef.current = bridge
    const offs = [
      bridge.on('navigate', (msg) => {
        if (msg.toArtboardId) onNavigateRef.current(msg.toArtboardId, msg.transition)
      }),
      bridge.on('rendered', () => setRendered(true)),
      // The runtime forwards Esc/Backspace/arrows while the iframe has focus;
      // replaying them on the window reaches PreviewMode's key handler.
      bridge.on('key', (msg) =>
        window.dispatchEvent(new KeyboardEvent('keydown', { key: msg.key, bubbles: true })),
      ),
    ]
    setHasBridge(true)
    return () => {
      for (const off of offs) off()
      bridge.dispose()
      bridgeRef.current = null
      setHasBridge(false)
    }
  }, [artboardId, docId, token])

  // Re-init on every tree change so edits made by Claude while the preview
  // is open show up live (init re-renders the whole artboard).
  useEffect(() => {
    const bridge = bridgeRef.current
    if (!bridge || !artboard) return
    bridge.init({
      tree: artboard.tree,
      tokens: tokens ?? {},
      fonts: fonts ?? [],
      mode: 'preview',
    })
  }, [artboard, tokens, fonts, hasBridge])

  useEffect(() => {
    const iframe = iframeRef.current
    if (!iframe || !docId || !hasBridge) return
    setRendered(false)
    iframe.src = artboardUrl(artboardId, docId, 'preview', token)
  }, [artboardId, docId, token, reloadNonce, hasBridge])

  if (!artboard) return null
  const { width, height, name } = artboard.meta

  return (
    <div
      className="absolute left-0 top-0 origin-top-left"
      style={{
        width,
        height,
        ...style,
        visibility: hidden ? 'hidden' : 'visible',
      }}
      aria-hidden={hidden}
    >
      <iframe
        ref={iframeRef}
        title={`Preview: ${name}`}
        sandbox="allow-scripts"
        width={width}
        height={height}
        className="block border-0 bg-[var(--color-surface)]"
        style={{
          width,
          height,
          opacity: rendered ? 1 : 0,
          transition: 'opacity 120ms ease',
        }}
      />
    </div>
  )
}
