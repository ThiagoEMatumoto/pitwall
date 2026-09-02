// Defensive pass over a DesignNode tree that arrives as data (IPC ops from
// the renderer, MCP replaceTree/insert payloads, restored snapshots) rather
// than as HTML through parseHtml. Mirrors the parser's rules from safety.ts.

import type { DesignNode } from '../../../../shared/types/design'
import { newNodeId } from '../../../../shared/design/ids'
import { validateTree } from '../../../../shared/design/ops'
import {
  ATTR_NAME_RE,
  BLOCKED_TAGS,
  MAX_TREE_DEPTH,
  URL_ATTRS,
  isNodeLink,
  isUnsafeUrl,
} from '../../../../shared/design/safety'

export interface SanitizeResult {
  tree: DesignNode
  warnings: string[]
}

// Defensive pass over any tree that reaches the store without parseHtml
// (IPC ops from the renderer, MCP replaceTree/insert payloads, restored
// snapshots): blocked tags out, event handlers / bad attribute names /
// unsafe URLs out, malformed links out, ids present and unique, depth
// bounded. Returns a new tree. What cannot be repaired (invalid kind, text
// node with children, oversized tree) is left to validateTree, which throws
// instead of silently persisting a malformed tree.
export function sanitizeTree(tree: DesignNode): SanitizeResult {
  const warnings: string[] = []
  const seen = new Set<string>()

  const visit = (node: DesignNode, depth: number): DesignNode => {
    if (depth > MAX_TREE_DEPTH) throw new Error(`tree nests deeper than ${MAX_TREE_DEPTH} levels`)
    let id = node.id
    if (!id || seen.has(id)) {
      id = newNodeId()
      if (node.id) warnings.push(`duplicate id ${node.id} reassigned to ${id}`)
    }
    seen.add(id)

    const attrs: Record<string, string> = {}
    for (const [name, value] of Object.entries(node.attrs ?? {})) {
      const lower = name.toLowerCase()
      if (typeof value !== 'string' || lower.startsWith('on') || !ATTR_NAME_RE.test(name)) {
        warnings.push(`dropped attribute ${name} on <${node.tag}>`)
        continue
      }
      if (lower.startsWith('data-pw-')) continue
      if (URL_ATTRS.has(lower) && isUnsafeUrl(value)) {
        warnings.push(`dropped unsafe ${name} on <${node.tag}>`)
        continue
      }
      attrs[name] = value
    }

    const children: DesignNode[] = []
    for (const child of node.children ?? []) {
      if (typeof child.tag !== 'string' || BLOCKED_TAGS.has(child.tag.toLowerCase())) {
        warnings.push(`dropped <${String(child.tag)}>`)
        continue
      }
      children.push(visit(child, depth + 1))
    }

    const next: DesignNode = { ...node, id, attrs, children }
    if (node.link !== undefined && !isNodeLink(node.link)) {
      warnings.push(`dropped invalid link on ${id}`)
      delete next.link
    }
    return next
  }

  if (typeof tree.tag !== 'string' || BLOCKED_TAGS.has(tree.tag.toLowerCase())) {
    warnings.push(`root <${String(tree.tag)}> replaced by an empty frame`)
    return {
      tree: { id: newNodeId(), tag: 'div', kind: 'frame', style: {}, attrs: {}, children: [] },
      warnings,
    }
  }
  const sanitized = visit(tree, 0)
  const errors = validateTree(sanitized)
  if (errors.length > 0) throw new Error(`invalid design tree: ${errors.join('; ')}`)
  return { tree: sanitized, warnings }
}
