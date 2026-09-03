// Shared state of the design-v2 scenario: the MCP client, the ids the tools
// returned, the checker and small helpers every step uses.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Frame, Page } from 'playwright'
import { REPO_ROOT } from '../../driver/launch'
import type { McpClient, McpRawResult } from '../../driver/mcp'
import {
  clickAt,
  nodeBoxInFrame,
  nodeCenterOnScreen,
  pwSelector,
  waitForArtboardFrame,
} from '../../driver/design'

export const SHOT = 'ds-v2'
export const SHOTS_DIR = join(REPO_ROOT, '.cm-drive', 'screenshots')

export type V2Key = 'landing' | 'menu' | 'poster'

export interface V2Ctx {
  page: Page
  mcp: McpClient
  docId: string
  ids: Record<V2Key, string>
  widths: Record<V2Key, number>
  check: (name: string, ok: boolean, detail?: string) => boolean
  log: (...a: unknown[]) => void
  // BFS through design_children_get: ids always come from a read.
  findId: (key: V2Key, name: string) => Promise<string>
}

interface NodeItem {
  id: string
  name?: string
  tag: string
  childCount: number
}

export function makeFindId(mcp: McpClient, ids: Record<V2Key, string>): V2Ctx['findId'] {
  const cache = new Map<string, string>()
  return async (key, name) => {
    const cacheKey = `${key}:${name}`
    const hit = cache.get(cacheKey)
    if (hit) return hit
    const queue: Array<string | null> = [null]
    while (queue.length) {
      const parent = queue.shift() ?? null
      const res = await mcp.call<{ items: NodeItem[] }>('design_children_get', {
        artboardId: ids[key],
        nodeId: parent,
      })
      for (const it of res.items) {
        if (it.name === name) {
          cache.set(cacheKey, it.id)
          return it.id
        }
        if (it.childCount > 0) queue.push(it.id)
      }
    }
    throw new Error(`node "${name}" not found in artboard ${key}`)
  }
}

export interface ShotMeta {
  width: number
  height: number
  sizing?: string
  tiles?: number
  measuredHeight?: number
}

export interface ToolShot {
  png: Buffer
  meta: ShotMeta
  file: string
}

// design_screenshot → PNG on disk + the meta the tool returned in its text block.
export async function shotViaTool(
  ctx: V2Ctx,
  key: V2Key,
  tag: string,
  args: Record<string, unknown> = {},
): Promise<ToolShot> {
  const raw: McpRawResult = await ctx.mcp.callRaw('design_screenshot', {
    artboardId: ctx.ids[key],
    ...args,
  })
  const image = raw.content?.find((c) => c.type === 'image')
  const text = raw.content?.find((c) => c.type === 'text')?.text
  const png = image?.data ? Buffer.from(image.data, 'base64') : Buffer.alloc(0)
  const meta = (text ? JSON.parse(text) : (raw.structuredContent ?? {})) as ShotMeta
  mkdirSync(SHOTS_DIR, { recursive: true })
  const file = join(SHOTS_DIR, `${SHOT}-${tag}.png`)
  writeFileSync(file, png)
  ctx.log(`design_screenshot ${key} (${tag}) → ${png.length} bytes ${JSON.stringify(meta)}`)
  return { png, meta, file }
}

// RGBA of one pixel of a PNG, decoded by the renderer (no PNG decoder in
// node): the evidence that a capture holds the whole layout, not a crop.
export async function samplePng(
  ctx: V2Ctx,
  png: Buffer,
  x: number,
  y: number,
): Promise<[number, number, number, number]> {
  return ctx.page.evaluate(
    ({ b64, x, y }) =>
      new Promise<[number, number, number, number]>((resolve, reject) => {
        const img = new Image()
        img.onload = () => {
          const c = document.createElement('canvas')
          c.width = img.width
          c.height = img.height
          const g = c.getContext('2d')
          if (!g) return reject(new Error('no 2d context'))
          g.drawImage(img, 0, 0)
          const d = g.getImageData(x, y, 1, 1).data
          resolve([d[0], d[1], d[2], d[3]])
        }
        img.onerror = () => reject(new Error('png decode failed'))
        img.src = `data:image/png;base64,${b64}`
      }),
    { b64: png.toString('base64'), x, y },
  )
}

export async function fitAll(ctx: V2Ctx): Promise<void> {
  await ctx.page.getByTitle('Ajustar à tela (Ctrl+0)').click()
  await ctx.page.waitForTimeout(700)
}

export async function editFrame(ctx: V2Ctx, key: V2Key): Promise<Frame> {
  return waitForArtboardFrame(ctx.page, ctx.ids[key])
}

// Clicks a node (by data-name) in an artboard's edit frame. `corner` aims at
// the node's top-left padding so a Ctrl+click picks the node itself.
export async function clickNode(
  ctx: V2Ctx,
  key: V2Key,
  name: string,
  opts: { ctrl?: boolean; corner?: boolean } = {},
): Promise<void> {
  const artboardId = ctx.ids[key]
  const frame = await editFrame(ctx, key)
  const id = await ctx.findId(key, name)
  let dx = 0
  let dy = 0
  if (opts.corner) {
    const box = await nodeBoxInFrame(frame, pwSelector(id))
    if (box) {
      dx = -box.w / 2 + 12
      dy = -box.h / 2 + 12
    }
  }
  const p = await nodeCenterOnScreen(
    ctx.page,
    frame,
    `[data-artboard="${artboardId}"]`,
    ctx.widths[key],
    pwSelector(id),
    { dx, dy },
  )
  await clickAt(ctx.page, p, { ctrl: opts.ctrl })
  await ctx.page.waitForTimeout(400)
}

// Attributes + inline style of one node inside a frame (null = not rendered).
export async function nodeAttrs(
  frame: Frame,
  nodeId: string,
): Promise<{
  attrs: Record<string, string>
  style: string
  classes: string[]
} | null> {
  return frame.evaluate((sel) => {
    const el = document.querySelector<HTMLElement>(sel)
    if (!el) return null
    const attrs: Record<string, string> = {}
    for (const a of Array.from(el.attributes)) attrs[a.name] = a.value
    // A patched style is re-serialised by the browser ("--pw-dur: 600ms;");
    // the rendered one is verbatim ("--pw-dur:600ms"). Compare without the spaces.
    const style = (el.getAttribute('style') ?? '').replace(/:\s+/g, ':').replace(/;\s+/g, ';')
    return {
      attrs,
      style,
      classes: Array.from(el.classList),
    }
  }, pwSelector(nodeId))
}
