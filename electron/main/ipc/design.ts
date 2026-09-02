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

  ipcMain.handle('design:document-get', (_e, id: string): DesignDocument | null => {
    return designStore.getDocument(id)
  })

  ipcMain.handle(
    'design:document-create',
    (_e, input: CreateDesignDocumentInput): DesignDocument => {
      const doc = designStore.createDocument(input)
      docUpdated(doc.id)
      return doc
    },
  )

  ipcMain.handle(
    'design:document-update',
    (_e, input: UpdateDesignDocumentInput): DesignDocument => {
      const doc = designStore.updateDocument(input)
      docUpdated(doc.id)
      return doc
    },
  )

  ipcMain.handle('design:document-archive', (_e, id: string): DesignDocument => {
    const doc = designStore.archiveDocument(id)
    docUpdated(id)
    return doc
  })

  ipcMain.handle('design:document-unarchive', (_e, id: string): DesignDocument => {
    const doc = designStore.unarchiveDocument(id)
    docUpdated(id)
    return doc
  })

  ipcMain.handle('design:document-delete', (_e, id: string): void => {
    designStore.removeDocument(id)
    liveState.clearActivity(id)
    if (liveState.getActiveDoc() === id) liveState.setActiveDoc(null)
    broadcast('design:document-deleted', { docId: id })
  })

  // ---- pages ----

  ipcMain.handle('design:page-create', (_e, input: CreateDesignPageInput): DesignPage => {
    const page = designStore.createPage(input)
    docUpdated(page.documentId)
    return page
  })

  ipcMain.handle('design:page-update', (_e, input: UpdateDesignPageInput): DesignPage => {
    const page = designStore.updatePage(input)
    // Viewport is per-page UI state: broadcasting it would make every other
    // window jump. Only name/position are shared shape.
    if (input.name !== undefined || input.position !== undefined) docUpdated(page.documentId)
    return page
  })

  ipcMain.handle('design:page-delete', (_e, id: string): void => {
    const page = designStore.getPage(id)
    if (!page) throw new Error(`design page not found: ${id}`)
    designStore.removePage(id)
    docUpdated(page.documentId)
  })

  // ---- artboards ----

  ipcMain.handle(
    'design:artboard-create',
    (_e, input: CreateDesignArtboardInput): DesignArtboard => {
      const artboard = designStore.createArtboard({
        ...input,
        author: input.author ?? 'human',
      })
      docUpdated(input.docId)
      return artboard
    },
  )

  ipcMain.handle(
    'design:artboard-duplicate',
    (_e, input: DuplicateDesignArtboardInput): DesignArtboard => {
      const artboard = designStore.duplicateArtboard(input)
      docUpdated(designStore.getArtboardDocumentId(artboard.id)!)
      return artboard
    },
  )

  ipcMain.handle('design:artboard-delete', (_e, id: string): void => {
    const docId = designStore.getArtboardDocumentId(id)
    if (!docId) throw new Error(`design artboard not found: ${id}`)
    designStore.removeArtboard(id)
    liveState.clearActivity(docId, { artboardId: id })
    broadcast('design:artboard-deleted', { docId, artboardId: id })
  })

  // author 'human': this channel is the UI's. The MCP path declares 'claude'.
  // A baseVersion mismatch surfaces as an Error whose message starts with
  // DESIGN_VERSION_CONFLICT — the store resyncs instead of retrying.
  ipcMain.handle(
    'design:artboard-apply-ops',
    (_e, input: ApplyDesignOpsInput): ArtboardUpdatedEvent => {
      return applyArtboardOps({
        artboardId: input.artboardId,
        ops: input.ops,
        author: 'human',
        origin: input.origin,
        baseVersion: input.baseVersion,
        snapshot: input.snapshot,
        summary: input.summary,
      }).event
    },
  )

  // ---- versions ----

  ipcMain.handle('design:versions-list', (_e, artboardId: string): DesignVersionMeta[] => {
    return designStore.listVersions(artboardId)
  })

  ipcMain.handle(
    'design:version-get',
    (_e, artboardId: string, version: number): DesignVersion | null => {
      return designStore.getVersion(artboardId, version)
    },
  )

  ipcMain.handle(
    'design:version-restore',
    (_e, artboardId: string, version: number): DesignArtboard => {
      return restoreArtboardVersion({
        artboardId,
        version,
        author: 'human',
        origin: humanOrigin(),
      }).artboard
    },
  )

  // ---- assets ----

  ipcMain.handle('design:asset-upload', (_e, input: DesignAssetUploadInput): DesignAsset => {
    const asset = assetStore.upload({
      documentId: input.docId,
      name: input.name,
      mime: input.mime,
      bytes: Buffer.from(input.dataBase64, 'base64'),
    })
    broadcast('design:assets-updated', { docId: input.docId })
    return asset
  })

  ipcMain.handle('design:asset-list', (_e, docId: string | null): DesignAsset[] => {
    return assetStore.list(docId)
  })

  ipcMain.handle('design:asset-delete', (_e, id: string): void => {
    const meta = assetStore.getMeta(id)
    assetStore.remove(id)
    broadcast('design:assets-updated', { docId: meta?.documentId ?? null })
  })

  // ---- links ----

  ipcMain.handle('design:link', (_e, input: DesignLink): DesignLink[] => {
    const links = designStore.link(input)
    broadcast('design:links-updated', { docId: input.documentId, links })
    return links
  })

  ipcMain.handle('design:unlink', (_e, input: DesignLink): DesignLink[] => {
    const links = designStore.unlink(input)
    broadcast('design:links-updated', { docId: input.documentId, links })
    return links
  })

  // ---- live state (read by design_selection_get) ----

  ipcMain.handle('design:selection-set', (_e, input: DesignSelection): void => {
    liveState.setSelection(input)
  })

  ipcMain.handle('design:active-doc-set', (_e, docId: string | null): void => {
    liveState.setActiveDoc(docId)
  })

  // ---- export ----

  ipcMain.handle(
    'design:export',
    async (_e, input: DesignExportInput): Promise<DesignExportResult> => {
      if (input.format === 'png') {
        const png = await exportArtboardPng({
          artboardId: input.artboardId,
          scale: input.scale,
        })
        return {
          format: 'png',
          data: png.pngBase64,
          width: png.width,
          height: png.height,
        }
      }
      const text =
        input.format === 'jsx'
          ? exportArtboardJsx(input.artboardId)
          : exportArtboardHtml(input.artboardId)
      return { format: input.format, ...text }
    },
  )

  // ---- Ask Claude ----

  // submit=false leaves the prompt in the session's composer (bracketed paste
  // without the trailing carriage return) so the human can edit before Enter.
  ipcMain.handle('design:ask-session', (_e, input: DesignAskInput): void => {
    if (!ptyManager.isRunning(input.sessionId)) {
      throw new Error(`session ${input.sessionId} is not running`)
    }
    if (input.submit) {
      injectIntoSession(input.sessionId, input.prompt)
      return
    }
    ptyManager.write(input.sessionId, formatPtyInjection(input.prompt).replace(/\r$/, ''))
  })
}
