import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { migrations } from './migrations/index'
import type { DiagramScene } from '../../../shared/types/ipc'

// Mesmo padrão de content-contract-store.test: o store importa getDb de './db'
// (que depende de electron.app); mockamos pra um SQLite in-memory migrado.
let testDb: Database.Database
vi.mock('./db', () => ({
  getDb: () => testDb,
}))

import * as store from './diagram-store'

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

function scene(label: string): DiagramScene {
  return { elements: [{ type: 'rectangle', id: label }], appState: { viewBackgroundColor: '#fff' } }
}

function novoDiagrama(title = 'Fluxo de handoff') {
  return store.create({
    title,
    kind: 'flow',
    scene: scene('v1'),
    sourceFormat: 'skeleton',
    source: '[{"type":"node"}]',
    author: 'claude',
    summary: 'primeiro rascunho',
    links: [{ parentType: 'feature', parentId: 'f1' }],
  })
}

describe('diagram-store', () => {
  beforeEach(() => {
    testDb = new Database(':memory:')
    testDb.pragma('foreign_keys = ON')
    applyAllMigrations(testDb)
  })

  afterEach(() => {
    testDb.close()
  })

  it('create + get roundtrip: cena, meta, links e versão 1', () => {
    const created = novoDiagrama()
    const fetched = store.get(created.id)

    expect(fetched).not.toBeNull()
    expect(fetched!.title).toBe('Fluxo de handoff')
    expect(fetched!.kind).toBe('flow')
    expect(fetched!.status).toBe('active')
    expect(fetched!.version).toBe(1)
    expect(fetched!.sourceFormat).toBe('skeleton')
    expect(fetched!.thumbnail).toBeNull()
    expect(fetched!.scene).toEqual(scene('v1'))
    expect(fetched!.links).toEqual([
      { diagramId: created.id, parentType: 'feature', parentId: 'f1' },
    ])

    const versions = store.listVersions(created.id)
    expect(versions).toHaveLength(1)
    expect(versions[0]).toMatchObject({ version: 1, author: 'claude', summary: 'primeiro rascunho' })
  })

  it('updateScene sem snapshot muda a cabeça sem bump nem linha de histórico', () => {
    const d = novoDiagrama()
    const updated = store.updateScene({
      id: d.id,
      scene: scene('rascunho'),
      author: 'human',
      snapshot: false,
    })
    expect(updated.version).toBe(1)
    expect(updated.scene).toEqual(scene('rascunho'))
    expect(store.listVersions(d.id)).toHaveLength(1)
  })

  it('updateScene com snapshot exige summary', () => {
    const d = novoDiagrama()
    expect(() =>
      store.updateScene({ id: d.id, scene: scene('x'), author: 'human', snapshot: true }),
    ).toThrow(/summary/)
  })

  it('cap de 30 versões: bump 40x mantém só os 30 snapshots mais recentes', () => {
    const d = novoDiagrama()
    for (let i = 0; i < 40; i++) {
      store.updateScene({
        id: d.id,
        scene: scene(`v${i + 2}`),
        author: 'claude',
        summary: `edição ${i + 2}`,
        snapshot: true,
      })
    }
    const head = store.get(d.id)!
    expect(head.version).toBe(41)

    const versions = store.listVersions(d.id)
    expect(versions).toHaveLength(30)
    expect(versions[0].version).toBe(41)
    expect(versions[versions.length - 1].version).toBe(12)
    expect(store.getVersion(d.id, 11)).toBeNull()
  })

  it('remove lança se o diagrama está ativo; force pula a checagem', () => {
    const d = novoDiagrama()
    expect(() => store.remove(d.id)).toThrow(/not archived/)

    store.archive(d.id)
    expect(store.get(d.id)!.status).toBe('archived')
    store.remove(d.id)
    expect(store.get(d.id)).toBeNull()

    const d2 = novoDiagrama('Outro ativo')
    store.remove(d2.id, { force: true })
    expect(store.get(d2.id)).toBeNull()
  })

  it('restoreVersion cria versão NOVA com a cena do snapshot (git-revert)', () => {
    const d = novoDiagrama()
    store.updateScene({
      id: d.id,
      scene: scene('v2'),
      author: 'human',
      summary: 'segunda',
      snapshot: true,
    })

    const restored = store.restoreVersion(d.id, 1, 'human')
    expect(restored.version).toBe(3)
    expect(restored.scene).toEqual(scene('v1'))

    // Histórico intacto: v1, v2 e a v3 nova do restore.
    const versions = store.listVersions(d.id)
    expect(versions.map((v) => v.version)).toEqual([3, 2, 1])
    expect(versions[0].summary).toBe('restaura versão 1')
    expect(store.getVersion(d.id, 2)!.scene).toEqual(scene('v2'))
  })

  it('links CRUD: link idempotente, unlink remove, listLinks reflete', () => {
    const d = novoDiagrama()
    let links = store.link({ diagramId: d.id, parentType: 'repo', parentId: 'r1' })
    expect(links).toHaveLength(2)

    // Duplicata é no-op (PK composta + OR IGNORE).
    links = store.link({ diagramId: d.id, parentType: 'repo', parentId: 'r1' })
    expect(links).toHaveLength(2)

    links = store.unlink({ diagramId: d.id, parentType: 'feature', parentId: 'f1' })
    expect(links).toEqual([{ diagramId: d.id, parentType: 'repo', parentId: 'r1' }])
    expect(store.listLinks(d.id)).toHaveLength(1)
  })

  it('list filtra por parent, status e search; não vaza cena', () => {
    const a = novoDiagrama('Arquitetura do sync')
    const b = store.create({
      title: 'ER do banco',
      kind: 'er',
      scene: scene('er'),
      author: 'human',
      links: [{ parentType: 'repo', parentId: 'r9' }],
    })
    store.archive(b.id)

    // Default: só ativos.
    expect(store.list().map((m) => m.id)).toEqual([a.id])
    expect(store.list({ status: 'all' })).toHaveLength(2)
    expect(store.list({ status: 'archived' }).map((m) => m.id)).toEqual([b.id])

    expect(store.list({ parentType: 'feature', parentId: 'f1' }).map((m) => m.id)).toEqual([a.id])
    expect(store.list({ status: 'all', parentType: 'repo', parentId: 'r9' }).map((m) => m.id)).toEqual([b.id])
    expect(store.list({ parentType: 'feature', parentId: 'nope' })).toEqual([])

    expect(store.list({ search: 'sync' }).map((m) => m.id)).toEqual([a.id])
    const meta = store.list()[0] as unknown as Record<string, unknown>
    expect(meta.scene).toBeUndefined()
  })

  it('setThumbnail grava o preview sem bumpar updated_at nem versão', () => {
    const d = novoDiagrama()
    store.setThumbnail(d.id, 'data:image/png;base64,abc')
    const after = store.get(d.id)!
    expect(after.thumbnail).toBe('data:image/png;base64,abc')
    expect(after.version).toBe(1)
    expect(after.updatedAt).toBe(d.updatedAt)
    expect(store.listVersions(d.id)).toHaveLength(1)
  })
})
