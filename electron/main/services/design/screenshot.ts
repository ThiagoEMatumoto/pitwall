import { BrowserWindow, nativeImage } from 'electron'
import { artboardUrl } from './protocol'
import { captureCacheKey, lookupCapture, rememberCapture } from './screenshot-cache'
import {
  assertCaptureBudget,
  captureTimeoutMs,
  composeBitmapTiles,
  planCaptureTiles,
  type BitmapTile,
  type CapturePlan,
} from './capture-plan'
import {
  ARTBOARD_MAX_PX,
  CAPTURE_TILE_MAX_PX,
  MIN_FLOW_HEIGHT_PX,
} from '../../../../shared/design/safety'
import type { ArtboardMotionPose } from '../../../../shared/design/html-render'
import type { ArtboardSizing, DesignExportScale } from '../../../../shared/types/design'

// Offscreen renderer for design_screenshot / design_computed_styles. One
// hidden window is shared by every capture: a serial queue keeps loads from
// interleaving, the CDP path (not capturePage) is what honours
// deviceScaleFactor, and the window is torn down after a minute idle so the
// software compositor does not sit on memory when nobody is designing.
//
// Tall captures are sliced: the device metrics are overridden ONCE with the
// full height (so vh units and position:fixed lay out once, not per slice),
// then each slice is a clipped Page.captureScreenshot composed with nativeImage.

export interface CaptureArtboardInput {
  artboardId: string
  docId: string
  width: number
  // For a flow artboard this is the last measured height; the capture
  // re-measures and reports it back as measuredHeight.
  height: number
  sizing?: ArtboardSizing
  scale: DesignExportScale
  // Omitted = 'final' (after every entrance animation).
  motion?: ArtboardMotionPose
  // Part of the cache key; without it the capture is never cached.
  version?: number
  // Document-level changes (tokens, fonts, globalCss) do not bump the
  // artboard version; the document's updatedAt keys them.
  docUpdatedAt?: number
  nodeId?: string
}

export interface CaptureArtboardResult {
  png: Buffer
  width: number
  height: number
  // Slices composed into this PNG.
  tiles: number
  // Flow artboards only: content height (css px) seen by the offscreen window.
  measuredHeight?: number
}

export interface ComputeStylesInput {
  artboardId: string
  docId: string
  nodeIds: string[]
  props: string[]
  // Viewport for the measurement; %/vw values depend on it. Defaults to 1024×768.
  width?: number
  height?: number
}

export type ComputedStyles = Record<string, Record<string, string>>

const LOAD_TIMEOUT_MS = 10_000
const FONTS_TIMEOUT_MS = 2_000
const IDLE_DESTROY_MS = 60_000
const DEFAULT_STYLES_VIEWPORT = { width: 1024, height: 768 }

interface ClipRect {
  x: number
  y: number
  width: number
  height: number
}

let win: BrowserWindow | null = null
let idleTimer: ReturnType<typeof setTimeout> | null = null
let queue: Promise<unknown> = Promise.resolve()

function getWindow(width: number, height: number): BrowserWindow {
  if (win && !win.isDestroyed()) return win
  win = new BrowserWindow({
    show: false,
    width,
    height,
    webPreferences: { offscreen: true, sandbox: true, contextIsolation: true },
  })
  win.webContents.setAudioMuted(true)
  return win
}

export function destroyScreenshotWindow(): void {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = null
  if (win && !win.isDestroyed()) win.destroy()
  win = null
}

function touchIdle(): void {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = setTimeout(destroyScreenshotWindow, IDLE_DESTROY_MS)
}

function enqueue<T>(job: () => Promise<T>): Promise<T> {
  const run = queue.then(job, job)
  queue = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`${label} timed out after ${ms}ms`)
      err.name = 'AbortError'
      reject(err)
    }, ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

// The window itself never needs to be taller than one slice; the metrics
// override is what sets the layout viewport.
function windowHeight(height: number): number {
  return Math.min(height, CAPTURE_TILE_MAX_PX)
}

async function loadArtboard(
  w: BrowserWindow,
  artboardId: string,
  docId: string,
  motion?: ArtboardMotionPose,
): Promise<void> {
  await w.loadURL(artboardUrl(artboardId, docId, 'shot', undefined, motion))
  // Google Fonts never resolve offline; a short race keeps the capture moving.
  await Promise.race([
    w.webContents.executeJavaScript('document.fonts.ready.then(() => true)', true),
    sleep(FONTS_TIMEOUT_MS),
  ])
}

function nodeRectScript(nodeId: string): string {
  return `(() => {
    const el = document.querySelector('[data-pw-id="' + CSS.escape(${JSON.stringify(nodeId)}) + '"]')
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: r.left + window.scrollX, y: r.top + window.scrollY, width: r.width, height: r.height }
  })()`
}

const SCROLL_HEIGHT_SCRIPT =
  'Math.max(document.documentElement.scrollHeight, document.body.scrollHeight)'

function clampFlowHeight(h: unknown): number {
  const n = typeof h === 'number' && Number.isFinite(h) ? Math.ceil(h) : MIN_FLOW_HEIGHT_PX
  return Math.min(ARTBOARD_MAX_PX, Math.max(MIN_FLOW_HEIGHT_PX, n))
}

interface Prepared {
  w: BrowserWindow
  // Rect to rasterize, css px of the page.
  rect: ClipRect
  measuredHeight?: number
}

async function prepare(input: CaptureArtboardInput): Promise<Prepared> {
  const { artboardId, docId, width, nodeId, motion } = input
  const w = getWindow(width, windowHeight(input.height))
  w.setContentSize(width, windowHeight(input.height))
  await loadArtboard(w, artboardId, docId, motion)

  let height = input.height
  let measuredHeight: number | undefined
  if (input.sizing === 'flow') {
    measuredHeight = clampFlowHeight(
      await w.webContents.executeJavaScript(SCROLL_HEIGHT_SCRIPT, true),
    )
    height = measuredHeight
  }

  let rect: ClipRect = { x: 0, y: 0, width, height }
  if (nodeId) {
    const found = (await w.webContents.executeJavaScript(
      nodeRectScript(nodeId),
      true,
    )) as ClipRect | null
    if (!found) throw new Error(`node not found: ${nodeId}`)
    rect = {
      x: Math.round(found.x),
      y: Math.round(found.y),
      width: Math.max(1, Math.ceil(found.width)),
      height: Math.max(1, Math.ceil(found.height)),
    }
  }
  return { w, rect, measuredHeight }
}

async function captureTile(
  dbg: Electron.Debugger,
  rect: ClipRect,
  y: number,
  h: number,
): Promise<Buffer> {
  const { data } = (await dbg.sendCommand('Page.captureScreenshot', {
    format: 'png',
    clip: { x: rect.x, y: rect.y + y, width: rect.width, height: h, scale: 1 },
    captureBeyondViewport: true,
  })) as { data: string }
  return Buffer.from(data, 'base64')
}

async function rasterize(
  w: BrowserWindow,
  rect: ClipRect,
  page: { width: number; height: number },
  scale: number,
  plan: CapturePlan,
): Promise<Buffer> {
  const dbg = w.webContents.debugger
  if (!dbg.isAttached()) dbg.attach('1.3')
  await dbg.sendCommand('Emulation.setDeviceMetricsOverride', {
    width: page.width,
    height: page.height,
    deviceScaleFactor: scale,
    mobile: false,
  })
  try {
    if (plan.tiles.length === 1) return captureTile(dbg, rect, 0, plan.tiles[0].h)
    const bitmaps: BitmapTile[] = []
    let outW = plan.outW
    for (const [i, tile] of plan.tiles.entries()) {
      const img = nativeImage.createFromBuffer(await captureTile(dbg, rect, tile.y, tile.h))
      const size = img.getSize()
      // Chromium rounds the scaled clip itself; trust the first tile's width.
      if (i === 0) outW = size.width
      bitmaps.push({ bitmap: img.toBitmap(), h: size.height })
    }
    const composed = composeBitmapTiles(bitmaps, outW)
    return nativeImage
      .createFromBitmap(composed.bitmap, {
        width: composed.width,
        height: composed.height,
      })
      .toPNG()
  } finally {
    await dbg.sendCommand('Emulation.clearDeviceMetricsOverride').catch(() => undefined)
  }
}

async function capture(input: CaptureArtboardInput): Promise<CaptureArtboardResult> {
  const { w, rect, measuredHeight } = await withTimeout(
    prepare(input),
    LOAD_TIMEOUT_MS,
    'design screenshot load',
  )
  const planInput = {
    width: rect.width,
    height: rect.height,
    scale: input.scale,
  }
  const plan = planCaptureTiles(planInput)
  assertCaptureBudget(planInput, plan)
  const page = { width: input.width, height: measuredHeight ?? input.height }
  const png = await withTimeout(
    rasterize(w, rect, page, input.scale, plan),
    captureTimeoutMs(plan.tiles.length),
    'design screenshot',
  )
  return {
    png,
    width: plan.outW,
    height: plan.outH,
    tiles: plan.tiles.length,
    measuredHeight,
  }
}

export function captureArtboard(input: CaptureArtboardInput): Promise<CaptureArtboardResult> {
  // A fixed artboard over budget fails before it queues; a flow one is
  // re-checked against the measured height inside capture().
  if (input.sizing !== 'flow' && !input.nodeId) {
    const planInput = {
      width: input.width,
      height: input.height,
      scale: input.scale,
    }
    assertCaptureBudget(planInput, planCaptureTiles(planInput))
  }
  const key = captureCacheKey(input)
  if (key) {
    const hit = lookupCapture(key)
    if (hit) return Promise.resolve(hit)
  }
  return enqueue(async () => {
    try {
      const result = await capture(input)
      if (key) rememberCapture(key, result)
      return result
    } catch (err) {
      // A stuck load would poison every later capture; start clean.
      if (err instanceof Error && err.name === 'AbortError') destroyScreenshotWindow()
      throw err
    } finally {
      touchIdle()
    }
  })
}

function computedStylesScript(nodeIds: string[], props: string[]): string {
  return `(() => {
    const ids = ${JSON.stringify(nodeIds)}
    const props = ${JSON.stringify(props)}
    const out = {}
    for (const id of ids) {
      const el = document.querySelector('[data-pw-id="' + CSS.escape(id) + '"]')
      if (!el) continue
      const cs = getComputedStyle(el)
      const values = {}
      for (const p of props) values[p] = cs.getPropertyValue(p)
      out[id] = values
    }
    return out
  })()`
}

export function computeStyles(input: ComputeStylesInput): Promise<ComputedStyles> {
  const width = input.width ?? DEFAULT_STYLES_VIEWPORT.width
  const height = windowHeight(input.height ?? DEFAULT_STYLES_VIEWPORT.height)
  return enqueue(async () => {
    try {
      return await withTimeout(
        (async () => {
          const w = getWindow(width, height)
          w.setContentSize(width, height)
          await loadArtboard(w, input.artboardId, input.docId)
          return (await w.webContents.executeJavaScript(
            computedStylesScript(input.nodeIds, input.props),
            true,
          )) as ComputedStyles
        })(),
        LOAD_TIMEOUT_MS,
        'design computed styles',
      )
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') destroyScreenshotWindow()
      throw err
    } finally {
      touchIdle()
    }
  })
}
