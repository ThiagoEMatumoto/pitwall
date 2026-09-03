// Parent side of the postMessage protocol (shared/design/protocol.ts).
// One bridge per artboard iframe. The iframe origin is opaque, so messages
// go out with targetOrigin '*' and incoming ones are accepted only when
// event.source is this iframe's window.
//
// Construct the bridge BEFORE assigning iframe.src: the runtime posts
// 'ready' as soon as it loads and there is no second chance to catch it.

import {
  PROTOCOL_VERSION,
  type ComputedMessage,
  type GetComputedMessage,
  type GetRectsMessage,
  type HitMessage,
  type HitTestMessage,
  type MotionMode,
  type NavigateMessage,
  type OpResultMessage,
  type OpsMessage,
  type ParentToRuntimeMessage,
  type Rect,
  type RectsMessage,
  type RuntimeToParentMessage,
} from '@shared/design/protocol'
import type { ArtboardSizing, DesignNode, DesignOp, DesignTokens } from '@shared/types/design'

export interface BridgeInit {
  tree: DesignNode
  tokens: DesignTokens
  fonts: string[]
  mode: 'edit' | 'preview'
  // Omitted = fixed / the mode's default (off in edit, on in preview).
  sizing?: ArtboardSizing
  motion?: MotionMode
}

export type NavigatePayload = Omit<NavigateMessage, 'v' | 'type'>

export type BridgeEventType =
  | 'ready'
  | 'rendered'
  | 'hit'
  | 'rects'
  | 'rectsChanged'
  | 'contentSize'
  | 'textEditEnd'
  | 'key'
  | 'linkClick'
  | 'navigated'

export type BridgeEvent<T extends BridgeEventType> = Extract<RuntimeToParentMessage, { type: T }>
type Handler<T extends BridgeEventType> = (msg: BridgeEvent<T>) => void

type Outgoing = ParentToRuntimeMessage extends infer M
  ? M extends unknown
    ? Omit<M, 'v'>
    : never
  : never
type RequestMsg =
  | Omit<OpsMessage, 'v' | 'reqId'>
  | Omit<HitTestMessage, 'v' | 'reqId'>
  | Omit<GetRectsMessage, 'v' | 'reqId'>
  | Omit<GetComputedMessage, 'v' | 'reqId'>
type Reply = OpResultMessage | HitMessage | RectsMessage | ComputedMessage

interface Pending {
  resolve: (msg: Reply) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export const REQUEST_TIMEOUT_MS = 2000
// A navigate waits for the View Transition to settle: link duration + slack.
export const NAVIGATE_TIMEOUT_MS = 8000

let reqSeq = 0

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// Per-type shape check. The runtime is ours, but a foreign postMessage or a
// half-built runtime bundle must be ignored, never thrown on.
function hasShape(msg: Record<string, unknown>): boolean {
  switch (msg.type) {
    case 'opResult':
      return typeof msg.reqId === 'string' && typeof msg.ok === 'boolean'
    case 'hit':
      return (
        typeof msg.reqId === 'string' &&
        Array.isArray(msg.path) &&
        (msg.id === null || typeof msg.id === 'string')
      )
    case 'rects':
      return typeof msg.reqId === 'string' && isRecord(msg.rects)
    case 'computed':
      return typeof msg.reqId === 'string' && isRecord(msg.values)
    case 'rectsChanged':
      return isRecord(msg.rects)
    case 'ready':
      return typeof msg.artboardId === 'string'
    case 'rendered':
      return true
    case 'contentSize':
      return typeof msg.w === 'number' && typeof msg.h === 'number'
    case 'textEditEnd':
      return typeof msg.id === 'string' && typeof msg.text === 'string'
    case 'key':
      return typeof msg.key === 'string'
    case 'linkClick':
      return typeof msg.toArtboardId === 'string'
    case 'navigated':
      return typeof msg.artboardId === 'string'
    default:
      return false
  }
}

export function isIncoming(data: unknown): data is RuntimeToParentMessage {
  return (
    isRecord(data) && data.v === PROTOCOL_VERSION && typeof data.type === 'string' && hasShape(data)
  )
}

export class ArtboardBridge {
  readonly artboardId: string
  private readonly iframe: HTMLIFrameElement
  private readonly token: string
  private readonly pending = new Map<string, Pending>()
  private readonly handlers = new Map<BridgeEventType, Set<Handler<BridgeEventType>>>()
  private readonly rects = new Map<string, Rect>()
  // A getter, not a snapshot: 'ready' may arrive after ops changed the tree.
  private initPayload: (() => BridgeInit) | null = null
  private navigating: {
    artboardId: string
    resolve: () => void
    reject: (err: Error) => void
  } | null = null
  private ready = false
  private disposed = false

  constructor(iframe: HTMLIFrameElement, artboardId: string, token: string) {
    this.iframe = iframe
    this.artboardId = artboardId
    this.token = token
    window.addEventListener('message', this.onMessage)
  }

  get isReady(): boolean {
    return this.ready
  }

  // Sends 'init' now if the runtime is ready, otherwise as soon as it is.
  // Calling it again re-renders the whole artboard (resync / full update).
  init(payload: BridgeInit | (() => BridgeInit)): void {
    this.initPayload = typeof payload === 'function' ? payload : () => payload
    if (this.ready) this.sendInit()
  }

  // Re-render from the current payload (an op the runtime could not apply
  // means its DOM and the store's tree drifted apart).
  reinit(): void {
    if (this.ready) this.sendInit()
  }

  private sendInit(): void {
    if (!this.initPayload) return
    this.post({ type: 'init', ...this.initPayload(), token: this.token })
  }

  post(msg: Outgoing): void {
    if (this.disposed) return
    const target = this.iframe.contentWindow
    if (!target) return
    target.postMessage({ v: PROTOCOL_VERSION, ...msg }, '*')
  }

  request<R extends Reply>(msg: RequestMsg, timeoutMs = REQUEST_TIMEOUT_MS): Promise<R> {
    const reqId = `r${++reqSeq}`
    return new Promise<R>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(reqId)
        reject(new Error(`design runtime timeout: ${msg.type} (${this.artboardId})`))
      }, timeoutMs)
      this.pending.set(reqId, {
        resolve: (m) => resolve(m as R),
        reject,
        timer,
      })
      this.post({ ...msg, reqId } as Outgoing)
    })
  }

  applyOps(ops: DesignOp[]): Promise<OpResultMessage> {
    return this.request<OpResultMessage>({ type: 'ops', ops })
  }

  hitTest(x: number, y: number, ignore?: string[]): Promise<HitMessage> {
    return this.request<HitMessage>({ type: 'hitTest', x, y, ignore })
  }

  async getRects(ids?: string[]): Promise<Record<string, Rect>> {
    const reply = await this.request<RectsMessage>({ type: 'getRects', ids })
    return reply.rects
  }

  async getComputed(id: string, props: string[]): Promise<Record<string, string>> {
    const reply = await this.request<ComputedMessage>({
      type: 'getComputed',
      id,
      props,
    })
    return reply.values
  }

  setTokens(tokens: DesignTokens): void {
    const previous = this.initPayload
    if (previous) this.initPayload = () => ({ ...previous(), tokens })
    this.post({ type: 'setTokens', tokens })
  }

  watch(ids: string[]): void {
    this.post({ type: 'watch', ids })
  }

  startTextEdit(id: string): void {
    this.post({ type: 'textEditStart', id })
  }

  // Remembered in the init payload too: a reload must come back in the same mode.
  setMotionMode(mode: MotionMode): void {
    const previous = this.initPayload
    if (previous) this.initPayload = () => ({ ...previous(), motion: mode })
    this.post({ type: 'motionMode', mode })
  }

  replayMotion(ids?: string[]): void {
    this.post({ type: 'motionReplay', ids })
  }

  // Artboard-local css px (already divided by the canvas scale).
  scroll(y: number, viewportH: number): void {
    this.post({ type: 'scroll', y, viewportH })
  }

  // Resolves when the runtime posts `navigated` for this artboard; a later
  // navigate supersedes an earlier one still in flight (it rejects).
  navigate(payload: NavigatePayload, timeoutMs = NAVIGATE_TIMEOUT_MS): Promise<void> {
    this.navigating?.reject(new Error('superseded by a later navigate'))
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.navigating = null
        reject(new Error(`design runtime timeout: navigate (${this.artboardId})`))
      }, timeoutMs)
      this.navigating = {
        artboardId: payload.artboardId,
        resolve: () => {
          clearTimeout(timer)
          this.navigating = null
          resolve()
        },
        reject: (err) => {
          clearTimeout(timer)
          this.navigating = null
          reject(err)
        },
      }
      this.post({ type: 'navigate', ...payload })
    })
  }

  on<T extends BridgeEventType>(type: T, handler: Handler<T>): () => void {
    let set = this.handlers.get(type)
    if (!set) {
      set = new Set()
      this.handlers.set(type, set)
    }
    const h = handler as unknown as Handler<BridgeEventType>
    set.add(h)
    return () => {
      set.delete(h)
    }
  }

  // Last rect the runtime reported for `id` (artboard-local px), or null.
  getCachedRect(id: string): Rect | null {
    return this.rects.get(id) ?? null
  }

  dropRects(ids: readonly string[]): void {
    for (const id of ids) this.rects.delete(id)
  }

  private cacheRects(rects: Record<string, Rect>): void {
    for (const [id, rect] of Object.entries(rects)) this.rects.set(id, rect)
  }

  private readonly onMessage = (event: MessageEvent): void => {
    if (this.disposed) return
    if (!this.iframe.contentWindow || event.source !== this.iframe.contentWindow) return
    if (!isIncoming(event.data)) return
    const msg = event.data
    switch (msg.type) {
      case 'ready':
        // A reload (or StrictMode remount) posts 'ready' again: re-init.
        this.ready = true
        this.rects.clear()
        this.sendInit()
        break
      case 'opResult':
      case 'hit':
      case 'rects':
      case 'computed':
        if (msg.type === 'rects') this.cacheRects(msg.rects)
        this.settle(msg)
        break
      case 'rectsChanged':
        this.cacheRects(msg.rects)
        break
      case 'navigated':
        if (this.navigating?.artboardId === msg.artboardId) this.navigating.resolve()
        break
      default:
        break
    }
    if (msg.type === 'opResult' || msg.type === 'computed') return
    this.emit(msg as BridgeEvent<BridgeEventType>)
  }

  private settle(msg: Reply): void {
    const p = this.pending.get(msg.reqId)
    if (!p) return
    clearTimeout(p.timer)
    this.pending.delete(msg.reqId)
    p.resolve(msg)
  }

  private emit(msg: BridgeEvent<BridgeEventType>): void {
    const set = this.handlers.get(msg.type)
    if (!set) return
    for (const h of set) h(msg)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    window.removeEventListener('message', this.onMessage)
    for (const p of this.pending.values()) {
      clearTimeout(p.timer)
      p.reject(new Error('bridge disposed'))
    }
    this.pending.clear()
    this.navigating?.reject(new Error('bridge disposed'))
    this.handlers.clear()
    this.rects.clear()
  }
}
