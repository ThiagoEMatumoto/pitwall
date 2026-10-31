import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { migrations } from './migrations/index'
import { findCatalogEntry } from '../../../shared/diagram-library-catalog'

let testDb: Database.Database
vi.mock('./db', () => ({
  getDb: () => testDb,
}))

import * as store from './diagram-library-store'
import {
  installCatalogLibrary,
  installLibraryFromUrl,
  installedCatalogIds,
  removeCatalogLibrary,
} from './diagram-library-install'

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

const LIB = {
  type: 'excalidrawlib',
  version: 2,
  libraryItems: [
    { id: 'aws-1', name: 'EC2', status: 'published', elements: [{ id: 'e1' }], created: 1 },
    { id: 'aws-2', name: 'S3', status: 'published', elements: [{ id: 'e2' }], created: 1 },
  ],
}

function mockFetchOk(body: unknown): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }))
  vi.stubGlobal('fetch', fn)
  return fn
}

describe('diagram-library-install (catálogo)', () => {
  beforeEach(() => {
    testDb = new Database(':memory:')
    testDb.pragma('foreign_keys = ON')
    applyAllMigrations(testDb)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    testDb.close()
  })

  it('instala por catalogId baixando a URL raw da entrada e marca como instalada', async () => {
    const fetchMock = mockFetchOk(LIB)
    const result = await installCatalogLibrary('aws-architecture')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe(findCatalogEntry('aws-architecture')!.url)
    expect(result.added).toBe(2)
    expect(store.getItems().map((i) => i.id)).toEqual(['aws-1', 'aws-2'])
    expect(installedCatalogIds()).toEqual(['aws-architecture'])
  })

  it('instalar a URL do catálogo à mão também conta como instalada', async () => {
    mockFetchOk(LIB)
    await installLibraryFromUrl(findCatalogEntry('aws-architecture')!.url)
    expect(installedCatalogIds()).toEqual(['aws-architecture'])
  })

  it('catalogId desconhecido falha sem fazer fetch', async () => {
    const fetchMock = mockFetchOk(LIB)
    await expect(installCatalogLibrary('nope')).rejects.toThrow(/não está no catálogo/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('HTTP 404 vira erro legível e nada é marcado', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not found', { status: 404 })))
    await expect(installCatalogLibrary('gcp-icons')).rejects.toThrow(/HTTP 404/)
    expect(installedCatalogIds()).toEqual([])
  })

  it('estado instalado é derivado da biblioteca: apagar os itens no painel desmarca', async () => {
    mockFetchOk(LIB)
    await installCatalogLibrary('aws-architecture')
    store.replaceAll([])
    expect(installedCatalogIds()).toEqual([])
  })

  it('removeCatalogLibrary apaga só os itens daquela entrada', async () => {
    store.addItems([
      { id: 'mine', name: 'Meu', status: 'unpublished', elements: [], created: 1 },
    ])
    mockFetchOk(LIB)
    await installCatalogLibrary('aws-architecture')

    const items = removeCatalogLibrary('aws-architecture')
    expect(items.map((i) => i.id)).toEqual(['mine'])
    expect(installedCatalogIds()).toEqual([])
  })

  // uml-er e database do catálogo são .excalidrawlib v1: itens sem id, e o parser
  // gera um id novo a cada parse. Reinstalar não pode duplicar nem orfanar itens.
  const LIB_V1 = {
    type: 'excalidrawlib',
    version: 1,
    library: [[{ id: 'e1', type: 'rectangle' }], [{ id: 'e2', type: 'ellipse' }]],
  }

  it('reinstalar uma entrada v1 substitui os itens em vez de duplicar', async () => {
    store.addItems([
      { id: 'mine', name: 'Meu', status: 'unpublished', elements: [], created: 1 },
    ])
    mockFetchOk(LIB_V1)
    await installCatalogLibrary('uml-er')
    await installCatalogLibrary('uml-er')
    await installLibraryFromUrl(findCatalogEntry('uml-er')!.url)

    expect(store.getItems()).toHaveLength(3)
    expect(installedCatalogIds()).toEqual(['uml-er'])

    const items = removeCatalogLibrary('uml-er')
    expect(items.map((i) => i.id)).toEqual(['mine'])
  })

  it('reinstalação que falha no parse não apaga a instalação anterior', async () => {
    mockFetchOk(LIB_V1)
    await installCatalogLibrary('uml-er')
    mockFetchOk({ type: 'excalidrawlib', version: 1, library: ['quebrado'] })
    await expect(installCatalogLibrary('uml-er')).rejects.toThrow(/inválida/)

    expect(store.getItems()).toHaveLength(2)
    expect(installedCatalogIds()).toEqual(['uml-er'])
  })
})
