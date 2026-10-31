import { nativeImage } from 'electron'
import * as designStore from './design-store'
import { captureArtboard } from './screenshot'
import { broadcast, onBroadcast } from '../notify'
import type { DesignThumbnailUpdatedEvent } from '../../../../shared/types/design'

// Hub thumbnails: the first artboard of the first page, captured through the
// screenshot queue and stored as a data URL in design_documents.thumbnail.
//
// Scheduling hangs off the broadcast bus instead of the mutation sites: IPC,
// MCP and mutate.ts all announce changes there, so one listener sees every
// edit without each writer having to remember the thumbnail.

export const THUMBNAIL_DEBOUNCE_MS = 10_000
const THUMB_WIDTH = 480
// A flow landing page can be 10× taller than wide; the card only ever shows
// the top, so the stored image stops at this height.
const THUMB_MAX_HEIGHT = 1_200
const MAX_PNG_BYTES = 200 * 1024
const JPEG_QUALITY = 80

const RESCHEDULE_CHANNELS: ReadonlySet<string> = new Set([
  'design:artboard-updated',
  'design:artboard-deleted',
  'design:document-updated',
])

const timers = new Map<string, ReturnType<typeof setTimeout>>()
// Docs whose last capture failed: the backfill skips them until the next edit
// so a broken artboard is not re-rendered every time the hub opens.
const failed = new Set<string>()
let backfillRunning = false

function encode(png: Buffer): string {
  let img = nativeImage.createFromBuffer(png)
  if (img.getSize().width > THUMB_WIDTH) img = img.resize({ width: THUMB_WIDTH })
  const { width, height } = img.getSize()
  if (height > THUMB_MAX_HEIGHT) img = img.crop({ x: 0, y: 0, width, height: THUMB_MAX_HEIGHT })
  const asPng = img.toPNG()
  if (asPng.byteLength <= MAX_PNG_BYTES) return `data:image/png;base64,${asPng.toString('base64')}`
  return `data:image/jpeg;base64,${img.toJPEG(JPEG_QUALITY).toString('base64')}`
}

// Resolves to the new thumbnailVersion, or null when there is nothing to
// capture (no document, no artboard). Capture errors propagate.
export async function generateThumbnail(docId: string): Promise<string | null> {
  const doc = designStore.getDocument(docId)
  const artboard = doc?.pages[0]?.artboards[0]
  if (!doc || !artboard) return null
  const shot = await captureArtboard({
    artboardId: artboard.id,
    docId,
    width: artboard.width,
    height: artboard.height,
    sizing: artboard.sizing,
    scale: 1,
    version: artboard.version,
    docUpdatedAt: doc.updatedAt,
  })
  const at = Date.now()
  if (!designStore.setThumbnail(docId, encode(shot.png), at)) return null
  const event: DesignThumbnailUpdatedEvent = { docId, thumbnailVersion: String(at) }
  broadcast('design:thumbnail-updated', event)
  return event.thumbnailVersion
}

async function refresh(docId: string): Promise<void> {
  try {
    await generateThumbnail(docId)
    failed.delete(docId)
  } catch (err) {
    failed.add(docId)
    console.warn(`[design] thumbnail capture failed for ${docId}:`, err)
  }
}

export function scheduleThumbnail(docId: string): void {
  failed.delete(docId)
  const pending = timers.get(docId)
  if (pending) clearTimeout(pending)
  timers.set(
    docId,
    setTimeout(() => {
      timers.delete(docId)
      void refresh(docId)
    }, THUMBNAIL_DEBOUNCE_MS),
  )
}

function cancelThumbnail(docId: string): void {
  const pending = timers.get(docId)
  if (pending) clearTimeout(pending)
  timers.delete(docId)
  failed.delete(docId)
}

// One capture at a time so the hub's backfill never crowds out an agent's
// design_screenshot in the shared queue. Returns how many docs were queued
// (0 when a backfill is already running).
export function backfillThumbnails(): number {
  if (backfillRunning) return 0
  const ids = designStore
    .listDocumentsWithoutThumbnail()
    .filter((id) => !failed.has(id) && !timers.has(id))
  if (ids.length === 0) return 0
  backfillRunning = true
  void (async () => {
    try {
      for (const id of ids) await refresh(id)
    } finally {
      backfillRunning = false
    }
  })()
  return ids.length
}

export function installThumbnailScheduler(): () => void {
  return onBroadcast('design:', (channel, payload) => {
    const { docId, moved } = (payload ?? {}) as { docId?: unknown; moved?: unknown }
    if (typeof docId !== 'string') return
    if (channel === 'design:document-deleted') return cancelThumbnail(docId)
    // Filing a doc into a folder changes nothing it renders.
    if (RESCHEDULE_CHANNELS.has(channel) && moved !== true) scheduleThumbnail(docId)
  })
}
