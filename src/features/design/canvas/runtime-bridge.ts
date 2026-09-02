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
  type OpResultMessage,
  type OpsMessage,
  type ParentToRuntimeMessage,
  type Rect,
  type RectsMessage,
  type RuntimeToParentMessage,
} from '@shared/design/protocol'
import type { DesignNode, DesignOp, DesignTokens } from '@shared/types/design'

export interface BridgeInit {
  tree: DesignNode
  tokens: DesignTokens
  fonts: string[]
  mode: 'edit' | 'preview'
}

export type BridgeEventType =
  'ready' | 'rendered' | 'hit' | 'rects' | 'rectsChanged' | 'contentSize' | 'textEditEnd' | 'key' | 'navigate'

export type BridgeEvent<T extends BridgeEventType> = Extract<RuntimeToParentMessage, { type: T }>
type Handler<T extends BridgeEventType> = (msg: BridgeEvent<T>) => void

type Outgoing = ParentToRuntimeMessage extends infer M ? (M extends unknown ? Omit<M, 'v'> : never) : never
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

let reqSeq = 0

function isIncoming(data: unknown): data is RuntimeToParentMessage {
  return (
    typeof data === 'object' &&
    data !== null &&
    (data as { v?: unknown }).v === PROTOCOL_VERSION &&
    typeof (data as { type?: unknown }).type === 'string'
  )
}

export class ArtboardBridge {
  readonly artboardId: string
  private readonly iframe: HTMLIFrameElement
  private readonly token: string
  private readonly pending = new Map<string, Pending>()
  private readonly handlers = new Map<BridgeEventType, Set<Handler<BridgeEventType>>>()
  private readonly rects = new Map<string, Rect>()
  private initPayload: BridgeInit | null = null
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
  init(payload: BridgeInit): void {
    this.initPayload = payload
    if (this.ready) this.sendInit()
  }

  private sendInit(): void {
    if (!this.initPayload) return
    this.post({ type: 'init', ...this.initPayload, token: this.token })
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
    if (this.initPayload) this.initPayload = { ...this.initPayload, tokens }
    this.post({ type: 'setTokens', tokens })
  }

  watch(ids: string[]): void {
    this.post({ type: 'watch', ids })
  }

  startTextEdit(id: string): void {
    this.post({ type: 'textEditStart', id })
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
    this.handlers.clear()
    this.rects.clear()
  }
}
