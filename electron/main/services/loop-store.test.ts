/** @vitest-environment node */
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { migrations } from './migrations/index'

// Mesmo padrão de content-contract-store.test: o store importa getDb de './db'
// (que depende de electron.app); mockamos pra um SQLite in-memory migrado.
let testDb: Database.Database
vi.mock('./db', () => ({
  getDb: () => testDb,
}))

import * as store from './loop-store'
import { loopSnapshot } from './loop-snapshot'

const DAY = 24 * 60 * 60 * 1000

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

function seedFeature(id: string, opts?: { updatedAt?: number; cadenceDays?: number }): void {
  const now = Date.now()
  testDb
    .prepare(
      `INSERT INTO features
         (id, project_id, slug, title, status, objective, doc_path, synth_mode, origin,
          cadence_days, created_at, updated_at)
       VALUES (?, 'proj-1', ?, ?, 'in-progress', 'Objetivo de teste', ?, 'threshold', 'manual',
               ?, ?, ?)`,
    )
    .run(id, id, id, `/tmp/${id}.md`, opts?.cadenceDays ?? null, now, opts?.updatedAt ?? now)
}

beforeEach(() => {
  testDb = new Database(':memory:')
  testDb.pragma('foreign_keys = ON')
  applyAllMigrations(testDb)
  const now = Date.now()
  testDb
    .prepare('INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run('proj-1', 'Projeto de teste', now, now)
  seedFeature('feat-1')
})

afterEach(() => {
  testDb.close()
})

describe('pulso (append-only, vigente = mais recente)', () => {
  it('o vigente é o último gravado, e o anterior continua no histórico', () => {
    store.setPulse('feat-1', 'primeiro pulso', 'human')
    const segundo = store.setPulse('feat-1', 'segundo pulso', 'session', 'sess-9')

    const atual = store.currentPulse('feat-1')
    expect(atual?.body).toBe('segundo pulso')
    expect(atual?.id).toBe(segundo.id)
    expect(atual?.source).toBe('session')
    expect(atual?.sessionId).toBe('sess-9')

    // Append-only: nada foi sobrescrito.
    const historico = store.pulseHistory('feat-1')
    expect(historico.map((p) => p.body)).toEqual(['segundo pulso', 'primeiro pulso'])
  })

  it('rejeita pulso acima de PULSE_MAX_LENGTH (nada é gravado)', () => {
    expect(() => store.setPulse('feat-1', 'x'.repeat(201), 'human')).toThrow(/201 characters/)
    expect(store.currentPulse('feat-1')).toBeNull()
  })

  it('rejeita pulso em branco', () => {
    expect(() => store.setPulse('feat-1', '   ', 'human')).toThrow(/empty/)
    expect(store.pulseHistory('feat-1')).toHaveLength(0)
  })
})

describe('ledger (upsert por entry_id, archived_at em vez de delete)', () => {
  it('regravar o mesmo entry_id ATUALIZA a entrada em vez de duplicar', () => {
    const primeira = store.appendLedger('feat-1', {
      featureId: 'feat-1',
      entryId: 'decisao-01',
      title: 'Escolhi SQLite',
      body: 'Primeira versão.',
    })
    const segunda = store.appendLedger('feat-1', {
      featureId: 'feat-1',
      entryId: 'decisao-01',
      title: 'Escolhi SQLite (revisado)',
      body: 'Segunda versão.',
    })

    const entradas = store.listLedger('feat-1')
    expect(entradas).toHaveLength(1)
    expect(entradas[0].title).toBe('Escolhi SQLite (revisado)')
    expect(entradas[0].body).toBe('Segunda versão.')
    // created_at do INSERT original é preservado pelo upsert.
    expect(segunda.createdAt).toBe(primeira.createdAt)
  })

  it('rejeita entry_id fora do padrão', () => {
    expect(() =>
      store.appendLedger('feat-1', { featureId: 'feat-1', entryId: 'id inválido!', body: 'x' }),
    ).toThrow(/invalid ledger entry_id/)
    expect(store.listLedger('feat-1', { includeArchived: true })).toHaveLength(0)
  })

  it('corpo vazio arquiva (sem DELETE) e corpo de volta desarquiva', () => {
    store.appendLedger('feat-1', { featureId: 'feat-1', entryId: 'nota', body: 'algo' })
    store.appendLedger('feat-1', { featureId: 'feat-1', entryId: 'nota', body: '  ' })

    expect(store.listLedger('feat-1')).toHaveLength(0)
    const arquivadas = store.listLedger('feat-1', { includeArchived: true })
    expect(arquivadas).toHaveLength(1)
    expect(arquivadas[0].archivedAt).not.toBeNull()

    store.appendLedger('feat-1', { featureId: 'feat-1', entryId: 'nota', body: 'de volta' })
    expect(store.listLedger('feat-1')[0].archivedAt).toBeNull()
  })

  it('sem título, o entry_id vira o rótulo (title é NOT NULL)', () => {
    const e = store.appendLedger('feat-1', { featureId: 'feat-1', entryId: 'sem-titulo', body: 'x' })
    expect(e.title).toBe('sem-titulo')
  })
})

describe('métricas', () => {
  it('ponto em coluna não declarada devolve erro tratado (não o erro cru do SQLite)', () => {
    expect(() => store.recordMetricPoint('feat-1', 'latencia_p95', Date.now(), 120)).toThrow(
      /metric column "latencia_p95" is not declared/,
    )
  })

  it('declareMetric é upsert e o ponto no mesmo instante corrige o valor', () => {
    store.declareMetric('feat-1', { featureId: 'feat-1', columnKey: 'custo', target: 100 })
    store.declareMetric('feat-1', {
      featureId: 'feat-1',
      columnKey: 'custo',
      target: 80,
      alarm: true,
      isHeadline: true,
    })
    const colunas = store.listMetrics('feat-1')
    expect(colunas).toHaveLength(1)
    expect(colunas[0].target).toBe(80)
    expect(colunas[0].alarm).toBe(true)
    expect(colunas[0].isHeadline).toBe(true)

    const at = Date.now()
    store.recordMetricPoint('feat-1', 'custo', at, 120)
    store.recordMetricPoint('feat-1', 'custo', at, 95, 'remedido')
    const pontos = store.listMetricPoints('feat-1')
    expect(pontos).toHaveLength(1)
    expect(pontos[0].value).toBe(95)
    expect(pontos[0].note).toBe('remedido')
  })
})

describe('loopSnapshot (vitalidade derivada)', () => {
  it('feature tocada hoje está alive; parada há muito tempo está quiet', () => {
    store.setPulse('feat-1', 'costurando o IPC do loop', 'human')
    const viva = loopSnapshot('feat-1')
    expect(viva.liveness).toBe('alive')
    expect(viva.pulse?.body).toBe('costurando o IPC do loop')
    expect(viva.issues.some((i) => i.level === 'error')).toBe(false)

    const antiga = Date.now() - 60 * DAY
    seedFeature('feat-parada', { updatedAt: antiga })
    testDb
      .prepare(
        `INSERT INTO feature_pulses (id, feature_id, body, source, created_at)
         VALUES ('p-old', 'feat-parada', 'ia começar semana que vem', 'human', ?)`,
      )
      .run(antiga)

    const parada = loopSnapshot('feat-parada')
    expect(parada.liveness).toBe('quiet')
    expect(parada.lastActivityAt).toBe(antiga)
  })

  it('cadence_days curta antecipa o quiet', () => {
    seedFeature('feat-diaria', { updatedAt: Date.now() - 2 * DAY, cadenceDays: 1 })
    expect(loopSnapshot('feat-diaria').liveness).toBe('quiet')
  })

  it('agrega ledger, série de métrica com tom, e issues derivadas', () => {
    store.setPulse('feat-1', 'medindo custo', 'mcp')
    store.appendLedger('feat-1', { featureId: 'feat-1', entryId: 'e1', title: 'Trocamos o parser' })
    store.appendLedger('feat-1', { featureId: 'feat-1', entryId: 'e2', title: 'Cortamos o cache', body: 'ok' })
    store.declareMetric('feat-1', { featureId: 'feat-1', columnKey: 'custo', target: 100 })
    store.recordMetricPoint('feat-1', 'custo', Date.now() - DAY, 300)
    store.recordMetricPoint('feat-1', 'custo', Date.now(), 98)

    const snap = loopSnapshot('feat-1')
    // 'e1' entrou sem corpo → arquivada; listLedger padrão não a traz.
    expect(snap.ledger.map((e) => e.entryId)).toEqual(['e2'])
    expect(snap.metrics).toHaveLength(1)
    expect(snap.metrics[0].points).toHaveLength(2)
    expect(snap.metrics[0].latest?.value).toBe(98)
    expect(snap.metrics[0].tone).toBe('ok')
    // Nenhum repo vinculado → info (derivado, não gravado).
    expect(snap.issues.map((i) => i.code)).toContain('no_repo_linked')
  })

  it('feature inexistente falha alto', () => {
    expect(() => loopSnapshot('nao-existe')).toThrow(/feature not found/)
  })
})
