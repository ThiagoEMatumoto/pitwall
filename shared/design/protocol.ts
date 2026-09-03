// postMessage protocol v1 between the parent (canvas) and the runtime inside
// the artboard iframe. The iframe origin is opaque: both sides use
// targetOrigin '*' and validate `event.source`.

import type {
  ArtboardSizing,
  DesignEasing,
  DesignNode,
  DesignOp,
  DesignTokens,
  DesignTransition,
} from '../types/design'

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
  // Omitted = 'fixed'. In flow the runtime never sets body height (it is measured).
  sizing?: ArtboardSizing
  // Omitted = 'off' in edit (everything in its final pose, editable) and 'on'
  // in preview (entrances play, loops/hover live). See MotionModeMessage.
  motion?: MotionMode
  // Echoes the `?t=` of the iframe URL: the runtime only accepts init with the right token.
  token: string
}

// off: every entrance is marked done, loops/hover frozen (html[data-pw-motion]
// kept). on: the runtime removes html[data-pw-motion] and plays.
export type MotionMode = 'off' | 'on'

export interface MotionModeMessage extends Msg<'motionMode'> {
  mode: MotionMode
}

// Replays the entrances of `ids` (omitted = every node) from their initial pose.
export interface MotionReplayMessage extends Msg<'motionReplay'> {
  ids?: string[]
}

// The iframe never scrolls itself: the parent reports the stage scroll (css px
// of the artboard, already divided by the canvas scale) so the runtime can
// resolve in-view entrances and parallax.
export interface ScrollMessage extends Msg<'scroll'> {
  y: number
  viewportH: number
}

export type NavigateDirection = 'forward' | 'back'

// Preview player: swap the document body to another artboard's tree through
// a View Transition (transition/duration/easing come from the link that was
// clicked, or from the history when going back). Answered by `navigated`.
export interface NavigateMessage extends Msg<'navigate'> {
  artboardId: string
  tree: DesignNode
  width: number
  height: number
  sizing: ArtboardSizing
  transition: DesignTransition
  direction: NavigateDirection
  duration?: number
  easing?: DesignEasing
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
  | MotionModeMessage
  | MotionReplayMessage
  | ScrollMessage
  | NavigateMessage

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

// A click on a linked node in preview/interaction; duration/easing echo the
// link's own (data-pw-t-dur / data-pw-t-ease) when set.
export interface LinkClickMessage extends Msg<'linkClick'> {
  toArtboardId: string
  transition: DesignTransition
  duration?: number
  easing?: DesignEasing
}

// Sent when a `navigate` finished (the View Transition settled, entrances started).
export interface NavigatedMessage extends Msg<'navigated'> {
  artboardId: string
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
  | LinkClickMessage
  | NavigatedMessage

export type DesignProtocolMessage = ParentToRuntimeMessage | RuntimeToParentMessage
