// Runtime that lives inside the artboard iframe (sandbox, opaque origin).
// Entry of vite.runtime.config.ts: the modules under this directory are
// bundled into one dependency-free IIFE and inlined into the document with a
// CSP nonce, so nothing here may import outside src/design-runtime except
// `import type` and the pure modules under shared/design.

import type { DesignEasing, DesignTransition } from '../../../shared/types/design'
import type {
  MotionMode,
  ParentToRuntimeMessage,
  RuntimeToParentMessage as RuntimeMessage,
} from '../../../shared/design/protocol'
import { isEasing } from '../../../shared/design/motion'
import {
  applyBodySize,
  applyOp,
  currentTree,
  ensureFonts,
  renderBody,
  tokensStyleEl,
  tokensToCss,
} from './dom'
import {
  allRects,
  collectRects,
  getComputed,
  hitTest,
  installObservers,
  resetChangeTracking,
  scheduleChanges,
  setWatched,
} from './hit'
import { PROTOCOL_VERSION, post } from './messaging'
import * as motion from './motion'
import { navigate } from './motion-navigate'
import { startTextEdit } from './text-edit'

interface RuntimeConfig {
  artboardId: string
  mode: 'edit' | 'preview' | 'shot'
  token: string
}

declare global {
  interface Window {
    __PITWALL_DESIGN__?: Partial<RuntimeConfig>
  }
}

// ---- config ----

function readConfig(): RuntimeConfig {
  const injected = window.__PITWALL_DESIGN__ ?? {}
  let urlMode = ''
  let urlToken = ''
  try {
    const params = new URL(location.href).searchParams
    urlMode = params.get('mode') ?? ''
    urlToken = params.get('t') ?? ''
  } catch {
    // location may be unparseable in odd embeds; fall back to the DOM.
  }
  const domMode = document.documentElement.getAttribute('data-pw-mode') ?? ''
  const mode = injected.mode || urlMode || domMode
  return {
    artboardId: injected.artboardId ?? document.body.getAttribute('data-pw-artboard') ?? '',
    mode: mode === 'preview' || mode === 'shot' ? mode : 'edit',
    token: injected.token ?? urlToken,
  }
}

const config = readConfig()
let mode: 'edit' | 'preview' = config.mode === 'preview' ? 'preview' : 'edit'

// ---- interaction guards ----

const PREVIEW_FORWARDED_KEYS = new Set(['Escape', 'Backspace', 'ArrowLeft', 'ArrowRight'])

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable
}

function linkClickMessage(link: HTMLElement): Extract<RuntimeMessage, { type: 'linkClick' }> {
  const transition = (link.getAttribute('data-pw-transition') || 'none') as DesignTransition
  const dur = Number(link.getAttribute('data-pw-t-dur'))
  const ease = link.getAttribute('data-pw-t-ease')
  return {
    v: PROTOCOL_VERSION,
    type: 'linkClick',
    toArtboardId: link.getAttribute('data-pw-link') ?? '',
    transition,
    ...(Number.isFinite(dur) && link.hasAttribute('data-pw-t-dur') ? { duration: dur } : {}),
    ...(isEasing(ease) ? { easing: ease as DesignEasing } : {}),
  }
}

function installInteractionGuards(): void {
  document.addEventListener(
    'click',
    (e) => {
      const target = e.target as Element | null
      if (!target) return
      // Links are live in preview and in the editor's interaction mode.
      const link =
        mode === 'preview' || motion.motionMode() === 'on'
          ? target.closest<HTMLElement>('[data-pw-link]')
          : null
      if (link) {
        e.preventDefault()
        post(linkClickMessage(link))
        return
      }
      if (mode === 'preview') {
        // Real anchors / image-map areas would navigate the iframe away.
        if (target.closest('a, area')) e.preventDefault()
        return
      }
      if (target.closest('a, button, input, select, textarea, label, form')) e.preventDefault()
    },
    true,
  )
  document.addEventListener('submit', (e) => e.preventDefault(), true)
  document.addEventListener(
    'keydown',
    (e) => {
      const mod = e.metaKey || e.ctrlKey
      // Focus lands inside the iframe after a click or a text edit; the keys
      // the parent owns are forwarded. In preview those are the overlay's
      // navigation keys, unless the prototype itself is taking typed input.
      const forward =
        mode === 'edit'
          ? e.key === 'Escape' || (mod && e.key === 'Enter')
          : PREVIEW_FORWARDED_KEYS.has(e.key) && !isTypingTarget(e.target)
      if (!forward) return
      post({
        v: PROTOCOL_VERSION,
        type: 'key',
        key: e.key,
        mod,
        shift: e.shiftKey,
      })
    },
    true,
  )
}

// ---- message dispatch ----

let initialised = false

// Edit: everything sits in its final pose (off) unless the parent asks for
// interaction; preview plays.
function initialMotionMode(msg: Extract<ParentToRuntimeMessage, { type: 'init' }>): MotionMode {
  return msg.motion ?? (msg.mode === 'preview' ? 'on' : 'off')
}

function handleNavigate(msg: Extract<ParentToRuntimeMessage, { type: 'navigate' }>): void {
  void navigate(msg, currentTree()).then(() => {
    resetChangeTracking()
    post({ v: PROTOCOL_VERSION, type: 'navigated', artboardId: msg.artboardId })
    scheduleChanges()
  })
}

function handleInit(msg: Extract<ParentToRuntimeMessage, { type: 'init' }>): void {
  if (config.token && msg.token !== config.token) return
  mode = msg.mode
  document.documentElement.setAttribute('data-pw-mode', mode)
  tokensStyleEl().textContent = tokensToCss(msg.tokens)
  ensureFonts(msg.fonts)
  renderBody(msg.tree)
  applyBodySize({ sizing: msg.sizing ?? 'fixed' })
  motion.mount(initialMotionMode(msg))
  resetChangeTracking()
  if (!initialised) {
    initialised = true
    installObservers()
    installInteractionGuards()
  }
  post({ v: PROTOCOL_VERSION, type: 'rendered' })
  scheduleChanges()
}

function handleOps(msg: Extract<ParentToRuntimeMessage, { type: 'ops' }>): void {
  if (!initialised) {
    post({
      v: PROTOCOL_VERSION,
      type: 'opResult',
      reqId: msg.reqId,
      ok: false,
      error: 'not initialised',
    })
    return
  }
  try {
    for (const op of msg.ops) applyOp(op)
    post({ v: PROTOCOL_VERSION, type: 'opResult', reqId: msg.reqId, ok: true })
  } catch (err) {
    post({
      v: PROTOCOL_VERSION,
      type: 'opResult',
      reqId: msg.reqId,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    })
  }
  scheduleChanges()
}

function handleMessage(msg: ParentToRuntimeMessage): void {
  switch (msg.type) {
    case 'init':
      handleInit(msg)
      return
    case 'ops':
      handleOps(msg)
      return
    case 'setTokens':
      tokensStyleEl().textContent = tokensToCss(msg.tokens)
      scheduleChanges()
      return
    case 'hitTest': {
      const hit = hitTest(msg.x, msg.y, msg.ignore ?? [])
      post({ v: PROTOCOL_VERSION, type: 'hit', reqId: msg.reqId, ...hit })
      return
    }
    case 'getRects':
      post({
        v: PROTOCOL_VERSION,
        type: 'rects',
        reqId: msg.reqId,
        rects: msg.ids ? collectRects(msg.ids) : allRects(),
      })
      return
    case 'watch':
      setWatched(msg.ids)
      return
    case 'textEditStart':
      try {
        startTextEdit(msg.id)
      } catch {
        post({
          v: PROTOCOL_VERSION,
          type: 'textEditEnd',
          id: msg.id,
          text: '',
          reason: 'escape',
        })
      }
      return
    case 'getComputed':
      post({
        v: PROTOCOL_VERSION,
        type: 'computed',
        reqId: msg.reqId,
        values: getComputed(msg.id, msg.props),
      })
      return
    case 'motionMode':
      motion.setMotionMode(msg.mode)
      scheduleChanges()
      return
    case 'motionReplay':
      motion.replay(msg.ids)
      return
    case 'scroll':
      motion.onScroll(msg.y, msg.viewportH)
      return
    case 'navigate':
      if (initialised) handleNavigate(msg)
      return
  }
}

function isIncoming(data: unknown): data is ParentToRuntimeMessage {
  return (
    typeof data === 'object' &&
    data !== null &&
    (data as { v?: unknown }).v === PROTOCOL_VERSION &&
    typeof (data as { type?: unknown }).type === 'string'
  )
}

window.addEventListener('message', (event: MessageEvent) => {
  if (event.source !== window.parent) return
  if (!isIncoming(event.data)) return
  handleMessage(event.data)
})

post({
  v: PROTOCOL_VERSION,
  type: 'ready',
  artboardId: config.artboardId,
  protocol: PROTOCOL_VERSION,
})
