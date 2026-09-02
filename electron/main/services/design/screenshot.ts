import { BrowserWindow } from 'electron'
import { artboardUrl } from './protocol'

// Offscreen renderer for design_screenshot / design_computed_styles. One
// hidden window is shared by every capture: a serial queue keeps loads from
// interleaving, the CDP path (not capturePage) is what honours
// deviceScaleFactor, and the window is torn down after a minute idle so the
// software compositor does not sit on memory when nobody is designing.

export interface CaptureArtboardInput {
  artboardId: string
  docId: string
  width: number
  height: number
  scale: 1 | 2
  // Part of the cache key; without it the capture is never cached.
  version?: number
  nodeId?: string
}

export interface CaptureArtboardResult {
  png: Buffer
  width: number
  height: number
}

export interface ComputeStylesInput {
  artboardId: string
  docId: string
  nodeIds: string[]
  props: string[]
}

export type ComputedStyles = Record<string, Record<string, string>>

const TOTAL_TIMEOUT_MS = 10_000
const FONTS_TIMEOUT_MS = 2_000
const IDLE_DESTROY_MS = 60_000
const CACHE_MAX = 20

interface ClipRect {
  x: number
  y: number
  width: number
  height: number
}

let win: BrowserWindow | null = null
let idleTimer: ReturnType<typeof setTimeout> | null = null
let queue: Promise<unknown> = Promise.resolve()
const cache = new Map<string, CaptureArtboardResult>()

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

async function loadArtboard(w: BrowserWindow, artboardId: string, docId: string): Promise<void> {
  await w.loadURL(artboardUrl(artboardId, docId, 'shot'))
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
    return { x: r.left, y: r.top, width: r.width, height: r.height }
  })()`
}

async function capture(input: CaptureArtboardInput): Promise<CaptureArtboardResult> {
  const { artboardId, docId, width, height, scale, nodeId } = input
  const w = getWindow(width, height)
  w.setContentSize(width, height)
  await loadArtboard(w, artboardId, docId)

  let clip: ClipRect | null = null
  if (nodeId) {
    clip = (await w.webContents.executeJavaScript(nodeRectScript(nodeId), true)) as ClipRect | null
    if (!clip) throw new Error(`node not found: ${nodeId}`)
  }

  const dbg = w.webContents.debugger
  if (!dbg.isAttached()) dbg.attach('1.3')
  await dbg.sendCommand('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: scale,
    mobile: false,
  })
  try {
    const { data } = (await dbg.sendCommand('Page.captureScreenshot', {
      format: 'png',
      ...(clip ? { clip: { ...clip, scale: 1 } } : {}),
    })) as { data: string }
    const outW = Math.round((clip ? clip.width : width) * scale)
    const outH = Math.round((clip ? clip.height : height) * scale)
    return { png: Buffer.from(data, 'base64'), width: outW, height: outH }
  } finally {
    await dbg.sendCommand('Emulation.clearDeviceMetricsOverride').catch(() => undefined)
  }
}

function cacheKey(input: CaptureArtboardInput): string | null {
  if (input.version == null) return null
  return `${input.artboardId}:${input.version}:${input.scale}:${input.nodeId ?? ''}`
}

function remember(key: string, result: CaptureArtboardResult): void {
  cache.delete(key)
  cache.set(key, result)
  if (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
}

export function captureArtboard(input: CaptureArtboardInput): Promise<CaptureArtboardResult> {
  const key = cacheKey(input)
  if (key) {
    const hit = cache.get(key)
    if (hit) {
      // Refresh recency so hot artboards survive eviction.
      remember(key, hit)
      return Promise.resolve(hit)
    }
  }
  return enqueue(async () => {
    try {
      const result = await withTimeout(capture(input), TOTAL_TIMEOUT_MS, 'design screenshot')
      if (key) remember(key, result)
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
  return enqueue(async () => {
    try {
      return await withTimeout(
        (async () => {
          const w = getWindow(1024, 768)
          await loadArtboard(w, input.artboardId, input.docId)
          return (await w.webContents.executeJavaScript(
            computedStylesScript(input.nodeIds, input.props),
            true,
          )) as ComputedStyles
        })(),
        TOTAL_TIMEOUT_MS,
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
