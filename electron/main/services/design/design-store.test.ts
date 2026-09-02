import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { migrations } from '../migrations/index'
import * as designStudioMigration from '../migrations/046_design_studio'
import type { DesignNode } from '../../../../shared/types/design'

// Mesmo padrão de diagram-store.test: o store importa getDb de '../db' (que
// depende de electron.app); mockamos pra um SQLite in-memory migrado.
let testDb: Database.Database
vi.mock('../db', () => ({
  getDb: () => testDb,
}))

import * as store from './design-store'
import * as assets from './asset-store'

// Real PNG magic so the upload sniff accepts the fake bytes.
const png = (tail: string): Buffer =>
  Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(tail)])

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
  // Até a integração registrar a 045 em migrations/index.ts, aplicamos à mão.
  if (!migrations.some((m) => m.version === designStudioMigration.version)) {
    designStudioMigration.up(db)
  }
}

function textNode(id: string, text: string): DesignNode {
  return { id, tag: 'p', kind: 'text', style: {}, attrs: {}, text, children: [] }
}

function tree(label: string): DesignNode {
  return {
    id: 'root',
    tag: 'div',
    kind: 'frame',
    style: { position: 'relative' },
    attrs: {},
    children: [textNode('t1', label), textNode('t2', `${label}-b`)],
  }
}

function collectIds(node: DesignNode): string[] {
  return [node.id, ...node.children.flatMap(collectIds)]
}

function newDoc(title = 'Landing') {
  return store.createDocument({ title, links: [{ parentType: 'feature', parentId: 'f1' }] })
}

describe('design-store', () => {
  beforeEach(() => {
    testDb = new Database(':memory:')
    testDb.pragma('foreign_keys = ON')
    applyAllMigrations(testDb)
  })

  afterEach(() => {
    testDb.close()
  })

  it('createDocument nasce com 1 página "Page 1", defaults e links', () => {
    const doc = newDoc()
    expect(doc.status).toBe('active')
    expect(doc.tokens).toEqual({})
    expect(doc.fonts).toEqual([])
    expect(doc.globalCss).toBe('')
    expect(doc.pages).toHaveLength(1)
    expect(doc.pages[0]).toMatchObject({ name: 'Page 1', position: 0, artboards: [] })
    expect(doc.pages[0].viewport).toEqual({ x: 0, y: 0, zoom: 1 })
    expect(doc.links).toEqual([{ documentId: doc.id, parentType: 'feature', parentId: 'f1' }])
  })

  it('createArtboard sem pageId cai na primeira página, com frame raiz e versão 1', () => {
    const doc = newDoc()
    const ab = store.createArtboard({ docId: doc.id, name: 'Home', width: 1440, height: 900 })
    expect(ab.pageId).toBe(doc.pages[0].id)
    expect(ab.version).toBe(1)
    expect(ab.tree).toMatchObject({
      tag: 'div',
      kind: 'frame',
      style: { position: 'relative', width: '100%', height: '100%', background: '#ffffff' },
      children: [],
    })
    expect(store.listVersions(ab.id)).toHaveLength(1)
    expect(store.getDocument(doc.id)!.pages[0].artboards.map((a) => a.id)).toEqual([ab.id])
    expect(store.getArtboardDocumentId(ab.id)).toBe(doc.id)
  })

  it('setTree sem snapshot bumpa versão mas não grava histórico', () => {
    const doc = newDoc()
    const ab = store.createArtboard({ docId: doc.id, name: 'Home', width: 100, height: 100 })
    const updated = store.setTree(ab.id, tree('draft'), { snapshot: false, author: 'human' })
    expect(updated.version).toBe(2)
    expect(updated.tree).toEqual(tree('draft'))
    expect(store.listVersions(ab.id)).toHaveLength(1)
  })

  it('cap de 30 versões: 35 snapshots mantêm só os 30 mais recentes', () => {
    const doc = newDoc()
    const ab = store.createArtboard({ docId: doc.id, name: 'Home', width: 100, height: 100 })
    for (let i = 0; i < 35; i++) {
      store.setTree(ab.id, tree(`v${i + 2}`), {
        snapshot: true,
        author: 'claude',
        summary: `edit ${i + 2}`,
      })
    }
    expect(store.getArtboard(ab.id)!.version).toBe(36)
    const versions = store.listVersions(ab.id)
    expect(versions).toHaveLength(30)
    expect(versions[0].version).toBe(36)
    expect(versions[versions.length - 1].version).toBe(7)
    expect(store.getVersion(ab.id, 6)).toBeNull()
  })

  it('restoreVersion grava versão NOVA com a árvore do snapshot', () => {
    const doc = newDoc()
    const ab = store.createArtboard({
      docId: doc.id,
      name: 'Home',
      width: 100,
      height: 100,
      tree: tree('v1'),
    })
    store.setTree(ab.id, tree('v2'), { snapshot: true, author: 'human', summary: 'second' })

    const restored = store.restoreVersion(ab.id, 1, 'human')
    expect(restored.version).toBe(3)
    expect(restored.tree).toEqual(tree('v1'))
    const versions = store.listVersions(ab.id)
    expect(versions.map((v) => v.version)).toEqual([3, 2, 1])
    expect(versions[0].summary).toBe('restore version 1')
    expect(store.getVersion(ab.id, 2)!.tree).toEqual(tree('v2'))
  })

  it('duplicateArtboard gera ids novos em toda a árvore e posiciona ao lado', () => {
    const doc = newDoc()
    const ab = store.createArtboard({
      docId: doc.id,
      name: 'Home',
      width: 200,
      height: 100,
      tree: tree('orig'),
    })
    const copy = store.duplicateArtboard({ artboardId: ab.id })
    expect(copy.id).not.toBe(ab.id)
    expect(copy.name).toBe('Home copy')
    expect(copy.x).toBe(ab.x + 200 + 80)

    const originalIds = new Set(collectIds(ab.tree))
    const copyIds = collectIds(copy.tree)
    expect(copyIds).toHaveLength(originalIds.size)
    expect(copyIds.some((id) => originalIds.has(id))).toBe(false)
    expect(copy.tree.children.map((c) => c.text)).toEqual(['orig', 'orig-b'])
  })

  it('removeDocument cascateia páginas, artboards, versões, assets e links', () => {
    const doc = newDoc()
    const page = store.createPage({ docId: doc.id, name: 'Page 2' })
    const ab = store.createArtboard({
      docId: doc.id,
      pageId: page.id,
      name: 'A',
      width: 10,
      height: 10,
    })
    store.setTree(ab.id, tree('x'), { snapshot: true, author: 'claude', summary: 's' })
    assets.upload({ documentId: doc.id, name: 'a.png', mime: 'image/png', bytes: png('png') })

    store.removeDocument(doc.id)
    expect(store.getDocument(doc.id)).toBeNull()
    expect(store.getArtboard(ab.id)).toBeNull()
    expect(store.listVersions(ab.id)).toEqual([])
    expect(store.listLinks(doc.id)).toEqual([])
    expect(assets.list(doc.id)).toEqual([])
    const count = testDb.prepare('SELECT COUNT(*) AS n FROM design_pages').get() as { n: number }
    expect(count.n).toBe(0)
  })

  it('páginas: create/update/reorder/delete', () => {
    const doc = newDoc()
    const p2 = store.createPage({ docId: doc.id, name: 'Page 2' })
    expect(p2.position).toBe(1)
    const renamed = store.updatePage({
      id: p2.id,
      name: 'Mobile',
      viewport: { x: 5, y: 6, zoom: 2 },
    })
    expect(renamed.name).toBe('Mobile')
    expect(renamed.viewport).toEqual({ x: 5, y: 6, zoom: 2 })

    const reordered = store.reorderPages(doc.id, [p2.id, doc.pages[0].id])
    expect(reordered.map((p) => p.id)).toEqual([p2.id, doc.pages[0].id])

    store.removePage(p2.id)
    expect(store.getDocument(doc.id)!.pages.map((p) => p.id)).toEqual([doc.pages[0].id])
  })

  it('listDocuments filtra por status, parent e search', () => {
    const a = newDoc('Landing sync')
    const b = store.createDocument({
      title: 'Onboarding',
      links: [{ parentType: 'repo', parentId: 'r9' }],
    })
    store.archiveDocument(b.id)

    expect(store.listDocuments().map((d) => d.id)).toEqual([a.id])
    expect(store.listDocuments({ status: 'all' })).toHaveLength(2)
    expect(store.listDocuments({ status: 'archived' }).map((d) => d.id)).toEqual([b.id])
    expect(store.listDocuments({ parentType: 'feature', parentId: 'f1' }).map((d) => d.id)).toEqual(
      [a.id],
    )
    expect(store.listDocuments({ search: 'sync' }).map((d) => d.id)).toEqual([a.id])
  })

  it('updateDocument persiste tokens/fonts/globalCss', () => {
    const doc = newDoc()
    const updated = store.updateDocument({
      id: doc.id,
      title: 'Renamed',
      tokens: { color: { primary: '#f00' } },
      fonts: ['https://fonts.googleapis.com/css2?family=Inter'],
      globalCss: 'body{margin:0}',
    })
    expect(updated.title).toBe('Renamed')
    expect(updated.tokens).toEqual({ color: { primary: '#f00' } })
    expect(updated.fonts).toEqual(['https://fonts.googleapis.com/css2?family=Inter'])
    expect(updated.globalCss).toBe('body{margin:0}')
  })
})

describe('asset-store', () => {
  beforeEach(() => {
    testDb = new Database(':memory:')
    testDb.pragma('foreign_keys = ON')
    applyAllMigrations(testDb)
  })

  afterEach(() => {
    testDb.close()
  })

  it('upload dedupe por sha256 dentro do mesmo escopo; escopos diferentes não colidem', () => {
    const doc = newDoc()
    const bytes = png('same-bytes')
    const first = assets.upload({ documentId: doc.id, name: 'a.png', mime: 'image/png', bytes })
    const again = assets.upload({ documentId: doc.id, name: 'b.png', mime: 'image/png', bytes })
    expect(again.id).toBe(first.id)
    expect(again.name).toBe('a.png')
    expect(first.url).toBe(`pitwall-design://asset/${first.id}`)
    expect(assets.list(doc.id)).toHaveLength(1)

    const shared = assets.upload({ documentId: null, name: 'c.png', mime: 'image/png', bytes })
    expect(shared.id).not.toBe(first.id)
    expect(assets.list(null).map((a) => a.id)).toEqual([shared.id])

    expect(assets.get(first.id)).toEqual({ mime: 'image/png', bytes })
    assets.remove(first.id)
    expect(assets.get(first.id)).toBeNull()
  })

  it('upload rejeita mime fora da allowlist e asset acima de 5MB', () => {
    expect(() =>
      assets.upload({
        documentId: null,
        name: 'x.pdf',
        mime: 'application/pdf',
        bytes: Buffer.from('x'),
      }),
    ).toThrow(/mime/)
    expect(() =>
      assets.upload({
        documentId: null,
        name: 'big.png',
        mime: 'image/png',
        bytes: Buffer.alloc(assets.MAX_ASSET_BYTES + 1),
      }),
    ).toThrow(/exceeds/)
  })

  it('upload sniffs the bytes and sanitizes svg before storing', () => {
    expect(() =>
      assets.upload({
        documentId: null,
        name: 'fake.png',
        mime: 'image/png',
        bytes: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>'),
      }),
    ).toThrow(/do not look like image\/png/)
    const svg = assets.upload({
      documentId: null,
      name: 'icon.svg',
      mime: 'image/svg+xml',
      bytes: Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" onload="x()"><script>1</script><rect/></svg>',
      ),
    })
    expect(assets.get(svg.id)!.bytes.toString()).toBe(
      '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>',
    )
  })
})

describe('design-store — input limits', () => {
  beforeEach(() => {
    testDb = new Database(':memory:')
    testDb.pragma('foreign_keys = ON')
    applyAllMigrations(testDb)
  })

  afterEach(() => {
    testDb.close()
  })

  it('artboard width/height are clamped on create and update', () => {
    const doc = store.createDocument({ title: 'T' })
    const page = doc.pages[0]
    const ab = store.createArtboard({
      docId: doc.id,
      pageId: page.id,
      name: 'A',
      width: 30000,
      height: 1,
    })
    expect([ab.width, ab.height]).toEqual([8192, 16])
    const updated = store.updateArtboard(ab.id, { width: 99999, height: 400.4 })
    expect([updated.width, updated.height]).toEqual([8192, 400])
  })

  it('globalCss over the cap and token groups over 200 keys are refused; names are truncated', () => {
    const doc = store.createDocument({ title: 'x'.repeat(500) })
    expect(doc.title).toHaveLength(200)
    expect(() =>
      store.updateDocument({ id: doc.id, globalCss: 'a'.repeat(512 * 1024 + 1) }),
    ).toThrow(/globalCss exceeds/)
    const color: Record<string, string> = {}
    for (let i = 0; i < 201; i++) color[`c${i}`] = '#000'
    expect(() => store.updateDocument({ id: doc.id, tokens: { color } })).toThrow(
      /more than 200 keys/,
    )
  })
})
