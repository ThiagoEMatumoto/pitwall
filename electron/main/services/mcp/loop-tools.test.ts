/** @vitest-environment node */
// Unit das tools MCP do loop contra um better-sqlite3 real (tmp dir), com
// electron mockado e o notify espiado — mesma estratégia de video-tools.test.
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join: j } = await import('node:path')
  const dir = mkdtempSync(j(tmpdir(), 'mcp-loop-tools-test-'))
  return {
    app: { getPath: () => dir, getVersion: () => '0.0.0-test' },
    BrowserWindow: { getAllWindows: () => [] },
  }
})

import { app } from 'electron'
import { closeDb, getDb } from '../db'
import { buildTools, type McpNotify, type ToolDef, type ToolResult } from './tools'
import type {
  FeatureLedgerEntry,
  FeatureMetricPoint,
  FeaturePulse,
  LoopIssue,
} from '../../../../shared/types/ipc'

interface NotifySpy extends McpNotify {
  calls: Array<[string, unknown]>
}

function makeNotify(): NotifySpy {
  const calls: Array<[string, unknown]> = []
  return {
    calls,
    broadcast: (channel, payload) => calls.push([channel, payload]),
    affectedObjectives: () => {},
    affectedObjectivesForFeatureLinks: () => {},
  }
}

let notify: NotifySpy
let tools: ToolDef[]
let n = 0
let featureId: string
let repoDir: string

function tool(name: string): ToolDef {
  const def = tools.find((t) => t.name === name)
  if (!def) throw new Error(`tool not registered: ${name}`)
  return def
}

function call<T>(name: string, args: unknown): T {
  return (tool(name).handler(args) as ToolResult).structuredContent as T
}

async function callAsync<T>(name: string, args: unknown): Promise<T> {
  const result = await tool(name).handler(args)
  return result.structuredContent as T
}

beforeEach(() => {
  notify = makeNotify()
  tools = buildTools(notify)
  const db = getDb()
  const now = Date.now()
  db.prepare(
    'INSERT OR IGNORE INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)',
  ).run('proj-loop', 'Projeto do loop', now, now)
  featureId = `feat-${n}`
  repoDir = join(app.getPath('userData'), `repo-${n}`)
  mkdirSync(repoDir, { recursive: true })
  db.prepare(
    `INSERT INTO features
       (id, project_id, slug, title, status, objective, doc_path, synth_mode, origin,
        created_at, updated_at)
     VALUES (?, 'proj-loop', ?, ?, 'in-progress', 'Fechar o loop sozinho', ?, 'threshold',
             'manual', ?, ?)`,
  ).run(featureId, `slug-${n}`, `Feature ${n}`, `/tmp/f${n}.md`, now, now)
  db.prepare(
    'INSERT INTO repos (id, project_id, label, path, position, created_at) VALUES (?, ?, ?, ?, 0, ?)',
  ).run(`repo-${n}`, 'proj-loop', `repo-${n}`, repoDir, now)
  db.prepare(
    'INSERT INTO feature_repos (feature_id, repo_id, branch, worktree_path) VALUES (?, ?, NULL, NULL)',
  ).run(featureId, `repo-${n}`)
  n += 1
})

afterAll(() => {
  closeDb()
  rmSync(app.getPath('userData'), { recursive: true, force: true })
})

describe('mcp loop tools', () => {
  it('registra as oito tools do loop', () => {
    const names = tools.map((t) => t.name)
    for (const name of [
      'feature_pulse_set',
      'feature_pulse_history',
      'feature_ledger_append',
      'feature_ledger_list',
      'feature_metric_declare',
      'feature_metric_record',
      'feature_health_get',
      'feature_loop_export',
    ]) {
      expect(names).toContain(name)
    }
  })

  it('feature_health_get devolve liveness, issues, pulso e métricas headline numa chamada', () => {
    call('feature_pulse_set', { featureId, body: 'Tools do loop em pé; falta o export.' })
    call('feature_metric_declare', {
      featureId,
      columnKey: 'p95_ms',
      unit: 'ms',
      target: 100,
      isHeadline: true,
    })
    call('feature_metric_declare', { featureId, columnKey: 'ruido', target: 1 })
    call('feature_metric_record', { featureId, columnKey: 'p95_ms', value: 98 })

    const health = call<{
      liveness: string
      issues: LoopIssue[]
      pulse: FeaturePulse | null
      lastActivityAt: number
      metrics: Array<{ columnKey: string; tone: string }>
    }>('feature_health_get', { featureId })

    expect(health.liveness).toBe('alive')
    expect(health.pulse?.body).toBe('Tools do loop em pé; falta o export.')
    expect(health.pulse?.source).toBe('mcp')
    expect(health.lastActivityAt).toBeGreaterThan(0)
    // Feature nova sem repo problemático: sobra o info de objetivo/repo, não erro.
    expect(health.issues.some((i) => i.level === 'error')).toBe(false)
    // Só a headline entra — a leitura é pra situar, não pra despejar a série toda.
    expect(health.metrics.map((m) => m.columnKey)).toEqual(['p95_ms'])
    expect(health.metrics[0].tone).toBe('ok')
  })

  it('feature_health_get expõe o issue de pulso ausente antes de qualquer escrita', () => {
    const health = call<{ liveness: string; issues: LoopIssue[]; pulse: FeaturePulse | null }>(
      'feature_health_get',
      { featureId },
    )
    expect(health.pulse).toBeNull()
    expect(health.issues.map((i) => i.code)).toContain('pulse_missing')
  })

  it('feature_ledger_append com o mesmo entryId atualiza em vez de duplicar', () => {
    const first = call<{ entry: FeatureLedgerEntry }>('feature_ledger_append', {
      featureId,
      entryId: 'decisao-export',
      title: 'Export no exit',
      body: 'Primeira versão.',
    })
    const second = call<{ entry: FeatureLedgerEntry }>('feature_ledger_append', {
      featureId,
      entryId: 'decisao-export',
      title: 'Export no exit da sessão',
      body: 'Corrigido: roda no exit, não no spawn.',
    })

    expect(second.entry.createdAt).toBe(first.entry.createdAt)
    expect(second.entry.title).toBe('Export no exit da sessão')
    const list = call<{ items: FeatureLedgerEntry[] }>('feature_ledger_list', { featureId })
    expect(list.items).toHaveLength(1)
    expect(list.items[0].body).toBe('Corrigido: roda no exit, não no spawn.')
  })

  it('entryId fora do padrão é recusado', () => {
    expect(() =>
      call('feature_ledger_append', { featureId, entryId: 'id com espaço', body: 'x' }),
    ).toThrow(/invalid ledger entry_id/)
  })

  it('pulso acima de 200 caracteres é recusado (é uma frase, não relatório)', () => {
    expect(() => call('feature_pulse_set', { featureId, body: 'x'.repeat(201) })).toThrow(
      /max 200/,
    )
  })

  it('métrica sem coluna declarada diz o que faltou', () => {
    expect(() =>
      call('feature_metric_record', { featureId, columnKey: 'nao-declarada', value: 1 }),
    ).toThrow(/declareMetric first/)
  })

  it('feature_metric_record no mesmo instante corrige em vez de duplicar', () => {
    call('feature_metric_declare', { featureId, columnKey: 'custo', target: 10, alarm: true })
    const at = Date.now()
    call('feature_metric_record', { featureId, columnKey: 'custo', value: 12, at })
    const fixed = call<{ point: FeatureMetricPoint }>('feature_metric_record', {
      featureId,
      columnKey: 'custo',
      value: 9,
      at,
    })
    expect(fixed.point.value).toBe(9)
    const snapshot = getDb()
      .prepare('SELECT COUNT(*) AS c FROM feature_metric_points WHERE feature_id = ?')
      .get(featureId) as { c: number }
    expect(snapshot.c).toBe(1)
  })

  it('toda escrita do loop faz broadcast em loop:updated; leitura não', () => {
    call('feature_pulse_set', { featureId, body: 'Vivo.' })
    call('feature_ledger_append', { featureId, entryId: 'e1', body: 'algo' })
    call('feature_metric_declare', { featureId, columnKey: 'k' })
    call('feature_metric_record', { featureId, columnKey: 'k', value: 1 })
    expect(notify.calls).toHaveLength(4)
    expect(notify.calls.every(([channel]) => channel === 'loop:updated')).toBe(true)
    expect(notify.calls.every(([, payload]) => (payload as { featureId: string }).featureId === featureId)).toBe(true)

    notify.calls.length = 0
    call('feature_health_get', { featureId })
    call('feature_pulse_history', { featureId })
    call('feature_ledger_list', { featureId })
    expect(notify.calls).toEqual([])
  })

  it('feature_pulse_history devolve os pulsos do mais recente pro mais antigo', () => {
    call('feature_pulse_set', { featureId, body: 'Primeiro.' })
    call('feature_pulse_set', { featureId, body: 'Segundo.' })
    const history = call<{ items: FeaturePulse[] }>('feature_pulse_history', { featureId })
    expect(history.items.map((p) => p.body)).toEqual(['Segundo.', 'Primeiro.'])
  })

  it('feature_loop_export escreve o doc no repo vinculado e o dryRun não toca no disco', async () => {
    call('feature_pulse_set', { featureId, body: 'Pronto pra exportar.' })
    const slug = (
      getDb().prepare('SELECT slug FROM features WHERE id = ?').get(featureId) as { slug: string }
    ).slug
    const target = join(repoDir, '.pitwall', `loop-${slug}.md`)

    const dry = await callAsync<{ written: string[]; dryRun: boolean }>('feature_loop_export', {
      featureId,
      dryRun: true,
    })
    expect(dry.written).toEqual([target])
    expect(dry.dryRun).toBe(true)
    expect(existsSync(target)).toBe(false)

    const real = await callAsync<{ written: string[]; skipped: unknown[] }>('feature_loop_export', {
      featureId,
    })
    expect(real.written).toEqual([target])
    expect(real.skipped).toEqual([])
    expect(readFileSync(target, 'utf8')).toContain('Pronto pra exportar.')
  })
})
