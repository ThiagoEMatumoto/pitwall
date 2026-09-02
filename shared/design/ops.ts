// Pure, immutable ops over the artboard tree. Runs in main (mutate.ts),
// renderer (designStore) and the iframe runtime, so no DOM/electron here.
// Every function returns a new tree; the input is never mutated.

import type { DesignArtboard, DesignNode, DesignNodeKind, DesignNodeSummary, DesignOp } from '../types/design'
import { newNodeId } from './ids'

export interface FoundNode {
  node: DesignNode
  parent: DesignNode | null
  // -1 for the root (it has no sibling list).
  index: number
}

export interface IndexEntry {
  node: DesignNode
  parentId: string | null
}

export type ArtboardPatch = Partial<Pick<DesignArtboard, 'x' | 'y' | 'width' | 'height' | 'name'>>

const KINDS: ReadonlySet<DesignNodeKind> = new Set(['frame', 'text', 'image', 'svg', 'element'])
const FORBIDDEN_TAGS = new Set(['script', 'iframe', 'object', 'embed'])
const SUMMARY_TEXT_MAX = 60

// ---- Traversal ----

// Return false from fn to stop the whole walk.
export function walk(
  tree: DesignNode,
  fn: (node: DesignNode, depth: number, parent: DesignNode | null) => boolean | void,
): void {
  const visit = (node: DesignNode, depth: number, parent: DesignNode | null): boolean => {
    if (fn(node, depth, parent) === false) return false
    for (const child of node.children) {
      if (!visit(child, depth + 1, node)) return false
    }
    return true
  }
  visit(tree, 0, null)
}

export function buildIndex(tree: DesignNode): Map<string, IndexEntry> {
  const index = new Map<string, IndexEntry>()
  walk(tree, (node, _depth, parent) => {
    index.set(node.id, { node, parentId: parent ? parent.id : null })
  })
  return index
}

export function findNode(tree: DesignNode, id: string): FoundNode | null {
  if (tree.id === id) return { node: tree, parent: null, index: -1 }
  let found: FoundNode | null = null
  walk(tree, (node) => {
    const index = node.children.findIndex((child) => child.id === id)
    if (index === -1) return
    found = { node: node.children[index], parent: node, index }
    return false
  })
  return found
}

function requireNode(tree: DesignNode, id: string): FoundNode {
  const found = findNode(tree, id)
  if (!found) throw new Error(`node not found: ${id}`)
  return found
}

// ---- Immutable helpers ----

function updateAt(tree: DesignNode, id: string, fn: (node: DesignNode) => DesignNode): DesignNode {
  const replace = (node: DesignNode): DesignNode | null => {
    if (node.id === id) return fn(node)
    for (let i = 0; i < node.children.length; i++) {
      const next = replace(node.children[i])
      if (next) {
        const children = node.children.slice()
        children[i] = next
        return { ...node, children }
      }
    }
    return null
  }
  const next = replace(tree)
  if (!next) throw new Error(`node not found: ${id}`)
  return next
}

function removeIds(node: DesignNode, ids: ReadonlySet<string>): DesignNode {
  let changed = false
  const children = node.children
    .filter((child) => {
      if (ids.has(child.id)) changed = true
      return !ids.has(child.id)
    })
    .map((child) => {
      const next = removeIds(child, ids)
      if (next !== child) changed = true
      return next
    })
  return changed ? { ...node, children } : node
}

function insertAt<T>(list: readonly T[], index: number, items: readonly T[]): T[] {
  const at = Math.max(0, Math.min(index, list.length))
  return [...list.slice(0, at), ...items, ...list.slice(at)]
}

// Ids whose ancestor is also in the set are dropped: removing/moving the
// ancestor already carries them. Result is in document order.
function topLevelIds(tree: DesignNode, ids: readonly string[]): string[] {
  const index = buildIndex(tree)
  const wanted = new Set(ids)
  for (const id of wanted) {
    if (!index.has(id)) throw new Error(`node not found: ${id}`)
  }
  const hasSelectedAncestor = (id: string): boolean => {
    let parentId = index.get(id)!.parentId
    while (parentId !== null) {
      if (wanted.has(parentId)) return true
      parentId = index.get(parentId)!.parentId
    }
    return false
  }
  const ordered: string[] = []
  walk(tree, (node) => {
    if (wanted.has(node.id) && !hasSelectedAncestor(node.id)) ordered.push(node.id)
  })
  return ordered
}

function isWithin(tree: DesignNode, ancestorId: string, id: string): boolean {
  const index = buildIndex(tree)
  let current: string | null = id
  while (current !== null) {
    if (current === ancestorId) return true
    current = index.get(current)?.parentId ?? null
  }
  return false
}

function applyPatch(
  target: Record<string, string>,
  patch: Record<string, string | null>,
): Record<string, string> {
  const next = { ...target }
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete next[key]
    else next[key] = value
  }
  return next
}

function inversePatch(
  target: Record<string, string>,
  patch: Record<string, string | null>,
): Record<string, string | null> {
  const inverse: Record<string, string | null> = {}
  for (const key of Object.keys(patch)) {
    inverse[key] = key in target ? target[key] : null
  }
  return inverse
}

// ---- Ops ----

export function applyOp(tree: DesignNode, op: DesignOp): { tree: DesignNode; touched: string[] } {
  switch (op.type) {
    case 'insert': {
      const parentId = op.parentId ?? tree.id
      const existing = buildIndex(tree)
      walk(op.node, (node) => {
        if (existing.has(node.id)) throw new Error(`duplicate id: ${node.id}`)
      })
      const next = updateAt(tree, parentId, (parent) => ({
        ...parent,
        children: insertAt(parent.children, op.index, [op.node]),
      }))
      return { tree: next, touched: [op.node.id] }
    }
    case 'remove': {
      const ids = topLevelIds(tree, op.ids)
      if (ids.includes(tree.id)) throw new Error('cannot remove the root node')
      return { tree: removeIds(tree, new Set(ids)), touched: ids }
    }
    case 'move': {
      const ids = topLevelIds(tree, op.ids)
      if (ids.includes(tree.id)) throw new Error('cannot move the root node')
      requireNode(tree, op.parentId)
      for (const id of ids) {
        if (isWithin(tree, id, op.parentId)) throw new Error(`cannot move node into itself: ${id}`)
      }
      const nodes = ids.map((id) => findNode(tree, id)!.node)
      // index is the position among the target's children after the moved
      // nodes are detached (what a drop on the remaining siblings computes).
      const detached = removeIds(tree, new Set(ids))
      const next = updateAt(detached, op.parentId, (parent) => ({
        ...parent,
        children: insertAt(parent.children, op.index, nodes),
      }))
      return { tree: next, touched: ids }
    }
    case 'setStyle':
      return {
        tree: updateAt(tree, op.id, (node) => ({ ...node, style: applyPatch(node.style, op.patch) })),
        touched: [op.id],
      }
    case 'setAttrs':
      return {
        tree: updateAt(tree, op.id, (node) => ({ ...node, attrs: applyPatch(node.attrs, op.patch) })),
        touched: [op.id],
      }
    case 'setText':
      return {
        tree: updateAt(tree, op.id, (node) => ({ ...node, text: op.text })),
        touched: [op.id],
      }
    case 'rename':
      return {
        tree: updateAt(tree, op.id, (node) => {
          // Empty name clears it, so the inverse of naming an unnamed node is exact.
          if (op.name === '') {
            const { name: _name, ...rest } = node
            return rest
          }
          return { ...node, name: op.name }
        }),
        touched: [op.id],
      }
    case 'replaceTree':
      return { tree: op.tree, touched: [op.tree.id] }
    case 'setArtboard':
      // Touches artboard columns, not the tree.
      return { tree, touched: [] }
  }
}

export function applyOps(tree: DesignNode, ops: readonly DesignOp[]): { tree: DesignNode; touched: string[] } {
  const touched = new Set<string>()
  let current = tree
  for (const op of ops) {
    const result = applyOp(current, op)
    current = result.tree
    for (const id of result.touched) touched.add(id)
  }
  return { tree: current, touched: [...touched] }
}

// Inverse ops computed against the tree BEFORE op is applied. Applying them
// in the returned order to the tree after op restores the original tree.
// One op can need several inverses (remove/move of many ids), hence the array.
export function invertOp(tree: DesignNode, op: DesignOp, current?: ArtboardPatch): DesignOp[] {
  switch (op.type) {
    case 'insert':
      return [{ type: 'remove', ids: [op.node.id] }]
    case 'remove': {
      // Document order: a sibling restored at a lower index comes first, so
      // the later index is valid again by the time it is inserted.
      return topLevelIds(tree, op.ids).map((id) => {
        const { node, parent, index } = requireNode(tree, id)
        return { type: 'insert', parentId: parent ? parent.id : null, index, node }
      })
    }
    case 'move':
      return topLevelIds(tree, op.ids).map((id) => {
        const { parent, index } = requireNode(tree, id)
        return { type: 'move', ids: [id], parentId: parent!.id, index }
      })
    case 'setStyle':
      return [{ type: 'setStyle', id: op.id, patch: inversePatch(requireNode(tree, op.id).node.style, op.patch) }]
    case 'setAttrs':
      return [{ type: 'setAttrs', id: op.id, patch: inversePatch(requireNode(tree, op.id).node.attrs, op.patch) }]
    case 'setText':
      return [{ type: 'setText', id: op.id, text: requireNode(tree, op.id).node.text ?? '' }]
    case 'rename':
      return [{ type: 'rename', id: op.id, name: requireNode(tree, op.id).node.name ?? '' }]
    case 'replaceTree':
      return [{ type: 'replaceTree', tree }]
    case 'setArtboard': {
      const patch: ArtboardPatch = {}
      if (current) {
        for (const key of Object.keys(op.patch) as Array<keyof ArtboardPatch>) {
          if (current[key] !== undefined) (patch as Record<string, unknown>)[key] = current[key]
        }
      }
      return [{ type: 'setArtboard', patch }]
    }
  }
}

// Inverses for a batch, already in undo order (last op first).
export function invertOps(tree: DesignNode, ops: readonly DesignOp[], current?: ArtboardPatch): DesignOp[] {
  const inverses: DesignOp[][] = []
  let working = tree
  for (const op of ops) {
    inverses.push(invertOp(working, op, current))
    working = applyOp(working, op).tree
  }
  return inverses.reverse().flat()
}

// ---- Agent-facing views ----

export function summarize(tree: DesignNode, maxDepth: number): DesignNodeSummary {
  const build = (node: DesignNode, depth: number): DesignNodeSummary => {
    const summary: DesignNodeSummary = {
      id: node.id,
      tag: node.tag,
      kind: node.kind,
      childCount: node.children.length,
    }
    if (node.name) summary.name = node.name
    if (node.text) {
      summary.text = node.text.length > SUMMARY_TEXT_MAX
        ? `${node.text.slice(0, SUMMARY_TEXT_MAX)}…`
        : node.text
    }
    if (depth < maxDepth && node.children.length > 0) {
      summary.children = node.children.map((child) => build(child, depth + 1))
    }
    return summary
  }
  return build(tree, 0)
}

export function summaryToText(summary: DesignNodeSummary): string {
  const lines: string[] = []
  const emit = (item: DesignNodeSummary, depth: number): void => {
    let line = `${'  '.repeat(depth)}${item.id} ${item.tag}.${item.kind}`
    if (item.name) line += ` "${item.name}"`
    if (item.text) line += ` ${JSON.stringify(item.text)}`
    if (item.childCount > 0 && !item.children) line += ` (${item.childCount} children)`
    lines.push(line)
    for (const child of item.children ?? []) emit(child, depth + 1)
  }
  emit(summary, 0)
  return lines.join('\n')
}

export function cloneWithNewIds(node: DesignNode): { node: DesignNode; idMap: Record<string, string> } {
  const idMap: Record<string, string> = {}
  const clone = (source: DesignNode): DesignNode => {
    const id = newNodeId()
    idMap[source.id] = id
    return {
      ...source,
      id,
      style: { ...source.style },
      attrs: { ...source.attrs },
      link: source.link ? { ...source.link } : undefined,
      children: source.children.map(clone),
    }
  }
  const cloned = clone(node)
  return { node: stripUndefinedLink(cloned), idMap }
}

function stripUndefinedLink(node: DesignNode): DesignNode {
  const next = { ...node, children: node.children.map(stripUndefinedLink) }
  if (next.link === undefined) delete next.link
  return next
}

export function validateTree(tree: DesignNode): string[] {
  const errors: string[] = []
  const seen = new Set<string>()
  walk(tree, (node) => {
    const where = node.id || '<empty id>'
    if (!node.id) errors.push('node with empty id')
    else if (seen.has(node.id)) errors.push(`duplicate id: ${node.id}`)
    seen.add(node.id)
    if (!KINDS.has(node.kind)) errors.push(`${where}: invalid kind "${String(node.kind)}"`)
    if (FORBIDDEN_TAGS.has(node.tag.toLowerCase())) errors.push(`${where}: forbidden tag <${node.tag}>`)
    for (const [key, value] of Object.entries(node.attrs)) {
      if (/^on/i.test(key)) errors.push(`${where}: event handler attribute "${key}"`)
      if (/^\s*javascript:/i.test(value)) errors.push(`${where}: javascript: URL in "${key}"`)
    }
    if (node.kind === 'text' && node.children.length > 0) {
      errors.push(`${where}: text node must not have children`)
    }
  })
  return errors
}
