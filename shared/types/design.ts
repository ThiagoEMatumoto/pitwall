// Design Studio — contract shared by main ↔ renderer ↔ MCP.
// The canonical model is the JSON tree per artboard; HTML is a projection
// (shared/design/html-render.ts) and an input (parse5 in main).

export type DesignNodeKind = 'frame' | 'text' | 'image' | 'svg' | 'element'

import type { DesignMotion, DesignNodeLink } from './design-motion'

export interface DesignNode {
  id: string
  tag: string
  kind: DesignNodeKind
  style: Record<string, string>
  attrs: Record<string, string>
  text?: string
  children: DesignNode[]
  name?: string
  locked?: boolean
  // No op sets this: visibility is toggled through setStyle on `display` and
  // the UI treats `hidden || display === 'none'` as hidden. The flag only
  // arrives on trees written whole (paste/import); the edit render maps it to
  // display:none and the export drops the node.
  hidden?: boolean
  link?: DesignNodeLink
  // Rendered as data-pw-m-* attributes + --pw-* variables derived after the
  // user's style (html-render.ts); the static sheet is MOTION_CSS.
  motion?: DesignMotion
}

// Each category becomes a CSS variable prefix: color.primary → --color-primary.
export interface DesignTokens {
  color?: Record<string, string>
  spacing?: Record<string, string>
  radius?: Record<string, string>
  font?: Record<string, string>
  shadow?: Record<string, string>
}

export type DesignTokenCategory = keyof DesignTokens

// Google Fonts stylesheet URLs (https://fonts.googleapis.com/css2?...).
export type DesignFonts = string[]

export type DesignDocumentStatus = 'active' | 'archived'

export type DesignAuthor = 'claude' | 'human'

// nonce identifies the mutation so the emitter can ignore its own broadcast echo.
export interface DesignOrigin {
  kind: DesignAuthor
  sessionId: string | null
  nonce: string
}

export type DesignParentType =
  'project' | 'repo' | 'feature' | 'task' | 'objective' | 'key_result' | 'session' | 'handoff'

export interface DesignLink {
  documentId: string
  parentType: DesignParentType
  parentId: string
}

export interface DesignPageViewport {
  x: number
  y: number
  zoom: number
}

// fixed: the body is width×height and clips. flow: the width is fixed and the
// body grows with its content; `height` is the last height measured by the
// runtime (or the capture), persisted so the canvas and the tools agree.
export type ArtboardSizing = 'fixed' | 'flow'

export interface DesignArtboard {
  id: string
  pageId: string
  name: string
  x: number
  y: number
  width: number
  height: number
  sizing: ArtboardSizing
  tree: DesignNode
  version: number
  position: number
  createdAt: number
  updatedAt: number
}

export interface DesignPage {
  id: string
  documentId: string
  name: string
  position: number
  viewport: DesignPageViewport
  artboards: DesignArtboard[]
  createdAt: number
  updatedAt: number
}

// Header without pages: what documentsList() returns.
export interface DesignDocumentMeta {
  id: string
  title: string
  status: DesignDocumentStatus
  thumbnail: string | null
  createdAt: number
  updatedAt: number
}

export interface DesignDocument extends DesignDocumentMeta {
  tokens: DesignTokens
  fonts: DesignFonts
  globalCss: string
  pages: DesignPage[]
  links: DesignLink[]
}

export interface DesignVersionMeta {
  id: string
  artboardId: string
  version: number
  author: DesignAuthor
  summary: string
  createdAt: number
}

export interface DesignVersion extends DesignVersionMeta {
  tree: DesignNode
}

export type DesignAssetMime =
  'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif' | 'image/svg+xml'

// Without the bytes: those only leave through the pitwall-design://asset/<id> scheme.
export interface DesignAsset {
  id: string
  // null = shared across documents.
  documentId: string | null
  name: string
  mime: DesignAssetMime
  size: number
  width: number | null
  height: number | null
  sha256: string
  url: string
  createdAt: number
}

export type DesignOp =
  | { type: 'insert'; parentId: string | null; index: number; node: DesignNode }
  | { type: 'remove'; ids: string[] }
  | { type: 'move'; ids: string[]; parentId: string; index: number }
  | { type: 'setStyle'; id: string; patch: Record<string, string | null> }
  | { type: 'setAttrs'; id: string; patch: Record<string, string | null> }
  | { type: 'setText'; id: string; text: string }
  | { type: 'rename'; id: string; name: string }
  | { type: 'setLink'; id: string; link: DesignNodeLink | null }
  | { type: 'setMotion'; id: string; motion: DesignMotion | null }
  | { type: 'replaceTree'; tree: DesignNode }
  | {
      type: 'setArtboard'
      patch: Partial<Pick<DesignArtboard, 'x' | 'y' | 'width' | 'height' | 'name' | 'sizing'>>
    }

// Broadcast 'design:artboard-updated'. full=true when the whole tree
// changed (replaceTree/restore) and the iframe must reload.
export interface ArtboardUpdatedEvent {
  docId: string
  artboardId: string
  ops: DesignOp[]
  version: number
  origin: DesignOrigin
  full: boolean
}

// Broadcast 'design:agent-activity'. finish = design_nodes_finish.
export interface DesignAgentActivity {
  docId: string
  artboardId: string | null
  nodeIds: string[]
  tool: string
  phase: 'start' | 'end' | 'finish'
  sessionId: string | null
  at: number
  summary?: string
}

export interface DesignNodeSummary {
  id: string
  tag: string
  kind: DesignNodeKind
  name?: string
  // Truncated to 60 chars.
  text?: string
  // One line, e.g. "in: slide-up 240ms +stagger 60 · hover: lift" (motionSummary).
  motion?: string
  childCount: number
  children?: DesignNodeSummary[]
}

export interface DesignSelection {
  docId: string
  artboardId: string | null
  nodeIds: string[]
}

// ---- IPC inputs ----

export interface DesignListFilter {
  // Defaults to 'active' in the store.
  status?: DesignDocumentStatus | 'all'
  parentType?: DesignParentType
  parentId?: string
  search?: string
}

export interface CreateDesignDocumentInput {
  title: string
  tokens?: DesignTokens
  fonts?: DesignFonts
  globalCss?: string
  links?: Array<{ parentType: DesignParentType; parentId: string }>
}

export interface UpdateDesignDocumentInput {
  id: string
  title?: string
  tokens?: DesignTokens
  fonts?: DesignFonts
  globalCss?: string
}

export interface CreateDesignPageInput {
  docId: string
  name: string
  position?: number
}

export interface UpdateDesignPageInput {
  id: string
  name?: string
  position?: number
  viewport?: DesignPageViewport
}

export interface CreateDesignArtboardInput {
  docId: string
  // Omitted = first page of the document.
  pageId?: string
  name: string
  width: number
  // Omitted = DEFAULT_ARTBOARD_HEIGHT_PX (safety.ts): the natural case is a
  // flow artboard, whose height is measured from the content anyway.
  height?: number
  // Omitted = 'fixed'.
  sizing?: ArtboardSizing
  x?: number
  y?: number
  // Omitted = empty root frame.
  tree?: DesignNode
  author?: DesignAuthor
}

export interface DuplicateDesignArtboardInput {
  artboardId: string
  name?: string
  x?: number
  y?: number
}

export interface ApplyDesignOpsInput {
  artboardId: string
  ops: DesignOp[]
  origin: DesignOrigin
  // Version the client had when it generated the ops; mismatch = 409 (resync).
  baseVersion?: number
  // Humans edit as a draft and snapshot explicitly; MCP always snapshots.
  snapshot?: boolean
  summary?: string
}

export interface DesignAssetUploadInput {
  docId: string | null
  name: string
  mime: DesignAssetMime
  dataBase64: string
}

export type DesignExportFormat = 'png' | 'html' | 'jsx'

export type DesignExportScale = 1 | 2 | 3 | 4

export interface DesignExportInput {
  artboardId: string
  format: DesignExportFormat
  // PNG only. 3/4 are refused when width*height*scale² exceeds MAX_CAPTURE_PIXELS.
  scale?: DesignExportScale
}

export interface DesignExportResult {
  format: DesignExportFormat
  // png → base64; html/jsx → text.
  data: string
  width: number
  height: number
}

// ---- document-level export (PDF / PNG batch) ----

// Precedence: artboardIds > pageId > the whole document. The artboards are
// always taken in reading order (rows top to bottom, left to right).
export interface DesignExportScopeInput {
  docId: string
  pageId?: string
  artboardIds?: string[]
}

export type DesignPdfInput = DesignExportScopeInput

export interface DesignPngBatchInput extends DesignExportScopeInput {
  scale?: DesignExportScale
}

// The file never travels through IPC: the main process writes it and reports
// where it landed. 'canceled' = the human dismissed the dialog.
export interface DesignPdfResult {
  state: 'saved' | 'canceled'
  filePath: string | null
  pages: number
}

export interface DesignPngBatchResult {
  state: 'saved' | 'canceled'
  dirPath: string | null
  // File names written into dirPath, in reading order.
  files: string[]
}

export interface DesignAskInput {
  sessionId: string
  prompt: string
  // false = only inserts into the session composer for the human to review.
  submit: boolean
}

// ---- API exposed by the preload (`design` key of Api) ----

export interface DesignApi {
  // design:documents-list
  documentsList(filter?: DesignListFilter): Promise<DesignDocumentMeta[]>
  // design:document-get — pages + artboards + links.
  documentGet(id: string): Promise<DesignDocument | null>
  // design:document-create — creates the document with 1 empty page.
  documentCreate(input: CreateDesignDocumentInput): Promise<DesignDocument>
  // design:document-update — title/tokens/fonts/globalCss.
  documentUpdate(input: UpdateDesignDocumentInput): Promise<DesignDocument>
  // design:document-archive
  documentArchive(id: string): Promise<DesignDocument>
  // design:document-unarchive
  documentUnarchive(id: string): Promise<DesignDocument>
  // design:document-delete
  documentDelete(id: string): Promise<void>
  // design:page-create
  pageCreate(input: CreateDesignPageInput): Promise<DesignPage>
  // design:page-update
  pageUpdate(input: UpdateDesignPageInput): Promise<DesignPage>
  // design:page-delete
  pageDelete(id: string): Promise<void>
  // design:artboard-create
  artboardCreate(input: CreateDesignArtboardInput): Promise<DesignArtboard>
  // design:artboard-duplicate
  artboardDuplicate(input: DuplicateDesignArtboardInput): Promise<DesignArtboard>
  // design:artboard-delete
  artboardDelete(id: string): Promise<void>
  // design:artboard-apply-ops — the only tree mutation path.
  artboardApplyOps(input: ApplyDesignOpsInput): Promise<ArtboardUpdatedEvent>
  // design:versions-list
  versionsList(artboardId: string): Promise<DesignVersionMeta[]>
  // design:version-get
  versionGet(artboardId: string, version: number): Promise<DesignVersion | null>
  // design:version-restore — writes a NEW version; history is never rewritten.
  versionRestore(artboardId: string, version: number): Promise<DesignArtboard>
  // design:asset-upload
  assetUpload(input: DesignAssetUploadInput): Promise<DesignAsset>
  // design:asset-list — docId null = only the shared ones.
  assetList(docId: string | null): Promise<DesignAsset[]>
  // design:asset-delete
  assetDelete(id: string): Promise<void>
  // design:link
  link(input: DesignLink): Promise<DesignLink[]>
  // design:unlink
  unlink(input: DesignLink): Promise<DesignLink[]>
  // design:selection-set — live state read by design_selection_get.
  selectionSet(input: DesignSelection): Promise<void>
  // design:active-doc-set
  activeDocSet(docId: string | null): Promise<void>
  // design:export
  export(input: DesignExportInput): Promise<DesignExportResult>
  // design:pdf-export — one artboard per page; opens a save dialog.
  pdfExport(input: DesignPdfInput): Promise<DesignPdfResult>
  // design:png-batch — one PNG per artboard into a directory the human picks.
  pngBatchExport(input: DesignPngBatchInput): Promise<DesignPngBatchResult>
  // design:ask-session — injects the prompt into a running Claude Code session.
  askSession(input: DesignAskInput): Promise<void>

  // Payload = { docId } — tokens/fonts/css changed: reload the frames.
  onDocumentUpdated(handler: (payload: unknown) => void): () => void
  // Payload = { docId }.
  onDocumentDeleted(handler: (payload: unknown) => void): () => void
  // Payload = ArtboardUpdatedEvent.
  onArtboardUpdated(handler: (payload: unknown) => void): () => void
  // Payload = { docId, artboardId }.
  onArtboardDeleted(handler: (payload: unknown) => void): () => void
  // Payload = DesignAgentActivity.
  onAgentActivity(handler: (payload: unknown) => void): () => void
  // Payload = { docId, links }.
  onLinksUpdated(handler: (payload: unknown) => void): () => void
  // Payload = { docId }.
  onAssetsUpdated(handler: (payload: unknown) => void): () => void
}

// Stable selectors for the e2e (drive-app).
export const DESIGN_TESTIDS = {
  artboard: 'data-artboard',
  node: 'data-node-id',
  previewButton: 'design-preview',
} as const

export * from './design-presets'
export * from './design-motion'
