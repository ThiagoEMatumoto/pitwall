// Cmd+C / Cmd+X / Cmd+V inside the design canvas. Copied subtrees live in
// this module (and, best effort, as JSON on the system clipboard so a paste
// still works after copying elsewhere). Paste also accepts an image file
// (uploaded as an asset) or plain text (a new text node). HTML on the
// clipboard is pasted as text: the preload exposes no write-html channel.

import { cloneWithNewIds } from '@shared/design/ops'
import type { DesignAssetMime, DesignNode, DesignOp } from '@shared/types/design'
import { designApi } from '@/lib/ipc'
import { getNodeIndex, type DesignState } from '@/store/designStore'
import { DUPLICATE_OFFSET, planInsertForTool } from './draw-tools'
import {
  activeArtboardId,
  deleteSelection,
  editableSelection,
  offsetClone,
} from './shortcut-actions'

const PAYLOAD_KIND = 'pitwall-design-nodes'
const PASTE_ORIGIN = 20
const IMAGE_MIMES = new Set<string>([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/svg+xml',
])

interface Payload {
  kind: typeof PAYLOAD_KIND
  nodes: DesignNode[]
}

let memory: DesignNode[] | null = null

function parsePayload(text: string): DesignNode[] | null {
  if (!text.startsWith('{')) return null
  try {
    const parsed = JSON.parse(text) as Partial<Payload>
    return parsed.kind === PAYLOAD_KIND && Array.isArray(parsed.nodes) ? parsed.nodes : null
  } catch {
    return null
  }
}

// Ids whose ancestor is also selected are dropped: the ancestor carries them.
function topLevel(state: DesignState): DesignNode[] {
  const sel = editableSelection(state)
  if (!sel) return []
  const index = getNodeIndex(sel.artboardId)
  const wanted = new Set(sel.nodes.map((n) => n.id))
  const hasSelectedAncestor = (id: string): boolean => {
    let parentId = index?.get(id)?.parentId ?? null
    while (parentId !== null) {
      if (wanted.has(parentId)) return true
      parentId = index?.get(parentId)?.parentId ?? null
    }
    return false
  }
  return sel.nodes.filter((n) => !hasSelectedAncestor(n.id)).map((n) => n.node)
}

export function copySelection(state: DesignState): boolean {
  const nodes = topLevel(state)
  if (!nodes.length) return false
  memory = nodes
  const payload: Payload = { kind: PAYLOAD_KIND, nodes }
  void navigator.clipboard?.writeText(JSON.stringify(payload)).catch(() => undefined)
  return true
}

export function cutSelection(state: DesignState): void {
  if (copySelection(state)) deleteSelection(state)
}

// Paste target: the current scope, else the root of the active artboard.
function pasteTarget(
  state: DesignState,
): { artboardId: string; parentId: string; index: number } | null {
  const artboardId = activeArtboardId(state)
  if (!artboardId) return null
  const index = getNodeIndex(artboardId)
  const tree = state.artboards[artboardId]?.tree
  if (!index || !tree) return null
  const parent = (state.scopeId && index.get(state.scopeId)?.node) || tree
  return { artboardId, parentId: parent.id, index: parent.children.length }
}

export function pasteNodes(state: DesignState, nodes: readonly DesignNode[]): void {
  const target = pasteTarget(state)
  if (!target) return
  const ops: DesignOp[] = []
  const ids: string[] = []
  nodes.forEach((source, i) => {
    const { node } = cloneWithNewIds(source)
    ops.push({
      type: 'insert',
      parentId: target.parentId,
      index: target.index + i,
      node: offsetClone(node, DUPLICATE_OFFSET),
    })
    ids.push(node.id)
  })
  state.commit(target.artboardId, ops, {
    summary: `Paste ${nodes.length} node(s)`,
  })
  state.select(target.artboardId, ids)
}

function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '')
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}

async function pasteImage(state: DesignState, file: File): Promise<void> {
  const target = pasteTarget(state)
  if (!target || !state.docId) return
  const asset = await designApi.assetUpload({
    docId: state.docId,
    name: file.name || 'pasted-image',
    mime: file.type as DesignAssetMime,
    dataBase64: await readAsBase64(file),
  })
  const maxW = state.artboards[target.artboardId]?.meta.width ?? Infinity
  const w = Math.min(asset.width ?? 200, maxW - PASTE_ORIGIN)
  const h = asset.width && asset.height ? (w * asset.height) / asset.width : (asset.height ?? 200)
  const { ops, newId } = planInsertForTool(
    'image',
    { x: PASTE_ORIGIN, y: PASTE_ORIGIN, w, h },
    target.parentId,
    target.index,
    { assetUrl: asset.url },
  )
  state.commit(target.artboardId, ops, {
    summary: `Paste image ${asset.name}`,
  })
  state.select(target.artboardId, [newId])
}

function pasteText(state: DesignState, text: string): void {
  const target = pasteTarget(state)
  if (!target) return
  const { ops, newId } = planInsertForTool(
    'text',
    { x: PASTE_ORIGIN, y: PASTE_ORIGIN, w: 0, h: 0 },
    target.parentId,
    target.index,
    { text },
  )
  state.commit(target.artboardId, ops, { summary: 'Paste text' })
  state.select(target.artboardId, [newId])
}

// Handles the native 'paste' event: it carries files and text without a
// clipboard permission prompt. Returns false when nothing was pasted.
export async function pasteFromEvent(
  state: DesignState,
  data: DataTransfer | null,
): Promise<boolean> {
  const file = data ? Array.from(data.files).find((f) => IMAGE_MIMES.has(f.type)) : undefined
  if (file) {
    await pasteImage(state, file)
    return true
  }
  const text = data?.getData('text/plain') ?? ''
  const nodes = parsePayload(text) ?? (text.trim() === '' ? memory : null)
  if (nodes?.length) {
    pasteNodes(state, nodes)
    return true
  }
  if (text.trim() !== '') {
    pasteText(state, text)
    return true
  }
  return false
}

export function clipboardHasNodes(): boolean {
  return memory !== null && memory.length > 0
}
