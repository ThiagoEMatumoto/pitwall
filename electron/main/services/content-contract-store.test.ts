import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { migrations } from './migrations/index'
import type { ContentGateFinding } from '../../../shared/types/ipc'

// Mesmo padrão de scheduled-job-store.test: o store importa getDb de './db'
// (que depende de electron.app); mockamos pra um SQLite in-memory migrado.
let testDb: Database.Database
vi.mock('./db', () => ({
  getDb: () => testDb,
}))

import * as store from './content-contract-store'

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

function novoContrato(slug = 'briefing-inss') {
  return store.create({
    slug,
    title: 'Briefing INSS',
    outputLabel: 'Orientação — não é consultoria jurídica',
    status: 'active',
    audience: {
      who: 'requerente do INSS',
      notWho: ['advogado', 'servidor'],
      situation: 'aguardando perícia',
      assumptions: [],
    },
    forbiddenFacts: [
      {
        id: 'ff1',
        claim: 'o benefício é garantido',
        forms: ['garantido', 'com certeza'],
        neutralForm: 'depende da análise do INSS',
        reason: 'não há garantia de deferimento',
        status: 'proibido',
        statusChangedAt: null,
        appliesTo: ['bpc'],
      },
    ],
    tone: { hard_rules: [], anti_tone_words: ['simples'], paragrafo_canonico: 'Exemplo canônico.' },
  })
}

describe('content-contract-store', () => {
  beforeEach(() => {
    testDb = new Database(':memory:')
    testDb.pragma('foreign_keys = ON')
    applyAllMigrations(testDb)
  })

  afterEach(() => {
    testDb.close()
  })

  describe('create: cabeça v1 + snapshot 1 na mesma transação', () => {
    it('grava o contrato e a versão 1 juntos', () => {
      const c = novoContrato()
      expect(c.version).toBe(1)
      expect(store.get(c.id)?.slug).toBe('briefing-inss')
      expect(store.getBySlug('briefing-inss')?.id).toBe(c.id)

      const versions = store.listVersions(c.id)
      expect(versions).toHaveLength(1)
      expect(versions[0].version).toBe(1)
      expect(versions[0].snapshot?.outputLabel).toBe(c.outputLabel)
    })

    it('output_label vazio é rejeitado pelo CHECK (nada é gravado)', () => {
      expect(() =>
        store.create({ slug: 'vazio', title: 'X', outputLabel: '   ' }),
      ).toThrow()
      expect(store.list()).toHaveLength(0)
    })

    it('appliesTo sobrevive ao roundtrip (regra por trilha)', () => {
      const c = novoContrato()
      expect(store.get(c.id)?.forbiddenFacts[0].appliesTo).toEqual(['bpc'])
      expect(store.get(c.id)?.forbiddenFacts[0].status).toBe('proibido')
    })
  })

  describe('update é bump, não mutação silenciosa', () => {
    it('sem diff NÃO bumpa a versão nem grava changelog', () => {
      const c = novoContrato()
      const same = store.update({
        id: c.id,
        summary: 'nada mudou',
        reason: 'reenvio do mesmo payload',
        title: 'Briefing INSS',
        status: 'active',
      })
      expect(same.version).toBe(1)
      expect(same.updatedAt).toBe(c.updatedAt)
      expect(store.listVersions(c.id)).toHaveLength(1)
    })

    it('ordem de chave diferente não é diff', () => {
      const c = novoContrato()
      const same = store.update({
        id: c.id,
        summary: 's',
        reason: 'r',
        audience: {
          assumptions: [],
          situation: 'aguardando perícia',
          notWho: ['advogado', 'servidor'],
          who: 'requerente do INSS',
        },
      })
      expect(same.version).toBe(1)
    })

    it('com diff bumpa pra 2 e PRESERVA o snapshot 1', () => {
      const c = novoContrato()
      const next = store.update({
        id: c.id,
        summary: 'rótulo de saída revisado',
        reason: 'jurídico pediu texto mais explícito',
        outputLabel: 'Conteúdo informativo — não substitui advogado',
      })

      expect(next.version).toBe(2)
      const versions = store.listVersions(c.id)
      expect(versions.map((v) => v.version)).toEqual([2, 1])
      expect(versions[1].snapshot?.outputLabel).toBe(c.outputLabel)
      expect(versions[0].changedFields).toEqual(['outputLabel'])
      expect(versions[0].reason).toBe('jurídico pediu texto mais explícito')
      expect(store.getVersion(c.id, 1)?.snapshot?.outputLabel).toBe(c.outputLabel)
    })

    it('bump sem summary/reason é recusado', () => {
      const c = novoContrato()
      expect(() => store.update({ id: c.id, summary: '', reason: '', title: 'Outro' })).toThrow(
        /summary e reason/,
      )
      expect(store.get(c.id)?.version).toBe(1)
    })
  })

  describe('leitura defensiva', () => {
    it('JSON corrompido em tone cai no default sem derrubar list()', () => {
      const c = novoContrato()
      testDb.prepare('UPDATE content_contracts SET tone = ? WHERE id = ?').run('{{{', c.id)

      const all = store.list()
      expect(all).toHaveLength(1)
      expect(all[0].tone).toEqual({ hard_rules: [], anti_tone_words: [] })
    })

    it('list filtra por status e busca', () => {
      novoContrato('a-ativo')
      store.create({ slug: 'b-rascunho', title: 'Outro', outputLabel: 'x', status: 'draft' })
      expect(store.list({ status: 'draft' }).map((c) => c.slug)).toEqual(['b-rascunho'])
      expect(store.list({ search: 'ativo' }).map((c) => c.slug)).toEqual(['a-ativo'])
    })
  })

  describe('gate runs: evidência sempre atada a uma versão snapshotada', () => {
    it('createGateRun contra versão nunca snapshotada LANÇA (FK composta)', () => {
      const c = novoContrato()
      expect(() =>
        store.createGateRun({
          contractId: c.id,
          contractVersion: 7,
          gate: 'tone-lint',
          status: 'failed',
        }),
      ).toThrow()
      expect(store.listGateRuns({ contractId: c.id })).toHaveLength(0)
    })

    it('grava e lê o run com findings e contadores', () => {
      const c = novoContrato()
      const finding: ContentGateFinding = {
        rule: 'sem-travessao',
        severity: 'bloqueante',
        message: 'travessão proibido',
        line: 1,
        column: 26,
        excerpt: 'e não faz.',
        replacement: null,
      }
      const run = store.createGateRun({
        contractId: c.id,
        contractVersion: c.version,
        gate: 'tone-lint',
        status: 'failed',
        materialRef: '/tmp/roteiro.md',
        findings: [finding],
        blockingCount: 1,
        evidence: 'linha 1, coluna 26',
      })

      expect(run.status).toBe('failed')
      expect(run.findings).toEqual([finding])
      expect(run.findingsTruncated).toBe(false)
      expect(store.getLastGateRun(c.id)?.id).toBe(run.id)
      expect(store.getLastGateRun(c.id, 'scope')).toBeNull()
      expect(store.listGateRuns({ contractId: c.id, gate: 'tone-lint' })).toHaveLength(1)
    })

    it('findings acima de 64 KB é truncado com flag', () => {
      const c = novoContrato()
      const gordo: ContentGateFinding[] = Array.from({ length: 2000 }, (_, i) => ({
        rule: 'variacao-de-frase',
        severity: 'aviso',
        message: `achado ${i} ${'x'.repeat(80)}`,
        line: i,
        column: 0,
        excerpt: 'y'.repeat(80),
      }))
      const run = store.createGateRun({
        contractId: c.id,
        contractVersion: c.version,
        gate: 'tone-lint',
        status: 'failed',
        findings: gordo,
      })

      expect(run.findingsTruncated).toBe(true)
      expect(run.findings.length).toBeGreaterThan(0)
      expect(run.findings.length).toBeLessThan(gordo.length)
      // o começo (as primeiras violações) é o que sobrevive ao corte
      expect(run.findings[0].message).toBe(gordo[0].message)
      const raw = testDb
        .prepare('SELECT findings FROM content_gate_runs WHERE id = ?')
        .get(run.id) as { findings: string }
      expect(Buffer.byteLength(raw.findings, 'utf8')).toBeLessThanOrEqual(64 * 1024)
    })

    it('run continua atado à versão em que rodou depois do bump', () => {
      const c = novoContrato()
      store.createGateRun({
        contractId: c.id,
        contractVersion: 1,
        gate: 'scope',
        status: 'passed',
      })
      store.update({ id: c.id, summary: 's', reason: 'r', title: 'Briefing INSS v2' })

      expect(store.listGateRuns({ contractId: c.id, contractVersion: 1 })).toHaveLength(1)
      expect(store.listGateRuns({ contractId: c.id, contractVersion: 2 })).toHaveLength(0)
    })
  })

  it('remove cascateia versões e gate runs', () => {
    const c = novoContrato()
    store.createGateRun({ contractId: c.id, contractVersion: 1, gate: 'scope', status: 'passed' })
    store.update({ id: c.id, summary: 's', reason: 'r', status: 'archived' })

    store.remove(c.id)

    expect(store.get(c.id)).toBeNull()
    expect(store.listVersions(c.id)).toHaveLength(0)
    expect(store.listGateRuns({ contractId: c.id })).toHaveLength(0)
  })
})
