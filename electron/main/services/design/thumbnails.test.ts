// @vitest-environment node
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { migrations } from '../migrations/index'

// Mocked only at the Electron boundary (window, nativeImage, the offscreen
// capture). Store, notify bus and scheduler run for real.
let testDb: Database.Database
vi.mock('../db', () => ({ getDb: () => testDb }))

const sent: Array<[string, unknown]> = []
const fakeImage = (width: number, height: number, pngBytes: number) => ({
  getSize: () => ({ width, height }),
  resize: vi.fn(({ width: w }: { width: number }) =>
    fakeImage(w, Math.round((height * w) / width), pngBytes),
  ),
  crop: vi.fn((r: { width: number; height: number }) => fakeImage(r.width, r.height, pngBytes)),
  toPNG: () => Buffer.alloc(pngBytes, 1),
  toJPEG: () => Buffer.from('jpeg'),
})
const imageState = { width: 1440, height: 900, pngBytes: 10 }
vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => [{ webContents: { send: (c: string, p: unknown) => sent.push([c, p]) } }],
  },
  nativeImage: {
    createFromBuffer: () => fakeImage(imageState.width, imageState.height, imageState.pngBytes),
  },
}))

const captureArtboard = vi.fn()
vi.mock('./screenshot', () => ({ captureArtboard: (...a: unknown[]) => captureArtboard(...a) }))

import * as store from './design-store'
import { broadcast } from '../notify'
import { THUMBNAIL_DEBOUNCE_MS, backfillThumbnails, installThumbnailScheduler } from './thumbnails'

function applyAllMigrations(db: Database.Database): void {
  for (const m of migrations) {
    if (m.disableForeignKeys) {
      db.pragma('foreign_keys = OFF')
      try {
        m.up(db)
      } finally {
        db.pragma('foreign_keys = ON')
      }
    } else {
      m.up(db)
    }
  }
}

function docWithArtboard(): { docId: string; artboardId: string } {
  const doc = store.createDocument({ title: 'Doc' })
  const ab = store.createArtboard({ docId: doc.id, name: 'Home', width: 1440, height: 900 })
  return { docId: doc.id, artboardId: ab.id }
}

const thumbEvents = () => sent.filter(([c]) => c === 'design:thumbnail-updated')

describe('thumbnail scheduler', () => {
  let uninstall: () => void

  beforeEach(() => {
    testDb = new Database(':memory:')
    testDb.pragma('foreign_keys = ON')
    applyAllMigrations(testDb)
    sent.length = 0
    Object.assign(imageState, { width: 1440, height: 900, pngBytes: 10 })
    captureArtboard.mockReset()
    captureArtboard.mockResolvedValue({
      png: Buffer.from('png'),
      width: 1440,
      height: 900,
      tiles: 1,
    })
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    uninstall = installThumbnailScheduler()
  })

  afterEach(() => {
    uninstall()
    vi.useRealTimers()
    testDb.close()
  })

  it('debounces edits per doc for 10s and captures the first artboard once', async () => {
    const { docId, artboardId } = docWithArtboard()
    const before = store.getDocument(docId)!.updatedAt

    broadcast('design:artboard-updated', { docId, artboardId })
    await vi.advanceTimersByTimeAsync(THUMBNAIL_DEBOUNCE_MS - 1)
    broadcast('design:document-updated', { docId })
    await vi.advanceTimersByTimeAsync(THUMBNAIL_DEBOUNCE_MS - 1)
    expect(captureArtboard).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)

    expect(captureArtboard).toHaveBeenCalledTimes(1)
    expect(captureArtboard.mock.calls[0][0]).toMatchObject({ artboardId, docId, scale: 1 })
    const meta = store.listDocuments()[0]
    expect(meta.thumbnailVersion).not.toBeNull()
    expect(meta.updatedAt).toBe(before)
    expect(store.getThumbnail(docId)).toMatch(/^data:image\/png;base64,/)
    expect(thumbEvents()).toEqual([
      ['design:thumbnail-updated', { docId, thumbnailVersion: meta.thumbnailVersion }],
    ])
  })

  it('stores JPEG when the resized PNG is over 200KB, and crops very tall artboards', async () => {
    Object.assign(imageState, { width: 1440, height: 14_400, pngBytes: 300 * 1024 })
    const { docId, artboardId } = docWithArtboard()

    broadcast('design:artboard-updated', { docId, artboardId })
    await vi.advanceTimersByTimeAsync(THUMBNAIL_DEBOUNCE_MS)

    expect(store.getThumbnail(docId)).toBe(
      `data:image/jpeg;base64,${Buffer.from('jpeg').toString('base64')}`,
    )
  })

  it('ignores moves and cancels on delete', async () => {
    const { docId } = docWithArtboard()

    broadcast('design:document-updated', { docId, folderId: null, moved: true })
    await vi.advanceTimersByTimeAsync(THUMBNAIL_DEBOUNCE_MS)
    expect(captureArtboard).not.toHaveBeenCalled()

    broadcast('design:document-updated', { docId })
    broadcast('design:document-deleted', { docId })
    await vi.advanceTimersByTimeAsync(THUMBNAIL_DEBOUNCE_MS)
    expect(captureArtboard).not.toHaveBeenCalled()
  })

  it('a doc without artboards stays without thumbnail', async () => {
    const doc = store.createDocument({ title: 'Empty' })

    broadcast('design:document-updated', { docId: doc.id })
    await vi.advanceTimersByTimeAsync(THUMBNAIL_DEBOUNCE_MS)

    expect(captureArtboard).not.toHaveBeenCalled()
    expect(store.listDocuments()[0].thumbnailVersion).toBeNull()
  })

  it('a failed capture is logged, not retried by backfill until the next edit', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { docId, artboardId } = docWithArtboard()
    captureArtboard.mockRejectedValueOnce(new Error('boom'))

    broadcast('design:artboard-updated', { docId, artboardId })
    await vi.advanceTimersByTimeAsync(THUMBNAIL_DEBOUNCE_MS)
    expect(warn).toHaveBeenCalled()
    expect(backfillThumbnails()).toBe(0)

    broadcast('design:artboard-updated', { docId, artboardId })
    await vi.advanceTimersByTimeAsync(THUMBNAIL_DEBOUNCE_MS)
    expect(captureArtboard).toHaveBeenCalledTimes(2)
    expect(store.getThumbnail(docId)).not.toBeNull()
    warn.mockRestore()
  })

  it('backfill captures active docs without thumbnail one at a time', async () => {
    const a = docWithArtboard()
    const b = docWithArtboard()
    const archived = docWithArtboard()
    store.archiveDocument(archived.docId)
    sent.length = 0
    let inFlight = 0
    let maxInFlight = 0
    captureArtboard.mockImplementation(async () => {
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((r) => setTimeout(r, 50))
      inFlight--
      return { png: Buffer.from('png'), width: 1440, height: 900, tiles: 1 }
    })

    expect(backfillThumbnails()).toBe(2)
    expect(backfillThumbnails()).toBe(0)
    await vi.advanceTimersByTimeAsync(200)

    expect(maxInFlight).toBe(1)
    expect(
      thumbEvents()
        .map(([, p]) => (p as { docId: string }).docId)
        .sort(),
    ).toEqual([a.docId, b.docId].sort())
    expect(store.getThumbnail(archived.docId)).toBeNull()
  })
})
