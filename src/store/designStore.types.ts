import type { ArtboardPatch, IndexEntry } from '@shared/design/ops'
import type { Rect } from '@shared/design/protocol'
import type {
  ArtboardPreset,
  DesignAgentActivity,
  DesignArtboard,
  DesignDocument,
  DesignDocumentMeta,
  DesignListFilter,
  DesignNode,
  DesignOp,
  DesignTokens,
} from '@shared/types/design'
import type { Point, Viewport } from '@/features/design/canvas/geometry'

export type { IndexEntry }

export interface ArtboardState {
  meta: DesignArtboard
  tree: DesignNode
  version: number
  ready: boolean
}

export interface CanvasSelection {
  artboardId: string | null
  nodeIds: string[]
}

export interface HoverState {
  artboardId: string
  nodeId: string
  rect: Rect
}

export type DesignTool = 'move' | 'hand' | 'frame' | 'rect' | 'ellipse' | 'text' | 'image'

export interface CommitOptions {
  // Only the iframe + local copy: no undo entry, no IPC (drag in flight).
  transient?: boolean
  coalesceKey?: string
  snapshot?: boolean
  summary?: string
}

export interface TextEditEnd {
  text: string
  reason: 'commit' | 'escape' | 'blur'
}

export interface DesignState {
  docs: DesignDocumentMeta[]
  docId: string | null
  doc: DesignDocument | null
  pageId: string | null
  artboards: Record<string, ArtboardState>
  selection: CanvasSelection
  scopeId: string | null
  hover: HoverState | null
  tool: DesignTool
  viewport: Viewport
  textEditing: { artboardId: string; nodeId: string } | null
  // Keyed by artboardId; '*' holds document-level activity.
  agentActivity: Record<string, DesignAgentActivity[]>
  conflict: { artboardId: string } | null
  loading: boolean
  error: string | null
  previewArtboardId: string | null
  mode: 'edit' | 'preview'
  askOpen: boolean
  // Bumps when fonts/globalCss change: iframes must reload, not just re-init.
  reloadNonce: number
  // Layers-panel lock. Not an op and not persisted: DesignNode.locked has no
  // op of its own, so the lock only guards local pointer/keyboard edits.
  lockedIds: Record<string, true>

  loadDocs: (filter?: DesignListFilter) => Promise<void>
  openDoc: (docId: string) => Promise<void>
  closeDoc: () => Promise<void>
  selectPage: (pageId: string) => void
  createDoc: (title: string) => Promise<DesignDocument>
  renameDoc: (title: string) => Promise<void>
  archiveDoc: (docId: string) => Promise<void>
  createPage: (name: string) => Promise<void>
  createArtboard: (preset: ArtboardPreset) => Promise<DesignArtboard>
  updateArtboardMeta: (artboardId: string, patch: ArtboardPatch) => void
  setArtboardReady: (artboardId: string, ready: boolean) => void
  commit: (artboardId: string, ops: DesignOp[], opts?: CommitOptions) => void
  // Ends a gesture that never committed: reverts its transient ops.
  releaseTransient: (artboardId: string) => void
  resync: (artboardId: string) => Promise<void>
  dismissConflict: () => void
  undo: (artboardId: string) => void
  redo: (artboardId: string) => void
  select: (artboardId: string | null, nodeIds?: string[]) => void
  setScope: (scopeId: string | null) => void
  setHover: (hover: HoverState | null) => void
  setTool: (tool: DesignTool) => void
  setViewport: (viewport: Viewport) => void
  zoomTo: (zoom: number, anchor?: Point) => void
  fitToContent: () => void
  fitToArtboard: (artboardId: string) => void
  // Frames the selected nodes (or the selected artboard); with `zoom` it
  // centers them at that zoom instead of fitting. No selection: fits the
  // page, or applies `zoom` around the stage center.
  fitToSelection: (zoom?: number) => Promise<void>
  toggleLock: (nodeId: string) => void
  startTextEdit: (artboardId: string, nodeId: string) => void
  endTextEdit: (result?: TextEditEnd) => void
  setTokens: (tokens: DesignTokens) => Promise<void>
  startPreview: (artboardId: string) => void
  navigatePreview: (artboardId: string) => void
  exitPreview: () => void
  setAskOpen: (open: boolean) => void
  startWatch: () => void
  stopWatch: () => void
}
