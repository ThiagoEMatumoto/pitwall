// Design Studio helpers for drive-app scenarios: find an artboard's sandboxed
// iframe, translate node rects into window coordinates (the iframe is scaled
// by the stage zoom), click/drag nodes through the InteractionLayer and read
// computed styles from inside the frame.
import type { Frame, Page } from 'playwright'

export interface NodeBox {
  x: number
  y: number
  w: number
  h: number
}

export const ARTBOARD_URL_PREFIX = 'pitwall-design://artboard/'

function frameUrlMatches(f: Frame, artboardId: string, mode: 'edit' | 'preview'): boolean {
  const url = f.url()
  return (
    url.startsWith(ARTBOARD_URL_PREFIX + encodeURIComponent(artboardId)) &&
    url.includes(`mode=${mode}`)
  )
}

// Frame of one artboard. The canvas frame is `edit`; PreviewMode mounts a
// second iframe for the same artboard with `mode=preview`.
export async function waitForArtboardFrame(
  page: Page,
  artboardId: string,
  opts: { mode?: 'edit' | 'preview'; timeoutMs?: number } = {},
): Promise<Frame> {
  const mode = opts.mode ?? 'edit'
  const deadline = Date.now() + (opts.timeoutMs ?? 10_000)
  while (Date.now() < deadline) {
    const frame = page.frames().find((f) => frameUrlMatches(f, artboardId, mode))
    if (frame) {
      const nodes = await frame
        .locator('[data-pw-id]')
        .count()
        .catch(() => 0)
      if (nodes > 0) return frame
    }
    await page.waitForTimeout(200)
  }
  const urls = page.frames().map((f) => f.url())
  throw new Error(
    `artboard frame ${artboardId} (${mode}) not found; frames: ${JSON.stringify(urls)}`,
  )
}

// The preview is a single player iframe: its URL names the artboard it booted
// with and later screens arrive through `navigate`, so it is found by mode
// alone. The title follows the artboard on screen ("Preview: <name>").
export const PREVIEW_IFRAME_SELECTOR = 'iframe[title^="Preview: "]'

export async function waitForPreviewFrame(page: Page, timeoutMs = 10_000): Promise<Frame> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const frame = page
      .frames()
      .find((f) => f.url().startsWith(ARTBOARD_URL_PREFIX) && f.url().includes('mode=preview'))
    if (frame) {
      const nodes = await frame
        .locator('[data-pw-id]')
        .count()
        .catch(() => 0)
      if (nodes > 0) return frame
    }
    await page.waitForTimeout(200)
  }
  const urls = page.frames().map((f) => f.url())
  throw new Error(`preview frame not found; frames: ${JSON.stringify(urls)}`)
}

export async function nodeBoxInFrame(frame: Frame, selector: string): Promise<NodeBox | null> {
  return frame.evaluate((sel) => {
    const el = document.querySelector(sel)
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: r.x, y: r.y, w: r.width, h: r.height }
  }, selector)
}

export interface ScreenPoint {
  x: number
  y: number
  zoom: number
}

// Window coordinates of a node's center: iframe box on screen + node rect
// scaled by the effective zoom (iframe box width / artboard width).
export async function nodeCenterOnScreen(
  page: Page,
  frame: Frame,
  iframeSelector: string,
  artboardWidth: number,
  nodeSelector: string,
  offset: { dx?: number; dy?: number } = {},
): Promise<ScreenPoint> {
  const box = await page.locator(iframeSelector).first().boundingBox()
  if (!box) throw new Error(`iframe ${iframeSelector} has no bounding box`)
  const node = await nodeBoxInFrame(frame, nodeSelector)
  if (!node) throw new Error(`node ${nodeSelector} not found in frame`)
  const zoom = box.width / artboardWidth
  return {
    x: box.x + (node.x + node.w / 2 + (offset.dx ?? 0)) * zoom,
    y: box.y + (node.y + node.h / 2 + (offset.dy ?? 0)) * zoom,
    zoom,
  }
}

export function pwSelector(nodeId: string): string {
  return `[data-pw-id="${nodeId.replace(/"/g, '\\"')}"]`
}

export async function clickAt(
  page: Page,
  p: ScreenPoint,
  modifiers: { ctrl?: boolean } = {},
): Promise<void> {
  await page.mouse.move(p.x, p.y)
  await page.waitForTimeout(120)
  if (modifiers.ctrl) await page.keyboard.down('Control')
  await page.mouse.click(p.x, p.y)
  if (modifiers.ctrl) await page.keyboard.up('Control')
}

// Press, move in steps (the runner needs the hit-test reply before it turns
// a press into a move gesture) and release. dx/dy are window pixels.
export async function dragFrom(
  page: Page,
  from: ScreenPoint,
  dx: number,
  dy: number,
  steps = 12,
): Promise<void> {
  await page.mouse.move(from.x, from.y)
  await page.waitForTimeout(120)
  await page.mouse.down()
  await page.waitForTimeout(150)
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(from.x + (dx * i) / steps, from.y + (dy * i) / steps)
    await page.waitForTimeout(40)
  }
  await page.waitForTimeout(250)
  await page.mouse.up()
}

export async function computedIn(frame: Frame, nodeId: string, prop: string): Promise<string> {
  return frame.evaluate(
    ([id, p]) => {
      const el = document.querySelector(`[data-pw-id="${CSS.escape(id)}"]`)
      return el ? getComputedStyle(el).getPropertyValue(p) : 'missing'
    },
    [nodeId, prop] as const,
  )
}

// Polls until `read()` returns `expected` (or the deadline passes) and
// returns the last value seen.
export async function waitForValue<T>(
  read: () => Promise<T>,
  expected: T,
  timeoutMs = 1000,
  stepMs = 50,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let last = await read()
  while (last !== expected && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, stepMs))
    last = await read()
  }
  return last
}

export interface Check {
  name: string
  ok: boolean
  detail: string
}

export function makeChecker(tag: string) {
  const checks: Check[] = []
  const log = (...a: unknown[]) => console.log(`[${tag}]`, ...a)
  function check(name: string, ok: boolean, detail = ''): boolean {
    checks.push({ name, ok, detail })
    log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
    return ok
  }
  // Runs a step; an exception becomes a FAIL with the message.
  async function step(name: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn()
    } catch (err) {
      check(
        name,
        false,
        String(err instanceof Error ? (err.stack ?? err.message) : err).slice(0, 1200),
      )
    }
  }
  return { checks, log, check, step }
}
