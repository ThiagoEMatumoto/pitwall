import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { migrations } from './migrations/index'
import type { DiagramLibraryItem } from '../../../shared/types/ipc'

// Mesmo padrão de diagram-store.test: o store importa getDb de './db' (que
// depende de electron.app); mockamos pra um SQLite in-memory migrado.
let testDb: Database.Database
vi.mock('./db', () => ({
  getDb: () => testDb,
}))

import * as store from './diagram-library-store'

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

function item(id: string, name = `Item ${id}`): DiagramLibraryItem {
  return {
    id,
    name,
    status: 'unpublished',
    elements: [{ type: 'rectangle', id: `el-${id}` }],
    created: 1_700_000_000_000,
  }
}

describe('diagram-library-store', () => {
  beforeEach(() => {
    testDb = new Database(':memory:')
    testDb.pragma('foreign_keys = ON')
    applyAllMigrations(testDb)
  })

  afterEach(() => {
    testDb.close()
  })

  it('replaceAll grava na ordem recebida e getItems devolve por position', () => {
    const saved = store.replaceAll([item('c'), item('a'), item('b')])
    expect(saved.map((i) => i.id)).toEqual(['c', 'a', 'b'])
    expect(store.getItems().map((i) => i.id)).toEqual(['c', 'a', 'b'])
    // Roundtrip completo do item (elements parseado de volta).
    expect(saved[0]).toEqual(item('c'))
  })

  it('replaceAll substitui o conjunto inteiro (itens ausentes somem)', () => {
    store.replaceAll([item('a'), item('b')])
    const saved = store.replaceAll([item('b')])
    expect(saved.map((i) => i.id)).toEqual(['b'])
  })

  it('addItems: id existente é sobrescrito na mesma position; inédito vai pro fim', () => {
    store.replaceAll([item('a'), item('b')])

    const updated: DiagramLibraryItem = {
      ...item('a'),
      name: 'Renomeado',
      status: 'published',
    }
    const saved = store.addItems([updated, item('z')])

    // 'a' mantém a posição 0 (sobrescrito, não movido); 'z' entra depois de 'b'.
    expect(saved.map((i) => i.id)).toEqual(['a', 'b', 'z'])
    expect(saved[0].name).toBe('Renomeado')
    expect(saved[0].status).toBe('published')
  })

  it('addItems em biblioteca vazia insere na ordem recebida', () => {
    const saved = store.addItems([item('x'), item('y')])
    expect(saved.map((i) => i.id)).toEqual(['x', 'y'])
  })

  it('removeItem remove e devolve o restante ordenado', () => {
    store.replaceAll([item('a'), item('b'), item('c')])
    const rest = store.removeItem('b')
    expect(rest.map((i) => i.id)).toEqual(['a', 'c'])
    // Remoção de id inexistente é no-op silencioso.
    expect(store.removeItem('fantasma').map((i) => i.id)).toEqual(['a', 'c'])
  })

  it('elements corrompido no banco vira [] (parse defensivo)', () => {
    store.replaceAll([item('a')])
    testDb.prepare(`UPDATE diagram_library_items SET elements = '{oops' WHERE id = 'a'`).run()
    expect(store.getItems()[0].elements).toEqual([])
  })
})
