/** @vitest-environment node */
// Folder support in the design_* tools, against a real better-sqlite3 DB (tmp
// dir) like design-tools.test.ts.
import { rmSync } from 'node:fs'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'mcp-design-folders-test-'))
  return {
    app: { getPath: () => dir, getVersion: () => '0.0.0-test' },
    BrowserWindow: { getAllWindows: () => [] },
  }
})

vi.mock('../design/screenshot', () => ({
  captureArtboard: () => Promise.reject(new Error('BrowserWindow is not a constructor')),
  computeStyles: () => Promise.reject(new Error('BrowserWindow is not a constructor')),
}))

import { app } from 'electron'
import { closeDb } from '../db'
import * as designStore from '../design/design-store'
import type { DesignDocumentMeta, DesignFolder } from '../../../../shared/types/design'
import { makeHarness } from './design-tools-test-support'

const { notify, call } = makeHarness()

afterAll(() => {
  closeDb()
  rmSync(app.getPath('userData'), { recursive: true, force: true })
})

type CreateResult = { document: { id: string; folderId: string | null } }
type ListResult = { items: DesignDocumentMeta[]; note?: string }

describe('design tools — folders', () => {
  beforeEach(() => {
    notify.calls.length = 0
  })

  it('design_document_create with a new folder creates it and files the doc', async () => {
    const { document } = await call<CreateResult>('design_document_create', {
      title: 'Landing',
      folder: 'Marketing',
    })
    const { items } = await call<{ items: DesignFolder[] }>('design_folder_list', {})

    expect(items).toEqual([expect.objectContaining({ name: 'Marketing', docCount: 1 })])
    expect(document.folderId).toBe(items[0].id)
    expect(notify.calls.map(([c]) => c)).toEqual([
      'design:document-updated',
      'design:folders-updated',
    ])
  })

  it('design_document_create reuses an existing folder case-insensitively', async () => {
    const { document } = await call<CreateResult>('design_document_create', {
      title: 'Ads',
      folder: 'marketing',
    })
    const { items } = await call<{ items: DesignFolder[] }>('design_folder_list', {})

    expect(items).toHaveLength(1)
    expect(items[0].docCount).toBe(2)
    expect(document.folderId).toBe(items[0].id)
  })

  it('design_document_list returns folderId and filters by folder name or null', async () => {
    const loose = await call<CreateResult>('design_document_create', { title: 'Loose' })

    const inFolder = await call<ListResult>('design_document_list', { folder: 'MARKETING' })
    expect(inFolder.items.map((d) => d.title).sort()).toEqual(['Ads', 'Landing'])
    expect(inFolder.items.every((d) => typeof d.folderId === 'string')).toBe(true)

    const noFolder = await call<ListResult>('design_document_list', { folder: null })
    expect(noFolder.items.map((d) => d.id)).toEqual([loose.document.id])

    const missing = await call<ListResult>('design_document_list', { folder: 'Nope' })
    expect(missing).toEqual({ items: [], note: 'no folder named "Nope"' })
  })

  it('design_document_move files into a (new) folder, out with null, without bumping updatedAt', async () => {
    const { document } = await call<CreateResult>('design_document_create', { title: 'Mover' })
    const before = designStore.getDocumentMeta(document.id)!.updatedAt
    notify.calls.length = 0

    const moved = await call<{ document: DesignDocumentMeta }>('design_document_move', {
      documentId: document.id,
      folder: 'Archive 2026',
    })
    const folder = designStore.findFolderByName('archive 2026')!
    expect(moved.document).toMatchObject({ folderId: folder.id, updatedAt: before })
    expect(notify.calls).toEqual([
      ['design:document-updated', { docId: document.id, folderId: folder.id, moved: true }],
      ['design:folders-updated', { folderId: folder.id }],
    ])

    const out = await call<{ document: DesignDocumentMeta }>('design_document_move', {
      documentId: document.id,
      folder: null,
    })
    expect(out.document).toMatchObject({ folderId: null, updatedAt: before })
  })

  it('design_document_move rejects an unknown document', async () => {
    await expect(
      call('design_document_move', { documentId: 'nope', folder: null }),
    ).rejects.toThrow(/document not found/)
  })
})
