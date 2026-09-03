// Store-side execution of the keymap actions. Everything that needs rects
// asks the artboard bridge and then commits ops from draw-tools.

import { getBridge, getNodeIndex, useDesignStore, type DesignState } from '@/store/designStore'
import { cloneWithNewIds } from '@shared/design/ops'
import type { Rect } from '@shared/design/protocol'
import type { DesignNode, DesignOp } from '@shared/types/design'
import type { IndexEntry } from '@/store/designStore.types'
import type { ZoomTarget } from './shortcuts-map'
import {
  DUPLICATE_OFFSET,
  alignBounds,
  parsePx,
  planAlign,
  planNudge,
  planToggleAutoLayout,
  planUnwrap,
  planWrapInFrame,
  planZOrder,
  type AlignMode,
  type PlacedNode,
  type ZOrderDirection,
} from './draw-tools'

const ZOOM_STEP = 1.25

interface Selected extends IndexEntry {
  id: string
  parentId: string
  index: number
}

// The artboard shortcuts act on: the selected one, else the only one on the page.
export function activeArtboardId(state: DesignState): string | null {
  if (state.selection.artboardId) return state.selection.artboardId
  const onPage = Object.values(state.artboards).filter((a) => a.meta.pageId === state.pageId)
  return onPage.length === 1 ? onPage[0].meta.id : null
}

// Selected nodes that can be edited: not the root, not locked, in document
// order of the layer tree is not guaranteed — callers sort when it matters.
export function editableSelection(
  state: DesignState,
): { artboardId: string; nodes: Selected[] } | null {
  const artboardId = state.selection.artboardId
  if (!artboardId) return null
  const index = getNodeIndex(artboardId)
  if (!index) return null
  const nodes: Selected[] = []
  for (const id of state.selection.nodeIds) {
    const entry = index.get(id)
    if (!entry || entry.parentId === null) continue
    if (entry.node.locked || state.lockedIds[id]) continue
    const parent = index.get(entry.parentId)?.node
    if (!parent) continue
    nodes.push({
      ...entry,
      id,
      parentId: entry.parentId,
      index: parent.children.indexOf(entry.node),
    })
  }
  return nodes.length ? { artboardId, nodes } : null
}

// Rects in parent-local px for each node (bridge rects are artboard-local).
async function placedNodes(artboardId: string, nodes: readonly Selected[]): Promise<PlacedNode[]> {
  const bridge = getBridge(artboardId)
  if (!bridge) return []
  const ids = [...new Set([...nodes.map((n) => n.id), ...nodes.map((n) => n.parentId)])]
  const rects = await bridge.getRects(ids)
  const zero: Rect = { x: 0, y: 0, w: 0, h: 0 }
  return nodes.map((n) => {
    const own = rects[n.id] ?? zero
    const parent = rects[n.parentId] ?? zero
    return {
      node: n.node,
      rect: { x: own.x - parent.x, y: own.y - parent.y, w: own.w, h: own.h },
    }
  })
}

async function parentRect(artboardId: string, parentId: string): Promise<Rect> {
  const bridge = getBridge(artboardId)
  const rect = bridge ? (await bridge.getRects([parentId]))[parentId] : undefined
  return rect ?? { x: 0, y: 0, w: 0, h: 0 }
}

// Highest index first, so inserting/removing siblings never shifts the
// indexes still to be processed.
function byIndexDesc(nodes: readonly Selected[]): Selected[] {
  return [...nodes].sort((a, b) => b.index - a.index)
}

export function offsetClone(node: DesignNode, delta: number): DesignNode {
  const left = parsePx(node.style.left)
  const top = parsePx(node.style.top)
  if (node.style.position !== 'absolute' || left === null || top === null) return node
  return {
    ...node,
    style: {
      ...node.style,
      left: `${left + delta}px`,
      top: `${top + delta}px`,
    },
  }
}

// ---- actions ----

export function deleteSelection(state: DesignState): void {
  const sel = editableSelection(state)
  if (!sel) return
  state.commit(sel.artboardId, [{ type: 'remove', ids: sel.nodes.map((n) => n.id) }], {
    summary: `Delete ${sel.nodes.length} node(s)`,
  })
  state.select(sel.artboardId, [])
}

export function duplicateSelection(state: DesignState): void {
  const sel = editableSelection(state)
  if (!sel) return
  const ops: DesignOp[] = []
  const newIds: string[] = []
  for (const n of byIndexDesc(sel.nodes)) {
    const { node } = cloneWithNewIds(n.node)
    ops.push({
      type: 'insert',
      parentId: n.parentId,
      index: n.index + 1,
      node: offsetClone(node, DUPLICATE_OFFSET),
    })
    newIds.push(node.id)
  }
  state.commit(sel.artboardId, ops, { summary: 'Duplicate' })
  state.select(sel.artboardId, newIds)
}

export async function groupSelection(state: DesignState): Promise<void> {
  const sel = editableSelection(state)
  if (!sel) return
  // A group is one frame in one parent: siblings of the first selected node.
  const parentId = sel.nodes[0].parentId
  const siblings = sel.nodes.filter((n) => n.parentId === parentId)
  const items = await placedNodes(sel.artboardId, siblings)
  if (!items.length) return
  const index = Math.min(...siblings.map((n) => n.index))
  const { ops, newId } = planWrapInFrame(parentId, items, index)
  state.commit(sel.artboardId, ops, { summary: 'Group' })
  state.select(sel.artboardId, [newId])
}

export function ungroupSelection(state: DesignState): void {
  const sel = editableSelection(state)
  if (!sel) return
  const frames = byIndexDesc(sel.nodes.filter((n) => n.node.kind === 'frame'))
  if (!frames.length) return
  const ops = frames.flatMap((f) => planUnwrap(f.node, f.parentId, f.index))
  const childIds = frames.flatMap((f) => f.node.children.map((c) => c.id))
  state.commit(sel.artboardId, ops, { summary: 'Ungroup' })
  state.select(sel.artboardId, childIds)
}

export function toggleAutoLayout(state: DesignState): void {
  const sel = editableSelection(state)
  if (!sel) return
  state.commit(
    sel.artboardId,
    sel.nodes.map((n) => planToggleAutoLayout(n.node)),
    { summary: 'Toggle auto-layout' },
  )
}

export function reorderSelection(state: DesignState, dir: ZOrderDirection): void {
  const sel = editableSelection(state)
  if (!sel) return
  const index = getNodeIndex(sel.artboardId)
  const ops: DesignOp[] = []
  for (const n of sel.nodes) {
    const count = index?.get(n.parentId)?.node.children.length ?? 0
    const op = planZOrder({ id: n.id, parentId: n.parentId, index: n.index }, dir, count)
    if (op) ops.push(op)
  }
  if (ops.length) state.commit(sel.artboardId, ops, { summary: `Z-order ${dir}` })
}

export async function alignSelection(state: DesignState, mode: AlignMode): Promise<void> {
  const sel = editableSelection(state)
  if (!sel) return
  const items = await placedNodes(sel.artboardId, sel.nodes)
  if (!items.length) return
  const bounds = alignBounds(items, await parentRect(sel.artboardId, sel.nodes[0].parentId))
  const ops = planAlign(items, mode, bounds)
  if (ops.length) state.commit(sel.artboardId, ops, { summary: `Align ${mode}` })
}

export async function nudgeSelection(state: DesignState, dx: number, dy: number): Promise<void> {
  const sel = editableSelection(state)
  if (!sel) return
  const items = await placedNodes(sel.artboardId, sel.nodes)
  const ops = planNudge(items, dx, dy)
  if (!ops.length) return
  // Repeated arrow presses fold into one undo entry.
  const key = `nudge:${sel.artboardId}:${sel.nodes.map((n) => n.id).join(',')}`
  state.commit(sel.artboardId, ops, { coalesceKey: key, summary: 'Nudge' })
}

export function zoom(state: DesignState, to: ZoomTarget): void {
  switch (to) {
    case 'fit':
      state.fitToContent()
      return
    case 'selection':
      void state.fitToSelection()
      return
    case 'reset':
      // 100% around what the user is working on, not the stage center.
      void state.fitToSelection(1)
      return
    case 'in':
      state.zoomTo(state.viewport.zoom * ZOOM_STEP)
      return
    case 'out':
      state.zoomTo(state.viewport.zoom / ZOOM_STEP)
  }
}

// Enter: dive into the selected container (first child selected).
// Esc: leave interaction mode first; else climb one level, or clear the
// selection at the top.
export function changeScope(state: DesignState, dir: 'enter' | 'exit'): void {
  if (dir === 'exit' && state.interaction) {
    state.setInteraction(false)
    return
  }
  const { artboardId, nodeIds } = state.selection
  if (!artboardId) return
  const index = getNodeIndex(artboardId)
  if (!index) return
  if (dir === 'enter') {
    if (nodeIds.length !== 1) return
    const node = index.get(nodeIds[0])?.node
    if (!node || node.children.length === 0) return
    state.setScope(node.id)
    state.select(artboardId, [node.children[0].id])
    return
  }
  if (state.scopeId) {
    const scope = index.get(state.scopeId)
    const parentId = scope?.parentId ?? null
    const parentIsRoot = parentId !== null && index.get(parentId)?.parentId === null
    state.select(artboardId, [state.scopeId])
    state.setScope(parentId === null || parentIsRoot ? null : parentId)
    return
  }
  if (nodeIds.length) state.select(artboardId, [])
}

// Cmd+A: every child of the current scope (or of the root).
export function selectSiblings(state: DesignState): void {
  const artboardId = activeArtboardId(state)
  if (!artboardId) return
  const index = getNodeIndex(artboardId)
  const tree = state.artboards[artboardId]?.tree
  if (!index || !tree) return
  const parent = state.scopeId ? index.get(state.scopeId)?.node : tree
  if (!parent) return
  state.select(
    artboardId,
    parent.children.filter((c) => !c.hidden).map((c) => c.id),
  )
}

// Cmd+Enter outside an edit: start editing the selected text node. Inside an
// edit the runtime commits on Enter itself.
export function editSelectedText(state: DesignState): void {
  if (state.textEditing) return
  const { artboardId, nodeIds } = state.selection
  if (!artboardId || nodeIds.length !== 1) return
  const node = getNodeIndex(artboardId)?.get(nodeIds[0])?.node
  if (node?.kind !== 'text' || node.locked || state.lockedIds[node.id]) return
  state.startTextEdit(artboardId, node.id)
}

export function currentState(): DesignState {
  return useDesignStore.getState()
}
