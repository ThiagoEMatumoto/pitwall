import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { migrations } from '../migrations/index'

let testDb: Database.Database
vi.mock('../db', () => ({
  getDb: () => testDb,
}))

import * as store from './design-store'

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

describe('design folders', () => {
  beforeEach(() => {
    testDb = new Database(':memory:')
    testDb.pragma('foreign_keys = ON')
    applyAllMigrations(testDb)
  })

  afterEach(() => {
    vi.useRealTimers()
    testDb.close()
  })

  it('creates, lists in sort order and counts only active documents', () => {
    const a = store.createFolder({ name: '  Landing  ', color: '#f00' })
    const b = store.createFolder({ name: 'Apps' })
    expect(a).toMatchObject({ name: 'Landing', color: '#f00', sortOrder: 0, docCount: 0 })
    expect(b.sortOrder).toBe(1)

    store.createDocument({ title: 'One', folderId: a.id })
    const two = store.createDocument({ title: 'Two', folderId: a.id })
    store.archiveDocument(two.id)

    expect(store.listFolders().map((f) => [f.name, f.docCount])).toEqual([
      ['Landing', 1],
      ['Apps', 0],
    ])
  })

  it('updates name, color and sort order; null clears the color', () => {
    const f = store.createFolder({ name: 'A', color: 'blue' })
    const updated = store.updateFolder(f.id, { name: 'B', color: null, sortOrder: 9 })
    expect(updated).toMatchObject({ name: 'B', color: null, sortOrder: 9 })
    expect(store.updateFolder(f.id, {}).name).toBe('B')
    expect(() => store.updateFolder(f.id, { name: '  ' })).toThrow(/non-empty/)
    expect(() => store.updateFolder('nope', { name: 'x' })).toThrow(/not found/)
  })

  it('deleting a folder leaves its documents without a folder', () => {
    const f = store.createFolder({ name: 'Temp' })
    const doc = store.createDocument({ title: 'Doc', folderId: f.id })

    store.deleteFolder(f.id)

    expect(store.listFolders()).toEqual([])
    expect(store.getDocument(doc.id)!.folderId).toBeNull()
  })

  it('moving a document does not touch updated_at', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const f = store.createFolder({ name: 'F' })
    const doc = store.createDocument({ title: 'Doc' })
    vi.setSystemTime(5_000)

    store.moveDocument(doc.id, f.id)
    expect(store.getDocument(doc.id)).toMatchObject({ folderId: f.id, updatedAt: 1_000 })

    store.moveDocument(doc.id, null)
    expect(store.getDocument(doc.id)).toMatchObject({ folderId: null, updatedAt: 1_000 })
  })

  it('rejects unknown documents and folders on move/create', () => {
    const doc = store.createDocument({ title: 'Doc' })
    expect(() => store.moveDocument(doc.id, 'nope')).toThrow(/folder not found/)
    expect(() => store.moveDocument('nope', null)).toThrow(/document not found/)
    expect(() => store.createDocument({ title: 'X', folderId: 'nope' })).toThrow(/folder not found/)
  })

  it('filters the document list by folder id, or null for "no folder"', () => {
    const f = store.createFolder({ name: 'F' })
    const inside = store.createDocument({ title: 'Inside', folderId: f.id })
    const loose = store.createDocument({ title: 'Loose' })

    expect(store.listDocuments({ folderId: f.id }).map((d) => d.id)).toEqual([inside.id])
    expect(store.listDocuments({ folderId: null }).map((d) => d.id)).toEqual([loose.id])
    expect(
      store
        .listDocuments()
        .map((d) => d.id)
        .sort(),
    ).toEqual([inside.id, loose.id].sort())
  })

  it('ensureFolder matches case-insensitively and creates when missing', () => {
    const f = store.createFolder({ name: 'Marketing' })
    expect(store.ensureFolder('marketing').id).toBe(f.id)
    const created = store.ensureFolder('Sales')
    expect(created.id).not.toBe(f.id)
    expect(store.listFolders()).toHaveLength(2)
  })

  it('stores thumbnails without bumping updated_at and keeps the bytes out of the list', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const doc = store.createDocument({ title: 'Doc' })
    expect(store.listDocumentsWithoutThumbnail()).toEqual([doc.id])

    store.setThumbnail(doc.id, 'data:image/png;base64,AAA', 7_000)

    const [meta] = store.listDocuments()
    expect(meta).toMatchObject({ thumbnailVersion: '7000', updatedAt: 1_000 })
    expect(meta).not.toHaveProperty('thumbnail')
    expect(store.getThumbnail(doc.id)).toBe('data:image/png;base64,AAA')
    expect(store.listDocumentsWithoutThumbnail()).toEqual([])
  })
})
