import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { migrations } from './migrations/index'

let testDb: Database.Database
vi.mock('./db', () => ({ getDb: () => testDb }))

import * as store from './canvas-store'

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

function seedSession(id: string): void {
  testDb
    .prepare(
      `INSERT INTO sessions (id, repo_id, cc_session_id, status, started_at) VALUES (?, NULL, ?, 'running', 1)`,
    )
    .run(id, `cc-${id}`)
}

function sessionRow(id: string) {
  return testDb
    .prepare(`SELECT purpose, group_id, last_summary, last_summary_at FROM sessions WHERE id = ?`)
    .get(id)
}

beforeEach(() => {
  testDb = new Database(':memory:')
  applyAllMigrations(testDb)
})

afterEach(() => {
  testDb.close()
})

describe('canvas-store — posições', () => {
  it('upsert por (scope, kind, entityId) e leitura só do escopo pedido', () => {
    store.setPositions('all', [{ kind: 'session', entityId: 's1', x: 10, y: 20 }])
    store.setPositions('all', [{ kind: 'session', entityId: 's1', x: 30, y: 40, w: 200, h: 90 }])
    store.setPositions('p1', [{ kind: 'session', entityId: 's1', x: 1, y: 2 }])

    expect(store.getCanvas('all').positions).toEqual([
      { scope: 'all', kind: 'session', entityId: 's1', x: 30, y: 40, w: 200, h: 90 },
    ])
    expect(store.getCanvas('p1').positions).toEqual([
      { scope: 'p1', kind: 'session', entityId: 's1', x: 1, y: 2, w: null, h: null },
    ])
  })

  it('clearPositions apaga só o escopo (o Organizar recomeça do zero)', () => {
    store.setPositions('all', [{ kind: 'lane', entityId: 'repo:r1', x: 0, y: 0 }])
    store.setPositions('p1', [{ kind: 'lane', entityId: 'repo:r1', x: 5, y: 5 }])
    store.clearPositions('all')
    expect(store.getCanvas('all').positions).toEqual([])
    expect(store.getCanvas('p1').positions).toHaveLength(1)
  })
})

describe('canvas-store — estado de exibição do cartão', () => {
  it('guarda view_state sem posição: o cartão segue no layout automático', () => {
    store.setViewStates('all', [{ sessionId: 's1', viewState: 'collapsed' }])
    const canvas = store.getCanvas('all')
    expect(canvas.positions).toEqual([])
    expect(canvas.views).toEqual([{ sessionId: 's1', viewState: 'collapsed' }])
  })

  it('arrastar não apaga o view_state, e mudar o view_state não mexe na posição', () => {
    store.setViewStates('all', [{ sessionId: 's1', viewState: 'terminal' }])
    store.setPositions('all', [{ kind: 'session', entityId: 's1', x: 3, y: 4 }])
    store.setViewStates('all', [{ sessionId: 's1', viewState: 'open' }])
    const canvas = store.getCanvas('all')
    expect(canvas.positions).toEqual([
      { scope: 'all', kind: 'session', entityId: 's1', x: 3, y: 4, w: null, h: null },
    ])
    expect(canvas.views).toEqual([{ sessionId: 's1', viewState: 'open' }])
  })

  it('o Organizar zera posições mas preserva o estado de exibição', () => {
    store.setPositions('all', [
      { kind: 'session', entityId: 's1', x: 3, y: 4 },
      { kind: 'session', entityId: 's2', x: 5, y: 6 },
    ])
    store.setViewStates('all', [{ sessionId: 's1', viewState: 'collapsed' }])
    store.clearPositions('all')
    const canvas = store.getCanvas('all')
    expect(canvas.positions).toEqual([])
    expect(canvas.views).toEqual([{ sessionId: 's1', viewState: 'collapsed' }])
  })

  it('é por escopo', () => {
    store.setViewStates('p1', [{ sessionId: 's1', viewState: 'collapsed' }])
    expect(store.getCanvas('all').views).toEqual([])
    expect(store.getCanvas('p1').views).toHaveLength(1)
  })
})

describe('canvas-store — notas', () => {
  it('cria, atualiza (prender/soltar) e apaga nota, com a posição dela', () => {
    seedSession('s1')
    const note = store.createNote({ scope: 'all', bodyMd: '# plano', attachedSessionId: 's1' })
    expect(note).toMatchObject({
      scope: 'all',
      bodyMd: '# plano',
      attachedSessionId: 's1',
      color: null,
    })

    const loose = store.updateNote({ id: note.id, bodyMd: 'feito', attachedSessionId: null })
    expect(loose).toMatchObject({ bodyMd: 'feito', attachedSessionId: null })
    expect(loose.updatedAt).toBeGreaterThanOrEqual(note.updatedAt)

    store.setPositions('all', [{ kind: 'note', entityId: note.id, x: 1, y: 1 }])
    store.deleteNote(note.id)
    expect(store.getCanvas('all')).toMatchObject({ notes: [], positions: [] })
  })

  it('updateNote de id inexistente falha alto', () => {
    expect(() => store.updateNote({ id: 'nope', bodyMd: 'x' })).toThrow(/não encontrada/)
  })
})

describe('canvas-store — grupos', () => {
  it('cria/renomeia/recolore e move sessões para dentro e para fora', () => {
    seedSession('s1')
    const g = store.createGroup({ scope: 'all', name: 'Frente pagamentos' })
    expect(store.updateGroup({ id: g.id, name: 'Pagamentos', color: '#f00' })).toMatchObject({
      name: 'Pagamentos',
      color: '#f00',
    })

    store.setSessionGroup('s1', g.id)
    expect(sessionRow('s1')).toMatchObject({ group_id: g.id })
    store.setSessionGroup('s1', null)
    expect(sessionRow('s1')).toMatchObject({ group_id: null })
  })

  it('apagar o grupo solta as sessões e remove a posição dele', () => {
    seedSession('s1')
    const g = store.createGroup({ scope: 'p1', name: 'X' })
    store.setSessionGroup('s1', g.id)
    store.setPositions('p1', [{ kind: 'group', entityId: g.id, x: 0, y: 0 }])
    store.deleteGroup(g.id)
    expect(sessionRow('s1')).toMatchObject({ group_id: null })
    expect(store.getCanvas('p1')).toMatchObject({ groups: [], positions: [] })
  })

  // A posição do membro é relativa ao grupo: reusada na lane, o cartão cairia em
  // cima do primeiro cartão dela. Sem posição, o layout põe no próximo slot livre.
  it('tirar do grupo apaga a posição relativa ao grupo (só no escopo do grupo)', () => {
    seedSession('s1')
    const g = store.createGroup({ scope: 'p1', name: 'X' })
    store.setSessionGroup('s1', g.id)
    store.setPositions('p1', [{ kind: 'session', entityId: 's1', x: 12, y: 30 }])
    store.setPositions('all', [{ kind: 'session', entityId: 's1', x: 400, y: 90 }])
    store.setSessionGroup('s1', null)
    expect(store.getCanvas('p1').positions).toEqual([])
    expect(store.getCanvas('all').positions).toHaveLength(1)
  })

  it('apagar o grupo também apaga a posição dos membros no escopo dele', () => {
    seedSession('s1')
    const g = store.createGroup({ scope: 'p1', name: 'X' })
    store.setSessionGroup('s1', g.id)
    store.setPositions('p1', [{ kind: 'session', entityId: 's1', x: 12, y: 30 }])
    store.deleteGroup(g.id)
    expect(store.getCanvas('p1').positions).toEqual([])
  })

  it('entrar num grupo não apaga a posição que o arrasto acabou de gravar', () => {
    seedSession('s1')
    const g = store.createGroup({ scope: 'p1', name: 'X' })
    store.setPositions('p1', [{ kind: 'session', entityId: 's1', x: 12, y: 60 }])
    store.setSessionGroup('s1', g.id)
    expect(store.getCanvas('p1').positions).toHaveLength(1)
  })

  it('mover para grupo inexistente falha alto', () => {
    seedSession('s1')
    expect(() => store.setSessionGroup('s1', 'ghost')).toThrow(/Grupo não encontrado/)
  })
})

describe('canvas-store — propósito e resumo', () => {
  it('grava e limpa o propósito (string vazia = null)', () => {
    seedSession('s1')
    store.setSessionPurpose('s1', '  Migrar o checkout  ')
    expect(sessionRow('s1')).toMatchObject({ purpose: 'Migrar o checkout' })
    store.setSessionPurpose('s1', '   ')
    expect(sessionRow('s1')).toMatchObject({ purpose: null })
  })

  it('grava o resumo "onde parei" com o instante', () => {
    seedSession('s1')
    store.setSessionSummary('s1', 'Parou no teste do webhook.', 1234)
    expect(sessionRow('s1')).toMatchObject({
      last_summary: 'Parou no teste do webhook.',
      last_summary_at: 1234,
    })
  })

  it('sessão inexistente falha alto', () => {
    expect(() => store.setSessionPurpose('ghost', 'x')).toThrow(/Sessão não encontrada/)
  })
})
