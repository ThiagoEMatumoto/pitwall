// Structural validation of a design tree: the last gate before persistence
// (mutate.ts) and the check every renderer trusts. Rules live in safety.ts.

import type { DesignNode, DesignNodeKind } from '../types/design'
import {
  ATTR_NAME_RE,
  BLOCKED_TAGS,
  MAX_TREE_DEPTH,
  MAX_TREE_NODES,
  TAG_NAME_RE,
  URL_ATTRS,
  isNodeLink,
  isReservedStyleKey,
  isUnsafeUrl,
} from './safety'
import { isMotion } from './motion'

const KINDS: ReadonlySet<DesignNodeKind> = new Set(['frame', 'text', 'image', 'svg', 'element'])

// Iterative on purpose: a hostile payload nests deeper than the call stack,
// and the depth/size limits must be reported instead of a RangeError.
export function validateTree(tree: DesignNode): string[] {
  const errors: string[] = []
  const seen = new Set<string>()
  const stack: Array<{ node: DesignNode; depth: number }> = [{ node: tree, depth: 0 }]
  let count = 0
  while (stack.length > 0) {
    const { node, depth } = stack.pop()!
    count += 1
    if (count > MAX_TREE_NODES) {
      errors.push(`tree has more than ${MAX_TREE_NODES} nodes`)
      break
    }
    if (depth > MAX_TREE_DEPTH) {
      errors.push(`tree nests deeper than ${MAX_TREE_DEPTH} levels`)
      break
    }
    validateNode(node, seen, errors)
    for (let i = node.children.length - 1; i >= 0; i--) {
      stack.push({ node: node.children[i], depth: depth + 1 })
    }
  }
  return errors
}

function validateNode(node: DesignNode, seen: Set<string>, errors: string[]): void {
  const where = node.id || '<empty id>'
  if (!node.id) errors.push('node with empty id')
  else if (seen.has(node.id)) errors.push(`duplicate id: ${node.id}`)
  seen.add(node.id)
  if (!KINDS.has(node.kind)) errors.push(`${where}: invalid kind "${String(node.kind)}"`)
  if (typeof node.tag !== 'string' || !TAG_NAME_RE.test(node.tag)) {
    errors.push(`${where}: invalid tag "${String(node.tag)}"`)
  } else if (BLOCKED_TAGS.has(node.tag.toLowerCase())) {
    errors.push(`${where}: forbidden tag <${node.tag}>`)
  }
  for (const [key, value] of Object.entries(node.attrs)) {
    if (!ATTR_NAME_RE.test(key)) errors.push(`${where}: invalid attribute name "${key}"`)
    else if (/^on/i.test(key)) errors.push(`${where}: event handler attribute "${key}"`)
    else if (URL_ATTRS.has(key.toLowerCase()) && isUnsafeUrl(value)) {
      errors.push(`${where}: unsafe URL in "${key}"`)
    }
  }
  for (const key of Object.keys(node.style)) {
    if (isReservedStyleKey(key)) errors.push(`${where}: reserved style property "${key}"`)
  }
  if (node.link !== undefined && !isNodeLink(node.link)) errors.push(`${where}: invalid link`)
  if (node.motion !== undefined && !isMotion(node.motion)) errors.push(`${where}: invalid motion`)
  if (node.kind === 'text' && node.children.length > 0) {
    errors.push(`${where}: text node must not have children`)
  }
}
