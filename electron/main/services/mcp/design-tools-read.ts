// Read-only design_* tools: what the agent looks at before and after editing.

import * as designStore from '../design/design-store'
import * as liveState from '../design/live-state'
import { captureArtboard, computeStyles } from '../design/screenshot'
import { renderJsx } from '../design/export'
import { renderNode } from '../../../../shared/design/html-render'
import { findNode, summarize, summaryToText } from '../../../../shared/design/ops'
import { ok, type ToolDef, type ToolResult } from './tools'
import { loadArtboard, schemas, type DesignToolDeps } from './design-tools-shared'
import type { DesignArtboard, DesignNode, DesignPage } from '../../../../shared/types/design'

const DEFAULT_COMPUTED_PROPS = [
  'width',
  'height',
  'font-family',
  'font-size',
  'font-weight',
  'line-height',
  'color',
  'background-color',
  'padding',
  'margin',
  'gap',
  'display',
]

function artboardMeta(artboard: DesignArtboard) {
  const { tree: _tree, ...meta } = artboard
  return { ...meta, rootId: artboard.tree.id }
}

function pageWithSummaries(page: DesignPage, depth: number) {
  return {
    ...page,
    artboards: page.artboards.map((a) => ({
      ...artboardMeta(a),
      summary: summaryToText(summarize(a.tree, depth)),
    })),
  }
}

function nodeMeta(node: DesignNode) {
  const { children, ...rest } = node
  return { ...rest, childCount: children.length }
}

function requireNode(artboard: DesignArtboard, nodeId: string): DesignNode {
  const found = findNode(artboard.tree, nodeId)
  if (!found) throw new Error(`node not found in artboard ${artboard.id}: ${nodeId}`)
  return found.node
}

export function readTools(_deps: DesignToolDeps): ToolDef[] {
  return [
    {
      name: 'design_document_list',
      title: 'List design documents',
      description:
        'List Design Studio documents (metas only). Filters: status (active default | archived | all), parent (parentType + parentId), search on title. See design_guide §1.',
      inputSchema: schemas.documentList,
      handler: (args) => {
        const filter = schemas.documentList.parse(args)
        const items = designStore.listDocuments(filter).map(({ thumbnail: _t, ...meta }) => meta)
        return ok({ items })
      },
    },
    {
      name: 'design_document_get',
      title: 'Get design document',
      description:
        'Get one document: tokens, fonts, globalCss, pages and artboards (each with an indented tree summary to `depth`, default 2). Artboard ids and root ids come from here. See design_guide §2.',
      inputSchema: schemas.documentGet,
      handler: (args) => {
        const { docId, depth } = schemas.documentGet.parse(args)
        const doc = designStore.getDocument(docId)
        if (!doc) return ok({ document: null })
        const { thumbnail: _t, pages, ...rest } = doc
        return ok({
          document: {
            ...rest,
            pages: pages.map((p) => pageWithSummaries(p, depth)),
          },
        })
      },
    },
    {
      name: 'design_selection_get',
      title: 'Get the human selection',
      description:
        'What the human has selected in the Design Studio right now: docId (active document when omitted), artboardId and node ids with a one-level summary of each. Use it when the request says "this", "here", "the selected". See design_guide §1.',
      inputSchema: schemas.selectionGet,
      handler: (args) => {
        const input = schemas.selectionGet.parse(args)
        const docId = input.docId ?? liveState.getActiveDoc()
        if (!docId) return ok({ docId: null, artboardId: null, nodeIds: [], nodes: [] })
        const selection = liveState.getSelection(docId)
        if (!selection || !selection.artboardId) {
          return ok({
            docId,
            artboardId: selection?.artboardId ?? null,
            nodeIds: [],
            nodes: [],
          })
        }
        const artboard = designStore.getArtboard(selection.artboardId)
        const nodes = artboard
          ? selection.nodeIds
              .map((id) => findNode(artboard.tree, id)?.node)
              .filter((n): n is DesignNode => Boolean(n))
              .map((n) => summarize(n, 1))
          : []
        return ok({
          docId,
          artboardId: selection.artboardId,
          nodeIds: selection.nodeIds,
          nodes,
        })
      },
    },
    {
      name: 'design_node_get',
      title: 'Get node',
      description:
        'Full node (style, attrs, text, name, link) plus a summary of its direct children. See design_guide §2.',
      inputSchema: schemas.nodeGet,
      handler: (args) => {
        const { artboardId, nodeId } = schemas.nodeGet.parse(args)
        const { artboard } = loadArtboard(artboardId)
        const node = requireNode(artboard, nodeId)
        return ok({
          node: nodeMeta(node),
          children: node.children.map((c) => summarize(c, 0)),
        })
      },
    },
    {
      name: 'design_children_get',
      title: 'Get children',
      description:
        'Direct children of a node (nodeId null = artboard root), one level of grandchildren summarized. See design_guide §2.',
      inputSchema: schemas.childrenGet,
      handler: (args) => {
        const { artboardId, nodeId } = schemas.childrenGet.parse(args)
        const { artboard } = loadArtboard(artboardId)
        const parent = nodeId ? requireNode(artboard, nodeId) : artboard.tree
        return ok({
          parentId: parent.id,
          items: parent.children.map((c) => summarize(c, 1)),
        })
      },
    },
    {
      name: 'design_tree_summary',
      title: 'Tree summary',
      description:
        'Indented text outline of an artboard (or of rootId): one line per node with id, tag.kind, name and truncated text, down to `depth` (default 3). Cheapest way to find ids. See design_guide §1.',
      inputSchema: schemas.treeSummary,
      handler: (args) => {
        const { artboardId, depth, rootId } = schemas.treeSummary.parse(args)
        const { artboard } = loadArtboard(artboardId)
        const root = rootId ? requireNode(artboard, rootId) : artboard.tree
        return ok({
          artboardId,
          version: artboard.version,
          width: artboard.width,
          height: artboard.height,
          text: summaryToText(summarize(root, depth)),
        })
      },
    },
    {
      name: 'design_screenshot',
      title: 'Screenshot artboard',
      description:
        'Render the artboard (or one node) to PNG and return it as an image. Do this after every edit pass and fix what you see. scale 2 for fine detail. See design_guide §7.',
      inputSchema: schemas.screenshot,
      handler: async (args) => {
        const { artboardId, scale, nodeId } = schemas.screenshot.parse(args)
        const { artboard, docId } = loadArtboard(artboardId)
        let shot
        try {
          shot = await captureArtboard({
            artboardId,
            docId,
            width: artboard.width,
            height: artboard.height,
            scale,
            version: artboard.version,
            docUpdatedAt: designStore.getDocument(docId)?.updatedAt,
            nodeId,
          })
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err)
          throw new Error(
            `design_screenshot unavailable (${reason}). The Pitwall window must be running; use design_tree_summary or design_computed_styles meanwhile.`,
          )
        }
        const meta = {
          artboardId,
          version: artboard.version,
          width: shot.width,
          height: shot.height,
        }
        const pngBase64 = shot.png.toString('base64')
        const result = {
          content: [
            { type: 'image', data: pngBase64, mimeType: 'image/png' },
            { type: 'text', text: JSON.stringify(meta) },
          ],
          structuredContent: { ...meta, pngBase64 },
        }
        // ToolResult types content as text-only; MCP accepts image blocks.
        return result as unknown as ToolResult
      },
    },
    {
      name: 'design_html_get',
      title: 'Get HTML',
      description:
        'HTML of the artboard (or a subtree) with data-pw-id on every element; format "jsx" returns a React component with inline style objects. See design_guide §4.',
      inputSchema: schemas.htmlGet,
      handler: (args) => {
        const { artboardId, nodeId, format } = schemas.htmlGet.parse(args)
        const { artboard } = loadArtboard(artboardId)
        const root = nodeId ? requireNode(artboard, nodeId) : artboard.tree
        const code = format === 'jsx' ? renderJsx(root) : renderNode(root)
        return ok({ artboardId, rootId: root.id, format, code })
      },
    },
    {
      name: 'design_computed_styles',
      title: 'Computed styles',
      description:
        'Browser-resolved styles for up to 50 nodes (defaults: size, font, color, background, spacing, display). Use when a value comes from tokens or inheritance. See design_guide §5.',
      inputSchema: schemas.computedStyles,
      handler: async (args) => {
        const { artboardId, nodeIds, props } = schemas.computedStyles.parse(args)
        const { docId } = loadArtboard(artboardId)
        const styles = await computeStyles({
          artboardId,
          docId,
          nodeIds,
          props: props ?? DEFAULT_COMPUTED_PROPS,
        })
        return ok({ artboardId, styles })
      },
    },
  ]
}
