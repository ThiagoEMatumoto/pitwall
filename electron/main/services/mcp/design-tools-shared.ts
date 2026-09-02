// Shared bits of the design_* tools: zod schemas, the activity wrapper and
// the small lookups every handler starts with.

import * as z from 'zod/v4'
import * as designStore from '../design/design-store'
import * as liveState from '../design/live-state'
import { newNonce } from '../../../../shared/design/ids'
import {
  ARTBOARD_MAX_PX,
  ARTBOARD_MIN_PX,
  MAX_ASSET_BASE64_CHARS,
  MAX_GLOBAL_CSS_BYTES,
  MAX_HTML_BYTES,
  MAX_NAME_CHARS,
  MAX_SUMMARY_CHARS,
  MAX_TOKEN_KEYS,
} from '../../../../shared/design/safety'
import type { McpNotify, McpRequestContext, ToolDef } from './tools'
import type {
  DesignAgentActivity,
  DesignArtboard,
  DesignOrigin,
} from '../../../../shared/types/design'

export interface DesignToolDeps {
  notify: McpNotify
  ctx: McpRequestContext
}

export function claudeOrigin(deps: DesignToolDeps): DesignOrigin {
  return {
    kind: 'claude',
    sessionId: deps.ctx.motherSessionId,
    nonce: newNonce(),
  }
}

export function loadArtboard(artboardId: string): {
  artboard: DesignArtboard
  docId: string
} {
  const artboard = designStore.getArtboard(artboardId)
  if (!artboard) throw new Error(`design artboard not found: ${artboardId}`)
  return { artboard, docId: designStore.getArtboardDocumentId(artboardId)! }
}

// ---- activity (the "Claude is editing" HUD) ----

export interface ActivityScope {
  docId?: string
  artboardId?: string | null
  nodeIds?: string[]
}

function resolveScope(scope: ActivityScope): { docId: string; artboardId: string | null } | null {
  const artboardId = scope.artboardId ?? null
  const docId = scope.docId ?? (artboardId ? designStore.getArtboardDocumentId(artboardId) : null)
  return docId ? { docId, artboardId } : null
}

// Tools that write into an artboard without naming nodes target its root
// (write_html replace) or the parent the fragment lands under (insert), so
// the canvas veils exactly the region about to change.
function startNodeIds(picked: ActivityScope, args: Record<string, unknown>): string[] {
  if (picked.nodeIds?.length) return picked.nodeIds
  if (!picked.artboardId) return []
  const root = designStore.getArtboard(picked.artboardId)?.tree.id
  if (args.mode === 'insert' && typeof args.parentId === 'string') return [args.parentId]
  return root ? [root] : []
}

interface Touched {
  artboardId?: string
  nodeIds: string[]
}

// write_html returns the children it produced; the region that changed (and
// the canvas veiled) is the root or the parent the start landed on, so the
// 'end' stays there instead of fanning out one pill per new node.
const END_ON_START_IDS = new Set(['design_write_html'])

// What the handler reports it changed: the ids it returns, or — for a tool
// that created an artboard — that artboard's root, so the 'end' lands on it.
function touched(result: unknown): Touched | null {
  const sc = (result as { structuredContent?: Record<string, unknown> } | undefined)
    ?.structuredContent
  if (!sc) return null
  const ids = sc.nodeIds
  if (Array.isArray(ids) && ids.every((id) => typeof id === 'string')) return { nodeIds: ids }
  const artboard = sc.artboard as { id?: unknown; rootId?: unknown } | undefined
  if (artboard && typeof artboard.id === 'string') {
    return {
      artboardId: artboard.id,
      nodeIds: typeof artboard.rootId === 'string' ? [artboard.rootId] : [],
    }
  }
  return null
}

// Wraps a write tool: 'start' before the handler, 'end' in a finally, both
// broadcast on design:agent-activity and remembered by live-state until
// design_nodes_finish (or the TTL) clears them.
export function withActivity(
  deps: DesignToolDeps,
  def: ToolDef,
  pick: (args: Record<string, unknown>) => ActivityScope,
): ToolDef {
  return {
    ...def,
    handler: async (args) => {
      const input = (args ?? {}) as Record<string, unknown>
      const picked = pick(input)
      const scope = resolveScope(picked)
      if (!scope) return def.handler(args)

      const emit = (
        phase: DesignAgentActivity['phase'],
        nodeIds: string[],
        artboardId = scope.artboardId,
      ): void => {
        const activity: DesignAgentActivity = {
          docId: scope.docId,
          artboardId,
          nodeIds,
          tool: def.name,
          phase,
          sessionId: deps.ctx.motherSessionId,
          at: Date.now(),
        }
        if (phase === 'start') liveState.setActivity(activity)
        // Document-level writes (tokens, new artboard) are instantaneous: no
        // node keeps a badge, so nothing waits for design_nodes_finish.
        if (phase === 'end' && !scope.artboardId) {
          liveState.clearActivity(scope.docId, { artboardId: null })
        }
        deps.notify.broadcast('design:agent-activity', activity)
      }

      const startIds = startNodeIds(picked, input)
      emit('start', startIds)
      let result: unknown
      try {
        result = await def.handler(args)
        return result as Awaited<ReturnType<ToolDef['handler']>>
      } finally {
        const done = END_ON_START_IDS.has(def.name) ? null : touched(result)
        emit('end', done?.nodeIds ?? startIds, done?.artboardId ?? scope.artboardId)
      }
    },
  }
}

// ---- schemas ----

const id = z.string().min(1)
export const artboardId = id
export const docId = id

const stylePatch = z.record(z.string(), z.string().nullable())
const tokenGroup = z
  .record(z.string(), z.string())
  .refine((group) => Object.keys(group).length <= MAX_TOKEN_KEYS, {
    message: `at most ${MAX_TOKEN_KEYS} tokens per category`,
  })
const name = z.string().min(1).max(MAX_NAME_CHARS)
const summary = z.string().min(1).max(MAX_SUMMARY_CHARS)
const html = z.string().min(1).max(MAX_HTML_BYTES)
const globalCss = z.string().max(MAX_GLOBAL_CSS_BYTES)
const artboardPx = z.number().int().min(ARTBOARD_MIN_PX).max(ARTBOARD_MAX_PX)

export const tokensSchema = z.object({
  color: tokenGroup.optional(),
  spacing: tokenGroup.optional(),
  radius: tokenGroup.optional(),
  font: tokenGroup.optional(),
  shadow: tokenGroup.optional(),
})

const parentType = z.enum([
  'project',
  'repo',
  'feature',
  'task',
  'objective',
  'key_result',
  'session',
  'handoff',
])

export const schemas = {
  documentList: z.object({
    status: z.enum(['active', 'archived', 'all']).optional(),
    parentType: parentType.optional(),
    parentId: z.string().optional(),
    search: z.string().optional(),
  }),
  documentGet: z.object({
    docId,
    depth: z.number().int().min(0).max(8).default(2),
  }),
  selectionGet: z.object({ docId: docId.optional() }),
  nodeGet: z.object({ artboardId, nodeId: id }),
  childrenGet: z.object({ artboardId, nodeId: id.nullable().optional() }),
  treeSummary: z.object({
    artboardId,
    depth: z.number().int().min(0).max(12).default(3),
    rootId: id.optional(),
  }),
  screenshot: z.object({
    artboardId,
    scale: z.union([z.literal(1), z.literal(2)]).default(1),
    nodeId: id.optional(),
  }),
  htmlGet: z.object({
    artboardId,
    nodeId: id.optional(),
    format: z.enum(['html', 'jsx']).default('html'),
  }),
  computedStyles: z.object({
    artboardId,
    nodeIds: z.array(id).min(1).max(50),
    props: z.array(z.string().min(1)).max(40).optional(),
  }),
  documentCreate: z.object({
    title: name,
    tokens: tokensSchema.optional(),
    fonts: z.array(z.string().url()).optional(),
    globalCss: globalCss.optional(),
    links: z.array(z.object({ parentType, parentId: z.string().min(1) })).optional(),
  }),
  artboardCreate: z.object({
    docId,
    pageId: id.optional(),
    name,
    width: artboardPx,
    height: artboardPx,
    x: z.number().optional(),
    y: z.number().optional(),
    html: html.optional(),
  }),
  writeHtml: z.object({
    artboardId,
    html,
    mode: z.enum(['replace', 'insert']).default('replace'),
    parentId: id.optional(),
    index: z.number().int().min(0).optional(),
    summary,
  }),
  textSet: z.object({ artboardId, nodeId: id, text: z.string() }),
  nodesRename: z.object({
    artboardId,
    items: z.array(z.object({ id, name })).min(1),
  }),
  nodesDuplicate: z.object({
    artboardId,
    ids: z.array(id).min(1),
    parentId: id.optional(),
    index: z.number().int().min(0).optional(),
  }),
  nodesMove: z.object({
    artboardId,
    ids: z.array(id).min(1),
    parentId: id,
    index: z.number().int().min(0),
  }),
  stylesUpdate: z.object({
    artboardId,
    items: z.array(z.object({ id, style: stylePatch })).min(1),
    summary: summary.optional(),
  }),
  nodesDelete: z.object({ artboardId, ids: z.array(id).min(1) }),
  tokensSet: z.object({
    docId,
    tokens: tokensSchema.optional(),
    fonts: z.array(z.string().url()).optional(),
    globalCss: globalCss.optional(),
  }),
  assetUpload: z.object({
    docId: docId.nullable().optional(),
    name,
    mime: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/svg+xml']),
    dataBase64: z.string().min(1).max(MAX_ASSET_BASE64_CHARS),
  }),
  linkSet: z.object({
    artboardId,
    nodeId: id,
    targetArtboardId: artboardId.nullable(),
    transition: z.enum(['none', 'push', 'fade']).default('none'),
  }),
  export: z.object({
    artboardId,
    format: z.enum(['png', 'html', 'jsx']).default('html'),
    scale: z.union([z.literal(1), z.literal(2)]).default(1),
  }),
  guide: z.object({ section: z.number().int().min(1).max(9).optional() }),
  nodesFinish: z.object({
    artboardId,
    ids: z.array(id).optional(),
    summary: summary.optional(),
  }),
}
