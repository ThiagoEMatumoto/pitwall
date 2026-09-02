// Agent-facing views of a tree (design_tree_summary, design_node_get).

import type { DesignNode, DesignNodeSummary } from '../types/design'

const SUMMARY_TEXT_MAX = 60

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
      summary.text =
        node.text.length > SUMMARY_TEXT_MAX ? `${node.text.slice(0, SUMMARY_TEXT_MAX)}…` : node.text
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
