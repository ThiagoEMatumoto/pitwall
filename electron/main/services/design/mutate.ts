// The only write path for artboard trees. IPC (human) and MCP (agent) both
// land here so that persistence, version bumping and the realtime broadcast
// stay in one place — a mutation that skips this module never reaches the
// canvas of the other party.

import * as designStore from './design-store'
import { parseHtml, sanitizeTree } from './html-parse'
import { broadcast as notifyBroadcast, type Broadcast } from '../notify'
import {
  applyOps,
  findNode,
  cloneWithNewIds,
  validateTree,
  type ArtboardPatch,
} from '../../../../shared/design/ops'
import { clampArtboardSize } from '../../../../shared/design/safety'
import type {
  ArtboardUpdatedEvent,
  DesignArtboard,
  DesignAuthor,
  DesignNode,
  DesignNodeLink,
  DesignOp,
  DesignOrigin,
} from '../../../../shared/types/design'

export const VERSION_CONFLICT_CODE = 'DESIGN_VERSION_CONFLICT'

// The message starts with the code because ipcMain.handle only forwards
// `message` to the renderer; the store checks the prefix to trigger a resync.
export class DesignVersionConflictError extends Error {
  code = VERSION_CONFLICT_CODE
  constructor(artboardId: string, expected: number, actual: number) {
    super(
      `${VERSION_CONFLICT_CODE}: artboard ${artboardId} is at v${actual}, client had v${expected}`,
    )
    this.name = 'DesignVersionConflictError'
  }
}

export interface MutationContext {
  author: DesignAuthor
  origin: DesignOrigin
  // Tests spy on the broadcast; production uses notify.broadcast.
  send?: Broadcast
}

export interface ApplyArtboardOpsParams extends MutationContext {
  artboardId: string
  ops: DesignOp[]
  baseVersion?: number
  snapshot?: boolean
  summary?: string
}

export interface ApplyResult {
  event: ArtboardUpdatedEvent
  artboard: DesignArtboard
}

function loadArtboard(artboardId: string): {
  artboard: DesignArtboard
  docId: string
} {
  const artboard = designStore.getArtboard(artboardId)
  if (!artboard) throw new Error(`design artboard not found: ${artboardId}`)
  const docId = designStore.getArtboardDocumentId(artboardId)!
  return { artboard, docId }
}

// Subtrees arriving over IPC/MCP are the one place untrusted structure enters
// the store: sanitize them before they touch the tree. The other ops only
// patch existing nodes and are covered by validateTree below.
function sanitizeOp(op: DesignOp): DesignOp {
  if (op.type === 'insert') return { ...op, node: sanitizeTree(op.node).tree }
  if (op.type === 'replaceTree') return { ...op, tree: sanitizeTree(op.tree).tree }
  return op
}

function clampPatch(patch: ArtboardPatch): ArtboardPatch {
  const next = { ...patch }
  if (next.width !== undefined) next.width = clampArtboardSize(next.width)
  if (next.height !== undefined) next.height = clampArtboardSize(next.height)
  return next
}

export function applyArtboardOps(params: ApplyArtboardOpsParams): ApplyResult {
  const { artboard, docId } = loadArtboard(params.artboardId)
  if (params.baseVersion !== undefined && params.baseVersion !== artboard.version) {
    throw new DesignVersionConflictError(params.artboardId, params.baseVersion, artboard.version)
  }

  const artboardPatch: ArtboardPatch = {}
  const treeOps: DesignOp[] = []
  for (const op of params.ops) {
    if (op.type === 'setArtboard') Object.assign(artboardPatch, clampPatch(op.patch))
    else treeOps.push(sanitizeOp(op))
  }

  const { tree } = applyOps(artboard.tree, treeOps)
  const errors = validateTree(tree)
  if (errors.length > 0) throw new Error(`invalid design tree: ${errors.join('; ')}`)

  if (Object.keys(artboardPatch).length > 0)
    designStore.updateArtboard(params.artboardId, artboardPatch)
  // setTree always bumps `version`, even for a setArtboard-only change: the
  // renderer orders every event of an artboard by that single counter.
  const saved = designStore.setTree(params.artboardId, tree, {
    snapshot: params.snapshot ?? false,
    author: params.author,
    summary: params.summary,
  })

  const event: ArtboardUpdatedEvent = {
    docId,
    artboardId: params.artboardId,
    ops: params.ops,
    version: saved.version,
    origin: params.origin,
    full: params.ops.some((op) => op.type === 'replaceTree'),
  }
  ;(params.send ?? notifyBroadcast)('design:artboard-updated', event)
  return { event, artboard: saved }
}

export interface RestoreVersionParams extends MutationContext {
  artboardId: string
  version: number
}

export function restoreArtboardVersion(params: RestoreVersionParams): ApplyResult {
  const { docId } = loadArtboard(params.artboardId)
  const snapshot = designStore.getVersion(params.artboardId, params.version)
  if (!snapshot)
    throw new Error(`design version not found: ${params.artboardId} v${params.version}`)
  // Snapshots written before the current rules may carry what is refused now.
  const artboard = designStore.setTree(params.artboardId, sanitizeTree(snapshot.tree).tree, {
    snapshot: true,
    author: params.author,
    summary: `restore version ${params.version}`,
  })
  const event: ArtboardUpdatedEvent = {
    docId,
    artboardId: params.artboardId,
    ops: [{ type: 'replaceTree', tree: artboard.tree }],
    version: artboard.version,
    origin: params.origin,
    full: true,
  }
  ;(params.send ?? notifyBroadcast)('design:artboard-updated', event)
  return { event, artboard }
}

// ---- HTML in ----

export interface WriteHtmlParams extends MutationContext {
  artboardId: string
  html: string
  mode: 'replace' | 'insert'
  parentId?: string
  index?: number
  snapshot?: boolean
  summary?: string
}

export interface WriteHtmlResult extends ApplyResult {
  warnings: string[]
  // Ids of the nodes the HTML produced (root children on replace).
  nodeIds: string[]
}

function isSizedFrame(node: DesignNode): boolean {
  return node.kind === 'frame' && Boolean(node.style.width) && Boolean(node.style.height)
}

// A document-level <style> or Google Font link in the HTML belongs to the
// document, not the artboard: merge it in so every artboard sees it.
function absorbDocumentCss(
  docId: string,
  globalCss: string,
  fonts: string[],
  send: Broadcast,
): void {
  if (!globalCss && fonts.length === 0) return
  const doc = designStore.getDocument(docId)!
  const nextFonts = [...doc.fonts, ...fonts.filter((f) => !doc.fonts.includes(f))]
  const cssAlreadyThere = globalCss !== '' && doc.globalCss.includes(globalCss)
  const nextCss =
    cssAlreadyThere || !globalCss ? doc.globalCss : `${doc.globalCss}\n${globalCss}`.trim()
  if (nextFonts.length === doc.fonts.length && nextCss === doc.globalCss) return
  designStore.updateDocument({
    id: docId,
    fonts: nextFonts,
    globalCss: nextCss,
  })
  send('design:document-updated', { docId })
}

export function writeHtml(params: WriteHtmlParams): WriteHtmlResult {
  const { artboard, docId } = loadArtboard(params.artboardId)
  const parsed = parseHtml(params.html)
  const send = params.send ?? notifyBroadcast
  absorbDocumentCss(docId, parsed.globalCss, parsed.fonts, send)

  let ops: DesignOp[]
  let nodeIds: string[]
  if (params.mode === 'replace') {
    const single = parsed.nodes.length === 1 ? parsed.nodes[0] : null
    // A single sized frame IS the artboard; anything else hangs under a
    // fresh default root. The root id survives so selections keep pointing
    // at "the artboard".
    const tree: DesignNode =
      single && isSizedFrame(single)
        ? { ...single, id: artboard.tree.id }
        : {
            ...designStore.defaultTree(),
            id: artboard.tree.id,
            children: parsed.nodes,
          }
    ops = [{ type: 'replaceTree', tree }]
    nodeIds = tree.children.map((n) => n.id)
  } else {
    const parentId = params.parentId ?? artboard.tree.id
    const parent = findNode(artboard.tree, parentId)
    if (!parent) throw new Error(`node not found: ${parentId}`)
    const start = params.index ?? parent.node.children.length
    ops = parsed.nodes.map((node, i) => ({
      type: 'insert',
      parentId,
      index: start + i,
      node,
    }))
    nodeIds = parsed.nodes.map((n) => n.id)
  }

  const result = applyArtboardOps({
    artboardId: params.artboardId,
    ops,
    author: params.author,
    origin: params.origin,
    snapshot: params.snapshot,
    summary: params.summary,
    send,
  })
  return { ...result, warnings: parsed.warnings, nodeIds }
}

// ---- Fine-grained helpers (thin wrappers so callers never build ops) ----

interface NodeTarget extends MutationContext {
  artboardId: string
  summary?: string
}

export function duplicateNodes(
  params: NodeTarget & { ids: string[]; parentId?: string; index?: number },
): ApplyResult & { idMap: Record<string, string> } {
  const { artboard } = loadArtboard(params.artboardId)
  const idMap: Record<string, string> = {}
  const ops: DesignOp[] = []
  let offset = 0
  for (const id of params.ids) {
    const found = findNode(artboard.tree, id)
    if (!found || !found.parent) throw new Error(`node not found or is the root: ${id}`)
    const clone = cloneWithNewIds(found.node)
    Object.assign(idMap, clone.idMap)
    const parentId = params.parentId ?? found.parent.id
    // Default: right after the original, keeping the source order for batches.
    const index = params.index !== undefined ? params.index + offset : found.index + 1 + offset
    ops.push({ type: 'insert', parentId, index, node: clone.node })
    offset += 1
  }
  return { ...applyArtboardOps({ ...params, ops }), idMap }
}

export function moveNodes(
  params: NodeTarget & { ids: string[]; parentId: string; index: number },
): ApplyResult {
  return applyArtboardOps({
    ...params,
    ops: [
      {
        type: 'move',
        ids: params.ids,
        parentId: params.parentId,
        index: params.index,
      },
    ],
  })
}

export function deleteNodes(params: NodeTarget & { ids: string[] }): ApplyResult {
  return applyArtboardOps({
    ...params,
    ops: [{ type: 'remove', ids: params.ids }],
  })
}

export function renameNodes(
  params: NodeTarget & { items: Array<{ id: string; name: string }> },
): ApplyResult {
  return applyArtboardOps({
    ...params,
    ops: params.items.map((item) => ({
      type: 'rename',
      id: item.id,
      name: item.name,
    })),
  })
}

export function setText(params: NodeTarget & { nodeId: string; text: string }): ApplyResult {
  return applyArtboardOps({
    ...params,
    ops: [{ type: 'setText', id: params.nodeId, text: params.text }],
  })
}

export function updateStyles(
  params: NodeTarget & {
    items: Array<{ id: string; style: Record<string, string | null> }>
  },
): ApplyResult {
  return applyArtboardOps({
    ...params,
    ops: params.items.map((item) => ({
      type: 'setStyle',
      id: item.id,
      patch: item.style,
    })),
  })
}

export function setNodeLink(
  params: NodeTarget & { nodeId: string; link: DesignNodeLink | null },
): ApplyResult {
  const { artboard } = loadArtboard(params.artboardId)
  const found = findNode(artboard.tree, params.nodeId)
  if (!found || !found.parent) throw new Error(`node not found or is the root: ${params.nodeId}`)
  return applyArtboardOps({
    ...params,
    ops: [{ type: 'setLink', id: params.nodeId, link: params.link }],
  })
}
