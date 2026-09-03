// The single preview iframe. Loads the first artboard, then swaps the body to
// the next one through `bridge.navigate` (a View Transition inside the
// runtime) instead of mounting one frame per artboard: Smart Animate needs
// both screens in the same document. Owns its bridge and does NOT register
// it in the store: the canvas bridge keeps serving the inspector.

import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { useDesignStore } from '@/store/designStore'
import { newNonce } from '@shared/design/ids'
import type { ScrollMessage } from '@shared/design/protocol'
import type { DesignEasing, DesignTransition } from '@shared/types/design'
import { ArtboardBridge } from '../canvas/runtime-bridge'
import { artboardUrl } from '../canvas/geometry'
import type { ActiveTransition } from './transitions'

export interface PreviewPlayerHandle {
  scroll: (msg: Omit<ScrollMessage, 'v' | 'type'>) => void
}

interface Props {
  artboardId: string
  transition: ActiveTransition | null
  scale: number
  onLinkClick: (
    toArtboardId: string,
    transition: DesignTransition,
    duration?: number,
    easing?: DesignEasing,
  ) => void
  // The runtime finished the navigate (or the swap fell back): clear the transition.
  onSettled: () => void
}

interface Shown {
  artboardId: string
  tree: unknown
  tokens: unknown
  fonts: unknown
}

export const PreviewPlayer = forwardRef<PreviewPlayerHandle, Props>(function PreviewPlayer(
  { artboardId, transition, scale, onLinkClick, onSettled },
  ref,
) {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const bridgeRef = useRef<ArtboardBridge | null>(null)
  const callbacks = useRef({ onLinkClick, onSettled })
  callbacks.current = { onLinkClick, onSettled }
  // What the runtime currently displays; the effect below only re-sends
  // when something differs, so a settled navigate is not rendered twice.
  const shownRef = useRef<Shown | null>(null)
  const token = useMemo(() => newNonce(), [])
  // The iframe URL names the artboard it booted with; later screens arrive via navigate.
  const [bootId] = useState(artboardId)
  const [hasBridge, setHasBridge] = useState(false)
  const [rendered, setRendered] = useState(false)
  const [flowHeight, setFlowHeight] = useState<number | null>(null)

  const docId = useDesignStore((s) => s.docId)
  const artboard = useDesignStore((s) => s.artboards[artboardId])
  const tokens = useDesignStore((s) => s.doc?.tokens)
  const fonts = useDesignStore((s) => s.doc?.fonts)
  const reloadNonce = useDesignStore((s) => s.reloadNonce)

  useImperativeHandle(
    ref,
    () => ({ scroll: (msg) => bridgeRef.current?.scroll(msg.y, msg.viewportH) }),
    [],
  )

  // Bridge before src: the runtime posts 'ready' once on load.
  useEffect(() => {
    const iframe = iframeRef.current
    if (!iframe || !docId) return
    const bridge = new ArtboardBridge(iframe, bootId, token)
    bridgeRef.current = bridge
    const offs = [
      bridge.on('linkClick', (msg) =>
        callbacks.current.onLinkClick(msg.toArtboardId, msg.transition, msg.duration, msg.easing),
      ),
      bridge.on('rendered', () => setRendered(true)),
      bridge.on('contentSize', (msg) => setFlowHeight(msg.h)),
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
      shownRef.current = null
      setHasBridge(false)
    }
  }, [bootId, docId, token])

  useEffect(() => {
    setFlowHeight(null)
  }, [artboardId])

  // One effect decides between navigate (animated swap to another artboard)
  // and init (first paint, live edits by Claude, or a swap without transition).
  useEffect(() => {
    const bridge = bridgeRef.current
    if (!bridge || !artboard) return
    const { tree, meta } = artboard
    const shown = shownRef.current
    const same =
      shown &&
      shown.artboardId === artboardId &&
      shown.tree === tree &&
      shown.tokens === tokens &&
      shown.fonts === fonts
    if (same) return
    shownRef.current = { artboardId, tree, tokens, fonts }

    const animated = transition && transition.to === artboardId && shown?.artboardId !== artboardId
    if (!animated) {
      bridge.init({
        tree,
        tokens: tokens ?? {},
        fonts: fonts ?? [],
        mode: 'preview',
        sizing: meta.sizing,
        motion: 'on',
      })
      if (transition) callbacks.current.onSettled()
      return
    }
    // Keep the init payload current so a runtime reload lands on this screen.
    bridge.init(() => ({
      tree,
      tokens: tokens ?? {},
      fonts: fonts ?? [],
      mode: 'preview',
      sizing: meta.sizing,
      motion: 'on',
    }))
    let active = true
    bridge
      .navigate({
        artboardId,
        tree,
        width: meta.width,
        height: meta.height,
        sizing: meta.sizing,
        transition: transition.kind,
        direction: transition.direction,
        duration: transition.duration,
        easing: transition.easing,
      })
      .catch(() => undefined)
      .then(() => {
        if (active) callbacks.current.onSettled()
      })
    return () => {
      active = false
    }
  }, [artboard, artboardId, tokens, fonts, hasBridge, transition])

  useEffect(() => {
    const iframe = iframeRef.current
    if (!iframe || !docId || !hasBridge) return
    setRendered(false)
    iframe.src = artboardUrl(bootId, docId, 'preview', token)
  }, [bootId, docId, token, reloadNonce, hasBridge])

  if (!artboard) return null
  const { width, name, sizing } = artboard.meta
  const height = sizing === 'flow' && flowHeight ? flowHeight : artboard.meta.height
  const sizeTween = transition ? `${transition.duration}ms cubic-bezier(0.2, 0, 0, 1)` : '0s'

  return (
    <div
      className="relative shrink-0 overflow-hidden"
      data-testid="design-preview-player"
      style={{
        width: width * scale,
        height: height * scale,
        transition: `width ${sizeTween}, height ${sizeTween}`,
        boxShadow: '0 0 0 1px var(--color-border), 0 24px 64px rgba(0, 0, 0, 0.45)',
      }}
    >
      <iframe
        ref={iframeRef}
        title={`Preview: ${name}`}
        sandbox="allow-scripts"
        width={width}
        height={height}
        className="absolute left-0 top-0 block origin-top-left border-0 bg-[var(--color-surface)]"
        style={{
          width,
          height,
          transform: `scale(${scale})`,
          opacity: rendered ? 1 : 0,
          transition: 'opacity 120ms ease',
        }}
      />
    </div>
  )
})
