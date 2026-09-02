import { ipcMain } from 'electron'
import * as designStore from '../services/design/design-store'
import * as assetStore from '../services/design/asset-store'
import * as liveState from '../services/design/live-state'
import { applyArtboardOps, restoreArtboardVersion } from '../services/design/mutate'
import { exportArtboardHtml, exportArtboardJsx, exportArtboardPng } from '../services/design/export'
import { formatPtyInjection, injectIntoSession } from '../services/handoff/inject'
import { ptyManager } from '../services/pty-manager'
import { broadcast } from '../services/notify'
import { newNonce } from '../../../shared/design/ids'
import { MAX_ASSET_BASE64_CHARS } from '../../../shared/design/safety'
import type {
  ApplyDesignOpsInput,
  ArtboardUpdatedEvent,
  CreateDesignArtboardInput,
  CreateDesignDocumentInput,
  CreateDesignPageInput,
  DesignArtboard,
  DesignAskInput,
  DesignAsset,
  DesignAssetUploadInput,
  DesignDocument,
  DesignDocumentMeta,
  DesignExportInput,
  DesignExportResult,
  DesignLink,
  DesignListFilter,
  DesignPage,
  DesignSelection,
  DesignVersion,
  DesignVersionMeta,
  DuplicateDesignArtboardInput,
  UpdateDesignDocumentInput,
  UpdateDesignPageInput,
} from '../../../shared/types/design'

// Design Studio IPC. Thin handlers (rules live in the stores / mutate.ts) and
// a broadcast on every mutation so the renderer — and any other window —
// reloads through the same channels the MCP tools emit on.
//
// Channel names are the ones electron/preload/index.ts invokes; the comments
// on DesignApi in shared/types/design.ts are the contract.

// ---- argument guards ----
// The renderer is trusted but not infallible: a stale store can send an
// undefined id or a NaN version, and those must fail here with a readable
// message instead of deep inside a SQL statement.

const MAX_ID_CHARS = 200
const MAX_PROMPT_CHARS = 8 * 1024
const EXPORT_FORMATS: ReadonlySet<string> = new Set(['png', 'html', 'jsx'])

function requireId(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_ID_CHARS) {
    throw new Error(`${label} must be a non-empty string`)
  }
  return value
}

function optionalId(value: unknown, label: string): string | null {
  return value === null || value === undefined ? null : requireId(value, label)
}

function requireVersion(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new Error('version must be a positive integer')
  }
  return value
}

function requireInput<T extends object>(value: unknown, label: string): T {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  return value as T
}

function docUpdated(docId: string): void {
  broadcast('design:document-updated', { docId })
}

function humanOrigin(sessionId: string | null = null) {
  return { kind: 'human' as const, sessionId, nonce: newNonce() }
}

export function registerDesignIpc(): void {
  // ---- documents ----

  ipcMain.handle('design:documents-list', (_e, filter?: DesignListFilter): DesignDocumentMeta[] => {
    return designStore.listDocuments(filter)
  })

  ipcMain.handle('design:document-get', (_e, id: unknown): DesignDocument | null => {
    return designStore.getDocument(requireId(id, 'id'))
  })

  ipcMain.handle('design:document-create', (_e, raw: unknown): DesignDocument => {
    const input = requireInput<CreateDesignDocumentInput>(raw, 'input')
    const doc = designStore.createDocument(input)
    docUpdated(doc.id)
    return doc
  })

  ipcMain.handle('design:document-update', (_e, raw: unknown): DesignDocument => {
    const input = requireInput<UpdateDesignDocumentInput>(raw, 'input')
    requireId(input.id, 'id')
    const doc = designStore.updateDocument(input)
    docUpdated(doc.id)
    return doc
  })

  ipcMain.handle('design:document-archive', (_e, rawId: unknown): DesignDocument => {
    const id = requireId(rawId, 'id')
    const doc = designStore.archiveDocument(id)
    docUpdated(id)
    return doc
  })

  ipcMain.handle('design:document-unarchive', (_e, rawId: unknown): DesignDocument => {
    const id = requireId(rawId, 'id')
    const doc = designStore.unarchiveDocument(id)
    docUpdated(id)
    return doc
  })

  ipcMain.handle('design:document-delete', (_e, rawId: unknown): void => {
    const id = requireId(rawId, 'id')
    designStore.removeDocument(id)
    liveState.clearActivity(id)
    if (liveState.getActiveDoc() === id) liveState.setActiveDoc(null)
    broadcast('design:document-deleted', { docId: id })
  })

  // ---- pages ----

  ipcMain.handle('design:page-create', (_e, raw: unknown): DesignPage => {
    const input = requireInput<CreateDesignPageInput>(raw, 'input')
    requireId(input.docId, 'docId')
    const page = designStore.createPage(input)
    docUpdated(page.documentId)
    return page
  })

  ipcMain.handle('design:page-update', (_e, raw: unknown): DesignPage => {
    const input = requireInput<UpdateDesignPageInput>(raw, 'input')
    requireId(input.id, 'id')
    const page = designStore.updatePage(input)
    // Viewport is per-page UI state: broadcasting it would make every other
    // window jump. Only name/position are shared shape.
    if (input.name !== undefined || input.position !== undefined) docUpdated(page.documentId)
    return page
  })

  ipcMain.handle('design:page-delete', (_e, rawId: unknown): void => {
    const id = requireId(rawId, 'id')
    const page = designStore.getPage(id)
    if (!page) throw new Error(`design page not found: ${id}`)
    designStore.removePage(id)
    docUpdated(page.documentId)
  })

  // ---- artboards ----

  ipcMain.handle('design:artboard-create', (_e, raw: unknown): DesignArtboard => {
    const input = requireInput<CreateDesignArtboardInput>(raw, 'input')
    requireId(input.docId, 'docId')
    const artboard = designStore.createArtboard({
      ...input,
      author: input.author ?? 'human',
    })
    docUpdated(input.docId)
    return artboard
  })

  ipcMain.handle('design:artboard-duplicate', (_e, raw: unknown): DesignArtboard => {
    const input = requireInput<DuplicateDesignArtboardInput>(raw, 'input')
    requireId(input.artboardId, 'artboardId')
    const artboard = designStore.duplicateArtboard(input)
    docUpdated(designStore.getArtboardDocumentId(artboard.id)!)
    return artboard
  })

  ipcMain.handle('design:artboard-delete', (_e, rawId: unknown): void => {
    const id = requireId(rawId, 'id')
    const docId = designStore.getArtboardDocumentId(id)
    if (!docId) throw new Error(`design artboard not found: ${id}`)
    designStore.removeArtboard(id)
    liveState.clearActivity(docId, { artboardId: id })
    broadcast('design:artboard-deleted', { docId, artboardId: id })
  })

  // author 'human': this channel is the UI's. The MCP path declares 'claude'.
  // A baseVersion mismatch surfaces as an Error whose message starts with
  // DESIGN_VERSION_CONFLICT — the store resyncs instead of retrying.
  ipcMain.handle('design:artboard-apply-ops', (_e, raw: unknown): ArtboardUpdatedEvent => {
    const input = requireInput<ApplyDesignOpsInput>(raw, 'input')
    requireId(input.artboardId, 'artboardId')
    if (!Array.isArray(input.ops)) throw new Error('ops must be an array')
    return applyArtboardOps({
      artboardId: input.artboardId,
      ops: input.ops,
      author: 'human',
      origin: input.origin,
      baseVersion: input.baseVersion,
      snapshot: input.snapshot,
      summary: input.summary,
    }).event
  })

  // ---- versions ----

  ipcMain.handle('design:versions-list', (_e, artboardId: unknown): DesignVersionMeta[] => {
    return designStore.listVersions(requireId(artboardId, 'artboardId'))
  })

  ipcMain.handle(
    'design:version-get',
    (_e, artboardId: unknown, version: unknown): DesignVersion | null => {
      return designStore.getVersion(requireId(artboardId, 'artboardId'), requireVersion(version))
    },
  )

  ipcMain.handle(
    'design:version-restore',
    (_e, artboardId: unknown, version: unknown): DesignArtboard => {
      return restoreArtboardVersion({
        artboardId: requireId(artboardId, 'artboardId'),
        version: requireVersion(version),
        author: 'human',
        origin: humanOrigin(),
      }).artboard
    },
  )

  // ---- assets ----

  ipcMain.handle('design:asset-upload', (_e, raw: unknown): DesignAsset => {
    const input = requireInput<DesignAssetUploadInput>(raw, 'input')
    const docId = optionalId(input.docId, 'docId')
    // Length check before decoding: a huge payload must not become a Buffer.
    if (typeof input.dataBase64 !== 'string' || input.dataBase64.length > MAX_ASSET_BASE64_CHARS) {
      throw new Error(`asset exceeds ${assetStore.MAX_ASSET_BYTES} bytes`)
    }
    const asset = assetStore.upload({
      documentId: docId,
      name: String(input.name ?? ''),
      mime: input.mime,
      bytes: Buffer.from(input.dataBase64, 'base64'),
    })
    broadcast('design:assets-updated', { docId })
    return asset
  })

  ipcMain.handle('design:asset-list', (_e, docId: unknown): DesignAsset[] => {
    return assetStore.list(optionalId(docId, 'docId'))
  })

  ipcMain.handle('design:asset-delete', (_e, rawId: unknown): void => {
    const id = requireId(rawId, 'id')
    const meta = assetStore.getMeta(id)
    assetStore.remove(id)
    broadcast('design:assets-updated', { docId: meta?.documentId ?? null })
  })

  // ---- links ----

  function requireLink(raw: unknown): DesignLink {
    const input = requireInput<DesignLink>(raw, 'input')
    requireId(input.documentId, 'documentId')
    requireId(input.parentType, 'parentType')
    requireId(input.parentId, 'parentId')
    return input
  }

  ipcMain.handle('design:link', (_e, raw: unknown): DesignLink[] => {
    const input = requireLink(raw)
    const links = designStore.link(input)
    broadcast('design:links-updated', { docId: input.documentId, links })
    return links
  })

  ipcMain.handle('design:unlink', (_e, raw: unknown): DesignLink[] => {
    const input = requireLink(raw)
    const links = designStore.unlink(input)
    broadcast('design:links-updated', { docId: input.documentId, links })
    return links
  })

  // ---- live state (read by design_selection_get) ----

  ipcMain.handle('design:selection-set', (_e, raw: unknown): void => {
    const input = requireInput<DesignSelection>(raw, 'input')
    requireId(input.docId, 'docId')
    if (!Array.isArray(input.nodeIds)) throw new Error('nodeIds must be an array')
    liveState.setSelection({
      docId: input.docId,
      artboardId: optionalId(input.artboardId, 'artboardId'),
      nodeIds: input.nodeIds.filter((id): id is string => typeof id === 'string'),
    })
  })

  ipcMain.handle('design:active-doc-set', (_e, docId: unknown): void => {
    liveState.setActiveDoc(optionalId(docId, 'docId'))
  })

  // ---- export ----

  // PNG is the only format that touches the offscreen window and base64-encodes
  // a Buffer; html/jsx stay plain text.
  ipcMain.handle('design:export', async (_e, raw: unknown): Promise<DesignExportResult> => {
    const input = requireInput<DesignExportInput>(raw, 'input')
    const artboardId = requireId(input.artboardId, 'artboardId')
    if (!EXPORT_FORMATS.has(input.format)) throw new Error(`unknown export format: ${input.format}`)
    if (input.format === 'png') {
      const scale = input.scale === 2 ? 2 : 1
      const png = await exportArtboardPng({ artboardId, scale })
      return { format: 'png', data: png.pngBase64, width: png.width, height: png.height }
    }
    const text =
      input.format === 'jsx' ? exportArtboardJsx(artboardId) : exportArtboardHtml(artboardId)
    return { format: input.format, ...text }
  })

  // ---- Ask Claude ----

  // submit=false leaves the prompt in the session's composer (bracketed paste
  // without the trailing carriage return) so the human can edit before Enter.
  ipcMain.handle('design:ask-session', (_e, raw: unknown): void => {
    const input = requireInput<DesignAskInput>(raw, 'input')
    const sessionId = requireId(input.sessionId, 'sessionId')
    if (typeof input.prompt !== 'string' || input.prompt.trim().length === 0) {
      throw new Error('prompt must be a non-empty string')
    }
    if (input.prompt.length > MAX_PROMPT_CHARS) {
      throw new Error(`prompt exceeds ${MAX_PROMPT_CHARS} characters`)
    }
    if (!ptyManager.isRunning(sessionId)) {
      throw new Error(`session ${sessionId} is not running`)
    }
    if (input.submit === true) {
      injectIntoSession(sessionId, input.prompt)
      return
    }
    ptyManager.write(sessionId, formatPtyInjection(input.prompt).replace(/\r$/, ''))
  })
}
