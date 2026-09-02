// postMessage protocol v1 between the parent (canvas) and the runtime inside
// the artboard iframe. The iframe origin is opaque: both sides use
// targetOrigin '*' and validate `event.source`.

import type { DesignNode, DesignOp, DesignTokens, DesignTransition } from '../types/design'

export const PROTOCOL_VERSION = 1

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

interface Msg<T extends string> {
  v: typeof PROTOCOL_VERSION
  type: T
}

// ---- parent → runtime ----

export interface InitMessage extends Msg<'init'> {
  tree: DesignNode
  tokens: DesignTokens
  fonts: string[]
  mode: 'edit' | 'preview'
  // Echoes the `?t=` of the iframe URL: the runtime only accepts init with the right token.
  token: string
}

export interface OpsMessage extends Msg<'ops'> {
  reqId: string
  ops: DesignOp[]
}

export interface SetTokensMessage extends Msg<'setTokens'> {
  tokens: DesignTokens
}

export interface HitTestMessage extends Msg<'hitTest'> {
  reqId: string
  x: number
  y: number
  ignore?: string[]
}

export interface GetRectsMessage extends Msg<'getRects'> {
  reqId: string
  // Omitted = all nodes.
  ids?: string[]
}

export interface TextEditStartMessage extends Msg<'textEditStart'> {
  id: string
}

export interface GetComputedMessage extends Msg<'getComputed'> {
  reqId: string
  id: string
  props: string[]
}

// Narrows `rectsChanged` to the ids the parent cares about (empty = none).
export interface WatchMessage extends Msg<'watch'> {
  ids: string[]
}

export type ParentToRuntimeMessage =
  | InitMessage
  | OpsMessage
  | SetTokensMessage
  | HitTestMessage
  | GetRectsMessage
  | TextEditStartMessage
  | GetComputedMessage
  | WatchMessage

// ---- runtime → parent ----

export interface ReadyMessage extends Msg<'ready'> {
  artboardId: string
  protocol: number
}

export type RenderedMessage = Msg<'rendered'>

export interface OpResultMessage extends Msg<'opResult'> {
  reqId: string
  ok: boolean
  error?: string
}

export interface HitMessage extends Msg<'hit'> {
  reqId: string
  id: string | null
  rect: Rect | null
  // From the root down to the hit node.
  path: string[]
}

export interface RectsMessage extends Msg<'rects'> {
  reqId: string
  rects: Record<string, Rect>
}

export interface RectsChangedMessage extends Msg<'rectsChanged'> {
  rects: Record<string, Rect>
}

export interface ContentSizeMessage extends Msg<'contentSize'> {
  w: number
  h: number
}

export interface TextEditEndMessage extends Msg<'textEditEnd'> {
  id: string
  text: string
  reason: 'commit' | 'escape' | 'blur'
}

export interface ComputedMessage extends Msg<'computed'> {
  reqId: string
  values: Record<string, string>
}

export interface KeyMessage extends Msg<'key'> {
  key: string
  mod: boolean
  shift: boolean
}

export interface NavigateMessage extends Msg<'navigate'> {
  toArtboardId: string
  transition: DesignTransition
}

export type RuntimeToParentMessage =
  | ReadyMessage
  | RenderedMessage
  | OpResultMessage
  | HitMessage
  | RectsMessage
  | RectsChangedMessage
  | ContentSizeMessage
  | TextEditEndMessage
  | ComputedMessage
  | KeyMessage
  | NavigateMessage

export type DesignProtocolMessage = ParentToRuntimeMessage | RuntimeToParentMessage
