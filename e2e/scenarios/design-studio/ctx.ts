// Shared context of the Design Studio E2E: the launched app, the MCP client,
// the ids Claude created and the small lookups every step starts with.
import type { Frame, Page } from 'playwright'
import type { McpClient } from '../../driver/mcp'
import {
  makeChecker,
  nodeCenterOnScreen,
  pwSelector,
  waitForArtboardFrame,
} from '../../driver/design'

export const SHOT = 'ds-e2e'
export const HOME_WIDTH = 1440
export const TEXT_RGB = 'rgb(43, 29, 20)' // #2b1d14
export const PRIMARY_RGB = 'rgb(122, 62, 18)' // #7a3e12

export interface NodeItem {
  id: string
  tag: string
  kind: string
  name?: string
  text?: string
  childCount: number
}

export interface Ids {
  doc: string
  home: string
  mobile: string
  menu: string
  contact: string
}

export interface Ctx {
  page: Page
  userDataCopy: string
  mcp: McpClient
  ids: Ids
  consoleErrors: string[]
  failedRequests: string[]
  checker: ReturnType<typeof makeChecker>
  // Nodes of the Home artboard the canvas steps share.
  cards: { section: string; card1: string; card2: string; title2: string }
}

export function newCtx(page: Page, userDataCopy: string): Ctx {
  return {
    page,
    userDataCopy,
    mcp: null as unknown as McpClient,
    ids: { doc: '', home: '', mobile: '', menu: '', contact: '' },
    consoleErrors: [],
    failedRequests: [],
    checker: makeChecker('design-e2e'),
    cards: { section: '', card1: '', card2: '', title2: '' },
  }
}

// BFS through design_children_get: the cheapest way to find a node by name/tag.
export async function findNode(
  ctx: Ctx,
  artboardId: string,
  pred: (n: NodeItem) => boolean,
): Promise<NodeItem> {
  const queue: Array<string | null> = [null]
  while (queue.length) {
    const parent = queue.shift() ?? null
    const res = await ctx.mcp.call<{ items: NodeItem[] }>('design_children_get', {
      artboardId,
      nodeId: parent,
    })
    for (const it of res.items) {
      if (pred(it)) return it
      if (it.childCount > 0) queue.push(it.id)
    }
  }
  throw new Error(`node not found in ${artboardId}`)
}

export const byName = (name: string) => (n: NodeItem) => n.name === name

export async function selectedIds(ctx: Ctx): Promise<string[]> {
  const res = await ctx.mcp.call<{ nodeIds: string[] }>('design_selection_get', {
    docId: ctx.ids.doc,
  })
  return res.nodeIds ?? []
}

export async function nodeGet(
  ctx: Ctx,
  artboardId: string,
  nodeId: string,
): Promise<{ style: Record<string, string>; name?: string }> {
  const res = await ctx.mcp.call<{
    node: { style: Record<string, string>; name?: string }
  }>('design_node_get', { artboardId, nodeId })
  return res.node
}

export async function childIds(ctx: Ctx, artboardId: string, nodeId: string): Promise<string[]> {
  const res = await ctx.mcp.call<{ items: NodeItem[] }>('design_children_get', {
    artboardId,
    nodeId,
  })
  return res.items.map((i) => i.id)
}

export const homeIframe = (ctx: Ctx) => `[data-artboard="${ctx.ids.home}"]`

export function homeFrame(ctx: Ctx): Promise<Frame> {
  return waitForArtboardFrame(ctx.page, ctx.ids.home)
}

export function centerOf(ctx: Ctx, frame: Frame, nodeId: string) {
  return nodeCenterOnScreen(ctx.page, frame, homeIframe(ctx), HOME_WIDTH, pwSelector(nodeId))
}

// Row of the DocsPanel artboard list (select + fit to that artboard).
export function docsPanelRow(ctx: Ctx, name: string) {
  return ctx.page
    .locator('aside button', {
      has: ctx.page.locator('span', { hasText: new RegExp(`^${name}$`) }),
    })
    .first()
}

export const keyUndo = (ctx: Ctx) => ctx.page.keyboard.press('Control+z')
export const keyRedo = (ctx: Ctx) => ctx.page.keyboard.press('Control+Shift+z')
