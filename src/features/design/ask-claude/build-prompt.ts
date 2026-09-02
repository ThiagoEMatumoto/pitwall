import { summarize, summaryToText } from '@shared/design/ops'
import type { DesignNode } from '@shared/types/design'

// The prompt written into the session's PTY. Pure so the shape is testable
// without a store; the composer only gathers the inputs.

export interface AskSelectionItem {
  id: string
  name?: string
  tag: string
  kind: string
}

export interface BuildAskPromptInput {
  // null when asked from the empty state: Claude creates the document itself.
  docId: string | null
  docTitle: string
  artboardId: string | null
  artboardName: string | null
  selection: AskSelectionItem[]
  treeSummaryText?: string
  request: string
}

export const TREE_SUMMARY_MAX_LINES = 40
const TREE_SUMMARY_DEPTH = 2

const INSTRUCTION =
  'Instrução: use SOMENTE as tools mcp__pitwall__design_* (comece por design_guide + design_tree_summary; termine com design_nodes_finish).'
const NO_DOC_INSTRUCTION =
  'Instrução: nenhum documento aberto — use SOMENTE as tools mcp__pitwall__design_* (comece por design_guide, crie o documento e o artboard; termine com design_nodes_finish).'

function findNode(tree: DesignNode, id: string): DesignNode | null {
  if (tree.id === id) return tree
  for (const child of tree.children) {
    const hit = findNode(child, id)
    if (hit) return hit
  }
  return null
}

export function truncateLines(text: string, max: number): string {
  const lines = text.split('\n')
  if (lines.length <= max) return text
  return [...lines.slice(0, max), `… (+${lines.length - max} linhas)`].join('\n')
}

// Depth-2 summary of the selected subtrees, or of the whole artboard when
// nothing is selected. Capped so a big page never floods the session.
export function buildTreeSummary(tree: DesignNode, selectedIds: readonly string[]): string {
  const roots = selectedIds
    .map((id) => findNode(tree, id))
    .filter((n): n is DesignNode => n !== null)
  const targets = roots.length > 0 ? roots : [tree]
  const text = targets.map((n) => summaryToText(summarize(n, TREE_SUMMARY_DEPTH))).join('\n')
  return truncateLines(text, TREE_SUMMARY_MAX_LINES)
}

export function selectionLabel(item: AskSelectionItem): string {
  return item.name ? `${item.name} (${item.tag}#${item.id})` : `${item.tag}#${item.id}`
}

export function buildAskPrompt(input: BuildAskPromptInput): string {
  const ids = input.selection.map((s) => s.id).join(',')
  const header =
    `[Pitwall Design Studio] doc=${JSON.stringify(input.docTitle)} docId=${input.docId ?? 'none'}` +
    ` artboardId=${input.artboardId ?? 'none'}` +
    (input.artboardName ? ` artboard=${JSON.stringify(input.artboardName)}` : '') +
    ` selection=[${ids}]`

  const lines = [header]
  if (input.selection.length > 0) {
    lines.push(
      `Seleção: ${input.selection.map((s) => `${s.id} ${s.tag}.${s.kind}${s.name ? ` "${s.name}"` : ''}`).join('; ')}`,
    )
  }
  const tree = input.treeSummaryText?.trim()
  if (tree) lines.push('Tree:', truncateLines(tree, TREE_SUMMARY_MAX_LINES))
  lines.push(input.docId ? INSTRUCTION : NO_DOC_INSTRUCTION, `Pedido: ${input.request.trim()}`)
  return lines.join('\n')
}
