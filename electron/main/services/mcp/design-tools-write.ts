// Write design_* tools. Every tree mutation goes through mutate.ts with a
// 'claude' origin, and every tool here is wrapped by withActivity so the
// canvas shows what the agent is touching.

import * as designStore from '../design/design-store'
import * as assetStore from '../design/asset-store'
import * as mutate from '../design/mutate'
import { ok, type ToolDef } from './tools'
import { claudeOrigin, schemas, withActivity, type DesignToolDeps } from './design-tools-shared'
import { prototypeTools } from './design-tools-write-prototype'
import {
  ARTBOARD_MAX_PX,
  DEFAULT_ARTBOARD_HEIGHT_PX,
  clampArtboardSizeReport,
} from '../../../../shared/design/safety'
import { nextArtboardX as placeAfterLast } from '../../../../shared/design/artboard-layout'
import type { DesignDocument, DesignTokens } from '../../../../shared/types/design'

// Artboards created without x land to the right of the page's last one; the
// agent should not have to lay out the canvas.
function nextArtboardX(doc: DesignDocument, pageId: string | undefined): number {
  const page = pageId ? doc.pages.find((p) => p.id === pageId) : doc.pages[0]
  return placeAfterLast(page?.artboards ?? [])
}

// The store clamps silently; the agent asked for a size, so it hears about it.
function clampSize(axis: 'width' | 'height', raw: number, warnings: string[]): number {
  const { value, clamped } = clampArtboardSizeReport(raw)
  if (clamped) warnings.push(`${axis} ${raw} clamped to ${value} (max ${ARTBOARD_MAX_PX})`)
  return value
}

function mergeTokens(current: DesignTokens, patch: DesignTokens): DesignTokens {
  const merged: DesignTokens = { ...current }
  for (const [category, values] of Object.entries(patch) as Array<
    [keyof DesignTokens, Record<string, string>]
  >) {
    if (!values) continue
    merged[category] = { ...(current[category] ?? {}), ...values }
  }
  return merged
}

export function writeTools(deps: DesignToolDeps): ToolDef[] {
  const origin = () => claudeOrigin(deps)
  const send = deps.notify.broadcast.bind(deps.notify)
  const base = { author: 'claude' as const, send }

  const wrap = (def: ToolDef, pick: Parameters<typeof withActivity>[2]): ToolDef =>
    withActivity(deps, def, pick)
  const byArtboard = (a: Record<string, unknown>) => ({
    artboardId: a.artboardId as string,
  })
  const byArtboardIds = (a: Record<string, unknown>) => ({
    artboardId: a.artboardId as string,
    nodeIds: Array.isArray(a.ids) ? (a.ids as string[]) : [],
  })
  const byArtboardItems = (a: Record<string, unknown>) => ({
    artboardId: a.artboardId as string,
    nodeIds: Array.isArray(a.items) ? (a.items as Array<{ id: string }>).map((i) => i.id) : [],
  })
  const byArtboardNode = (a: Record<string, unknown>) => ({
    artboardId: a.artboardId as string,
    nodeIds: typeof a.nodeId === 'string' ? [a.nodeId] : [],
  })

  return [
    {
      name: 'design_document_create',
      title: 'Create design document',
      description:
        'Create a document with one empty page. Optional tokens/fonts/globalCss and links to a feature/task/objective. Then add artboards with design_artboard_create. See design_guide §2.',
      inputSchema: schemas.documentCreate,
      handler: (args) => {
        const input = schemas.documentCreate.parse(args)
        const doc = designStore.createDocument(input)
        deps.notify.broadcast('design:document-updated', { docId: doc.id })
        const { thumbnail: _t, ...rest } = doc
        return ok({ document: rest })
      },
    },
    wrap(
      {
        name: 'design_artboard_create',
        title: 'Create artboard',
        description:
          'Add an artboard (px) to a document. sizing "fixed" (default; width × height, clips) or "flow" (fixed width, height grows with the content — use it for long landing pages; height optional). Sizes above the max are clamped with a warning. Omitted x places it right of the last one. Optional html fills it like design_write_html mode "replace". Sizes in design_guide §2.',
        inputSchema: schemas.artboardCreate,
        handler: (args) => {
          const input = schemas.artboardCreate.parse(args)
          const doc = designStore.getDocument(input.docId)
          if (!doc) throw new Error(`design document not found: ${input.docId}`)
          let warnings: string[] = []
          let artboard = designStore.createArtboard({
            docId: input.docId,
            pageId: input.pageId,
            name: input.name,
            width: clampSize('width', input.width, warnings),
            height: clampSize('height', input.height ?? DEFAULT_ARTBOARD_HEIGHT_PX, warnings),
            sizing: input.sizing,
            x: input.x ?? nextArtboardX(doc, input.pageId),
            y: input.y,
            author: 'claude',
          })
          deps.notify.broadcast('design:document-updated', {
            docId: input.docId,
          })
          if (input.html) {
            const written = mutate.writeHtml({
              ...base,
              artboardId: artboard.id,
              html: input.html,
              mode: 'replace',
              origin: origin(),
              snapshot: true,
              summary: `create ${input.name}`,
            })
            artboard = written.artboard
            warnings = [...warnings, ...written.warnings]
          }
          const { tree, ...meta } = artboard
          return ok({ artboard: { ...meta, rootId: tree.id }, warnings })
        },
      },
      (a) => ({ docId: a.docId as string }),
    ),
    wrap(
      {
        name: 'design_write_html',
        title: 'Write HTML into artboard',
        description:
          'mode "replace" (default) rebuilds the whole artboard from the HTML; mode "insert" appends the fragment under parentId (root when omitted) at index. Unsafe tags/attrs are dropped and listed in `warnings`. summary is the version label. See design_guide §3-4.',
        inputSchema: schemas.writeHtml,
        handler: (args) => {
          const input = schemas.writeHtml.parse(args)
          const result = mutate.writeHtml({
            ...base,
            ...input,
            origin: origin(),
            snapshot: input.mode === 'replace',
          })
          return ok({
            artboardId: input.artboardId,
            version: result.event.version,
            nodeIds: result.nodeIds,
            warnings: result.warnings,
          })
        },
      },
      byArtboard,
    ),
    wrap(
      {
        name: 'design_text_set',
        title: 'Set text',
        description: 'Replace the text content of one node. See design_guide §3.',
        inputSchema: schemas.textSet,
        handler: (args) => {
          const input = schemas.textSet.parse(args)
          const { event } = mutate.setText({
            ...base,
            ...input,
            origin: origin(),
          })
          return ok({
            artboardId: input.artboardId,
            version: event.version,
            nodeIds: [input.nodeId],
          })
        },
      },
      byArtboardNode,
    ),
    wrap(
      {
        name: 'design_nodes_rename',
        title: 'Rename layers',
        description:
          'Set the layer name the human sees for each node ({ id, name }). See design_guide §3.',
        inputSchema: schemas.nodesRename,
        handler: (args) => {
          const input = schemas.nodesRename.parse(args)
          const { event } = mutate.renameNodes({
            ...base,
            ...input,
            origin: origin(),
          })
          return ok({
            artboardId: input.artboardId,
            version: event.version,
            nodeIds: input.items.map((i) => i.id),
          })
        },
      },
      byArtboardItems,
    ),
    wrap(
      {
        name: 'design_nodes_duplicate',
        title: 'Duplicate nodes',
        description:
          'Deep-copy nodes with fresh ids, placed right after the originals (or under parentId at index). Returns idMap old→new. See design_guide §3.',
        inputSchema: schemas.nodesDuplicate,
        handler: (args) => {
          const input = schemas.nodesDuplicate.parse(args)
          const { event, idMap } = mutate.duplicateNodes({
            ...base,
            ...input,
            origin: origin(),
          })
          const nodeIds = input.ids.map((id) => idMap[id])
          return ok({
            artboardId: input.artboardId,
            version: event.version,
            idMap,
            nodeIds,
          })
        },
      },
      byArtboardIds,
    ),
    wrap(
      {
        name: 'design_nodes_move',
        title: 'Move nodes',
        description:
          'Reorder or reparent nodes: they land under parentId starting at index. See design_guide §3.',
        inputSchema: schemas.nodesMove,
        handler: (args) => {
          const input = schemas.nodesMove.parse(args)
          const { event } = mutate.moveNodes({
            ...base,
            ...input,
            origin: origin(),
          })
          return ok({
            artboardId: input.artboardId,
            version: event.version,
            nodeIds: input.ids,
          })
        },
      },
      byArtboardIds,
    ),
    wrap(
      {
        name: 'design_styles_update',
        title: 'Update styles (preferred edit)',
        description:
          'PREFERRED edit: patch inline styles per node ({ id, style: { prop: value | null } }); null removes the property, other properties stay. See design_guide §3 and §5.',
        inputSchema: schemas.stylesUpdate,
        handler: (args) => {
          const input = schemas.stylesUpdate.parse(args)
          // A summary means "this pass is worth a name": record it as a
          // version the human can roll back to, as design_guide §2 promises.
          const { event } = mutate.updateStyles({
            ...base,
            ...input,
            snapshot: input.summary !== undefined,
            origin: origin(),
          })
          return ok({
            artboardId: input.artboardId,
            version: event.version,
            nodeIds: input.items.map((i) => i.id),
          })
        },
      },
      byArtboardItems,
    ),
    wrap(
      {
        name: 'design_nodes_delete',
        title: 'Delete nodes',
        description:
          'Remove nodes (and their subtrees). The root cannot be removed. See design_guide §3.',
        inputSchema: schemas.nodesDelete,
        handler: (args) => {
          const input = schemas.nodesDelete.parse(args)
          const { event } = mutate.deleteNodes({
            ...base,
            ...input,
            origin: origin(),
          })
          return ok({
            artboardId: input.artboardId,
            version: event.version,
            nodeIds: input.ids,
          })
        },
      },
      byArtboardIds,
    ),
    wrap(
      {
        name: 'design_tokens_set',
        title: 'Set document tokens/fonts/CSS',
        description:
          'Merge tokens into the document (color.primary → var(--color-primary)), replace fonts (Google Fonts URLs) and/or globalCss. Applies to every artboard. See design_guide §5.',
        inputSchema: schemas.tokensSet,
        handler: (args) => {
          const input = schemas.tokensSet.parse(args)
          const doc = designStore.getDocument(input.docId)
          if (!doc) throw new Error(`design document not found: ${input.docId}`)
          const updated = designStore.updateDocument({
            id: input.docId,
            tokens: input.tokens ? mergeTokens(doc.tokens, input.tokens) : undefined,
            fonts: input.fonts,
            globalCss: input.globalCss,
          })
          deps.notify.broadcast('design:document-updated', {
            docId: input.docId,
          })
          return ok({
            docId: input.docId,
            tokens: updated.tokens,
            fonts: updated.fonts,
            globalCss: updated.globalCss,
          })
        },
      },
      (a) => ({ docId: a.docId as string }),
    ),
    {
      name: 'design_asset_upload',
      title: 'Upload asset',
      description:
        'Store an image (≤ 5 MB; png/jpeg/webp/gif/svg) for a document (docId null = shared) and get the pitwall-design://asset/<id> URL to use in src. See design_guide §6.',
      inputSchema: schemas.assetUpload,
      handler: (args) => {
        const input = schemas.assetUpload.parse(args)
        const asset = assetStore.upload({
          documentId: input.docId ?? null,
          name: input.name,
          mime: input.mime,
          bytes: Buffer.from(input.dataBase64, 'base64'),
        })
        deps.notify.broadcast('design:assets-updated', {
          docId: input.docId ?? null,
        })
        return ok({ asset, url: asset.url })
      },
    },
    ...prototypeTools(deps),
  ]
}
