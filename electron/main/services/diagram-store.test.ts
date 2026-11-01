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

  it('restoreVersion aplica o mesmo prune de MAX_SNAPSHOTS de updateScene', () => {
    const d = novoDiagrama()
    for (let i = 0; i < 34; i++) {
      store.updateScene({
        id: d.id,
        scene: scene(`v${i + 2}`),
        author: 'claude',
        summary: `edição ${i + 2}`,
        snapshot: true,
      })
    }
    // Head v35; retidas 6..35 (cap de 30).
    expect(store.listVersions(d.id)).toHaveLength(30)

    store.restoreVersion(d.id, 10, 'human') // vira v36; prune derruba a 6
    store.restoreVersion(d.id, 12, 'human') // vira v37; prune derruba a 7
    const versions = store.listVersions(d.id)
    expect(versions).toHaveLength(30)
    expect(versions[0].version).toBe(37)
    expect(versions[versions.length - 1].version).toBe(8)
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

  describe('pastas', () => {
    it('cria pasta, arquiva diagrama nela e conta só ativos', () => {
      const folder = store.createFolder({ name: 'Infra', color: 'info' })
      const a = store.create({
        title: 'A',
        scene: scene('a'),
        author: 'human',
        folderId: folder.id,
      })
      const b = novoDiagrama('B')
      store.move(b.id, folder.id)
      store.archive(b.id)

      expect(a.folderId).toBe(folder.id)
      expect(store.getFolder(folder.id)).toMatchObject({ name: 'Infra', color: 'info', docCount: 1 })
    })

    it('list filtra por folderId e por null (sem pasta)', () => {
      const folder = store.createFolder({ name: 'Fluxos' })
      const inside = store.create({ title: 'Dentro', scene: scene('x'), author: 'human', folderId: folder.id })
      const loose = novoDiagrama('Solto')

      expect(store.list({ folderId: folder.id }).map((d) => d.id)).toEqual([inside.id])
      expect(store.list({ folderId: null }).map((d) => d.id)).toEqual([loose.id])
      expect(store.list().map((d) => d.folderId).sort()).toEqual([folder.id, null].sort())
    })

    it('move não bumpa updated_at e recusa pasta inexistente', () => {
      const d = novoDiagrama()
      const folder = store.createFolder({ name: 'X' })
      const before = store.get(d.id)!.updatedAt

      const moved = store.move(d.id, folder.id)
      expect(moved.folderId).toBe(folder.id)
      expect(moved.updatedAt).toBe(before)
      expect(store.move(d.id, null).folderId).toBeNull()
      expect(() => store.move(d.id, 'nope')).toThrow(/diagram folder not found/)
      expect(() => store.move('nope', null)).toThrow(/diagram not found/)
    })

    it('create recusa folderId inexistente', () => {
      expect(() =>
        store.create({ title: 'Z', scene: scene('z'), author: 'human', folderId: 'nope' }),
      ).toThrow(/diagram folder not found/)
    })

    it('apagar a pasta deixa os diagramas sem pasta', () => {
      const folder = store.createFolder({ name: 'Temp' })
      const d = store.create({ title: 'D', scene: scene('d'), author: 'human', folderId: folder.id })

      store.deleteFolder(folder.id)

      expect(store.get(d.id)!.folderId).toBeNull()
      expect(store.listFolders()).toEqual([])
    })

    it('ensureFolder reaproveita por nome sem diferenciar caixa; rename e cor', () => {
      const a = store.ensureFolder('Arquitetura')
      expect(store.ensureFolder('arquitetura').id).toBe(a.id)

      const renamed = store.updateFolder(a.id, { name: 'Arq', color: 'success' })
      expect(renamed).toMatchObject({ name: 'Arq', color: 'success' })
      expect(store.updateFolder(a.id, { color: null }).color).toBeNull()
      expect(() => store.updateFolder(a.id, { name: '  ' })).toThrow(/non-empty/)
    })
  })
})

describe('list por sessão — régua por conversa', () => {
  beforeEach(() => {
    testDb = new Database(':memory:')
    testDb.pragma('foreign_keys = ON')
    applyAllMigrations(testDb)
  })
  afterEach(() => testDb.close())

  // Cada resume abre uma linha nova em sessions com o mesmo cc_session_id; o
  // link 'session' foi gravado pelo id da linha antiga.
  function conversa(cc: string, ids: string[]): void {
    testDb.pragma('foreign_keys = OFF')
    ids.forEach((id, i) =>
      testDb
        .prepare(
          `INSERT INTO sessions (id, repo_id, cc_session_id, status, started_at)
           VALUES (?, 'r1', ?, ?, ?)`,
        )
        .run(id, cc, i === ids.length - 1 ? 'running' : 'exited', i + 1),
    )
    testDb.pragma('foreign_keys = ON')
  }

  it('acha o diagrama linkado pelo id antigo a partir da sessão retomada', () => {
    conversa('cc-1', ['s-old', 's-new'])
    conversa('cc-2', ['s-other'])
    const d = store.create({
      title: 'Arquitetura',
      kind: 'architecture',
      scene: scene('v1'),
      author: 'claude',
      links: [{ parentType: 'session', parentId: 's-old' }],
    })
    const ids = (parentId: string) =>
      store.list({ parentType: 'session', parentId }).map((x) => x.id)
    expect(ids('s-new')).toEqual([d.id])
    expect(ids('s-old')).toEqual([d.id])
    expect(ids('s-other')).toEqual([])
    // Sessão sem linha em sessions (ou sem cc): só o id exato.
    expect(ids('s-ghost')).toEqual([])
  })
})
