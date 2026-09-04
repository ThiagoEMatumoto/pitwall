import { BrowserWindow } from 'electron'
import { PDFDocument } from 'pdf-lib'
import { artboardUrl } from './protocol'
import {
  ARTBOARD_MAX_PX,
  MIN_FLOW_HEIGHT_PX,
  PDF_PAGE_TIMEOUT_MS,
  PDF_TOTAL_TIMEOUT_MS,
} from '../../../../shared/design/safety'
import type { ArtboardSizing } from '../../../../shared/types/design'

// Vector PDF of a whole document: one artboard is one page, with the page
// sized after the artboard instead of normalised to A4. printToPDF prints the
// page (text stays selectable) rather than rasterizing it, so the capture
// budget of screenshot.ts does not apply here.
//
// Its own hidden window and its own serial queue: sharing screenshot.ts's
// would make an export of 40 artboards fight every design_screenshot the
// agent makes meanwhile.

export interface PdfArtboardInput {
  artboardId: string
  docId: string
  width: number
  height: number
  sizing?: ArtboardSizing
}

export interface PdfExportResult {
  pdf: Buffer
  pages: number
}

const CSS_PX_PER_INCH = 96
const FONTS_TIMEOUT_MS = 2_000
const IDLE_DESTROY_MS = 60_000
// The layout viewport only has to be tall enough to load; printToPDF re-lays
// the content out against pageSize anyway.
const MAX_WINDOW_HEIGHT_PX = 4096

let win: BrowserWindow | null = null
let idleTimer: ReturnType<typeof setTimeout> | null = null
let queue: Promise<unknown> = Promise.resolve()

function getWindow(width: number, height: number): BrowserWindow {
  if (win && !win.isDestroyed()) return win
  win = new BrowserWindow({
    show: false,
    width,
    height,
    webPreferences: { sandbox: true, contextIsolation: true },
  })
  win.webContents.setAudioMuted(true)
  return win
}

export function destroyPdfWindow(): void {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = null
  if (win && !win.isDestroyed()) win.destroy()
  win = null
}

function touchIdle(): void {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = setTimeout(destroyPdfWindow, IDLE_DESTROY_MS)
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

function clampFlowHeight(h: unknown): number {
  const n = typeof h === 'number' && Number.isFinite(h) ? Math.ceil(h) : MIN_FLOW_HEIGHT_PX
  return Math.min(ARTBOARD_MAX_PX, Math.max(MIN_FLOW_HEIGHT_PX, n))
}

async function renderPage(input: PdfArtboardInput): Promise<Buffer> {
  const width = Math.max(1, Math.round(input.width))
  const w = getWindow(width, MAX_WINDOW_HEIGHT_PX)
  w.setContentSize(width, Math.min(Math.max(1, Math.round(input.height)), MAX_WINDOW_HEIGHT_PX))
  await w.loadURL(artboardUrl(input.artboardId, input.docId, 'shot'))
  // Google Fonts never resolve offline; a short race keeps the export moving.
  await Promise.race([
    w.webContents.executeJavaScript('document.fonts.ready.then(() => true)', true),
    sleep(FONTS_TIMEOUT_MS),
  ])

  let height = Math.max(1, Math.round(input.height))
  if (input.sizing === 'flow') {
    height = clampFlowHeight(await w.webContents.executeJavaScript('document.body.offsetHeight', true))
  }

  const data = await w.webContents.printToPDF({
    pageSize: { width: width / CSS_PX_PER_INCH, height: height / CSS_PX_PER_INCH },
    margins: { top: 0, bottom: 0, left: 0, right: 0 },
    // Default is false: backgrounds and images would silently drop out.
    printBackground: true,
    // The page is the artboard; content that overflows it by a fraction of a
    // px must not become a second, near-empty page.
    pageRanges: '1',
  })
  return Buffer.from(data)
}

async function merge(pdfs: Buffer[]): Promise<PdfExportResult> {
  const out = await PDFDocument.create()
  for (const bytes of pdfs) {
    const src = await PDFDocument.load(bytes)
    for (const page of await out.copyPages(src, src.getPageIndices())) out.addPage(page)
  }
  return { pdf: Buffer.from(await out.save()), pages: out.getPageCount() }
}

export function exportArtboardsPdf(artboards: readonly PdfArtboardInput[]): Promise<PdfExportResult> {
  if (artboards.length === 0) throw new Error('design pdf: no artboards to export')
  return enqueue(async () => {
    try {
      return await withTimeout(
        (async () => {
          const pdfs: Buffer[] = []
          for (const artboard of artboards) {
            pdfs.push(
              await withTimeout(renderPage(artboard), PDF_PAGE_TIMEOUT_MS, 'design pdf page'),
            )
          }
          return merge(pdfs)
        })(),
        PDF_TOTAL_TIMEOUT_MS,
        'design pdf',
      )
    } catch (err) {
      // A stuck load would poison every later export; start clean.
      if (err instanceof Error && err.name === 'AbortError') destroyPdfWindow()
      throw err
    } finally {
      touchIdle()
    }
  })
}
