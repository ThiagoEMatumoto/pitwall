/** @vitest-environment node */
// Unit dos handlers MCP contra um DB better-sqlite3 real (tmp dir), com o
// electron mockado (app.getPath → tmp) e o notify espiado. Mesma estratégia
// dos testes de migration: schema real via runMigrations, sem janela.
import { rmSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'mcp-tools-test-'))
  return {
    app: { getPath: () => dir, getVersion: () => '0.0.0-test' },
    BrowserWindow: { getAllWindows: () => [] },
  }
})

import { existsSync } from 'node:fs'
import { app } from 'electron'
import { closeDb, getDb } from '../db'
import { buildTools, type McpNotify, type ToolDef } from './tools'
// Módulos leves (sem electron): store lê só o DB mockado; composeJobKickoff é puro.
import * as jobStore from '../scheduled-job-store'
import { composeJobKickoff } from '../job-kickoff'
import { setSpawnHandoffChild, type SpawnHandoffChildInput } from '../handoff/spawn-child'
import { setPref } from '../prefs-store'
import type {
  ContentContract,
  ContentGateRun,
  Feature,
  JobRun,
  KeyResult,
  Objective,
  ObjectiveDetail,
  OverviewData,
  ScheduledJob,
  Task,
} from '../../../../shared/types/ipc'

interface NotifySpy extends McpNotify {
  calls: Array<[string, unknown]>
  affected: unknown[][]
}

function makeNotify(): NotifySpy {
  const calls: Array<[string, unknown]> = []
  const affected: unknown[][] = []
  return {
    calls,
    affected,
    broadcast: (channel, payload) => calls.push([channel, payload]),
    affectedObjectives: (links) => affected.push(links),
    affectedObjectivesForFeatureLinks: (links) => affected.push(links),
  }
}

let notify: NotifySpy
let tools: ToolDef[]

function tool(name: string): ToolDef {
  const def = tools.find((t) => t.name === name)
  if (!def) throw new Error(`tool not registered: ${name}`)
  return def
}

function call<T>(name: string, args: unknown): T {
  return tool(name).handler(args).structuredContent as T
}

beforeEach(() => {
  notify = makeNotify()
  tools = buildTools(notify)
})

afterAll(() => {
  closeDb()
  rmSync(app.getPath('userData'), { recursive: true, force: true })
})

describe('mcp tools — objectives/KRs', () => {
  it('objective_create persiste, broadcasta e retorna o objetivo', () => {
    const { objective } = call<{ objective: Objective }>('objective_create', {
      title: 'Lançar o MCP',
      kind: 'okr',
      description: 'Server embutido',
    })
    expect(objective.id).toBeTruthy()
    expect(objective.title).toBe('Lançar o MCP')
    expect(objective.kind).toBe('okr')

    const row = getDb().prepare('SELECT title FROM objectives WHERE id = ?').get(objective.id) as {
      title: string
    }
    expect(row.title).toBe('Lançar o MCP')
    expect(notify.calls).toEqual([['objective:updated', objective]])
  })

  it('objective_create rejeita input inválido (zod)', () => {
    expect(() => tool('objective_create').handler({ title: '', kind: 'okr' })).toThrow()
    expect(() => tool('objective_create').handler({ title: 'X', kind: 'nope' })).toThrow()
    expect(notify.calls).toEqual([])
  })

  it('objective_list filtra e objective_get retorna detalhe com KRs', () => {
    const { objective } = call<{ objective: Objective }>('objective_create', {
      title: 'Com KR',
      kind: 'project',
    })
    const { keyResult } = call<{ keyResult: KeyResult }>('key_result_create', {
      objectiveId: objective.id,
      title: 'KR 1',
    })
    expect(keyResult.objectiveId).toBe(objective.id)
    // create do KR broadcasta o marcador {id, keyResultId}.
    expect(notify.calls.at(-1)).toEqual([
      'objective:updated',
      { id: objective.id, keyResultId: keyResult.id },
    ])

    const { items } = call<{ items: Objective[] }>('objective_list', { kind: 'project' })
    expect(items.some((o) => o.id === objective.id)).toBe(true)
    expect(items.every((o) => o.kind === 'project')).toBe(true)

    const { objective: detail } = call<{ objective: ObjectiveDetail }>('objective_get', {
      id: objective.id,
    })
    expect(detail.keyResults.map((k) => k.id)).toContain(keyResult.id)
  })

  it('objective_get retorna null quando não existe', () => {
    const { objective } = call<{ objective: null }>('objective_get', { id: 'nao-existe' })
    expect(objective).toBeNull()
  })

  it('objective_update muda só os campos enviados', () => {
    const { objective } = call<{ objective: Objective }>('objective_create', {
      title: 'Antes',
      kind: 'custom',
      owner: 'thiago',
    })
    const { objective: updated } = call<{ objective: Objective }>('objective_update', {
      id: objective.id,
      title: 'Depois',
    })
    expect(updated.title).toBe('Depois')
    expect(updated.owner).toBe('thiago')
    expect(notify.calls.at(-1)).toEqual(['objective:updated', updated])
  })

  it('objective_archive arquiva e broadcasta o marcador', () => {
    const { objective } = call<{ objective: Objective }>('objective_create', {
      title: 'Arquivável',
      kind: 'custom',
    })
    const out = call<{ id: string; archived: boolean }>('objective_archive', { id: objective.id })
    expect(out).toEqual({ id: objective.id, archived: true })
    const row = getDb()
      .prepare('SELECT archived_at FROM objectives WHERE id = ?')
      .get(objective.id) as { archived_at: number | null }
    expect(row.archived_at).not.toBeNull()
    expect(notify.calls.at(-1)).toEqual(['objective:updated', { id: objective.id, archived: true }])
  })

  it('não expõe tools de delete destrutivo (exceção: diagram_delete, two-step)', () => {
    const names = tools.map((t) => t.name)
    // diagram_delete é a exceção documentada: exige archive prévio + confirm.
    expect(names.filter((n) => n.includes('delete'))).toEqual(['diagram_delete'])
  })

  it('key_result_update altera o KR e broadcasta o marcador', () => {
    const { objective } = call<{ objective: Objective }>('objective_create', {
      title: 'Pai de KR',
      kind: 'okr',
    })
    const { keyResult } = call<{ keyResult: KeyResult }>('key_result_create', {
      objectiveId: objective.id,
      title: 'KR original',
    })
    const { keyResult: updated } = call<{ keyResult: KeyResult }>('key_result_update', {
      id: keyResult.id,
      title: 'KR renomeado',
      status: 'done',
    })
    expect(updated.title).toBe('KR renomeado')
    expect(updated.status).toBe('done')
    expect(notify.calls.at(-1)).toEqual([
      'objective:updated',
      { id: objective.id, keyResultId: keyResult.id },
    ])
  })
})

describe('mcp tools — tasks', () => {
  it('task_create com link broadcasta task e objetivos afetados', () => {
    const { objective } = call<{ objective: Objective }>('objective_create', {
      title: 'Objetivo de tarefa',
      kind: 'okr',
    })
    const links = [{ parentType: 'objective', parentId: objective.id }]
    const { task } = call<{ task: Task }>('task_create', {
      title: 'Tarefa via MCP',
      priority: 'high',
      links,
    })
    expect(task.id).toBeTruthy()
    expect(task.links).toEqual(links)

    const row = getDb().prepare('SELECT title FROM tasks WHERE id = ?').get(task.id) as {
      title: string
    }
    expect(row.title).toBe('Tarefa via MCP')
    expect(notify.calls.at(-1)).toEqual(['task:updated', task])
    expect(notify.affected.at(-1)).toEqual(links)
  })

  it('task_list filtra por status e por parent', () => {
    const { task } = call<{ task: Task }>('task_create', { title: 'Só todo', status: 'todo' })
    const { items } = call<{ items: Task[] }>('task_list', { status: 'todo' })
    expect(items.some((t) => t.id === task.id)).toBe(true)
    expect(items.every((t) => t.status === 'todo')).toBe(true)
  })

  it('task_update muda campos e re-broadcasta', () => {
    const { task } = call<{ task: Task }>('task_create', { title: 'Pra atualizar' })
    const { task: updated } = call<{ task: Task }>('task_update', {
      id: task.id,
      status: 'done',
    })
    expect(updated.status).toBe('done')
    expect(notify.calls.at(-1)).toEqual(['task:updated', updated])
  })

  it('round-trip do auto-tracking: task_create com tag "auto" linkada à feature', () => {
    // Cenário das SERVER_INSTRUCTIONS: a sessão cria uma task de follow-up com
    // tag "auto" e link parentType "feature" pro featureId do spawn prompt.
    getDb()
      .prepare(`INSERT OR IGNORE INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)`)
      .run('proj-auto', 'Projeto auto-tracking', Date.now(), Date.now())
    const { feature } = call<{ feature: Feature }>('feature_create', {
      projectId: 'proj-auto',
      title: 'Feature rastreada',
    })
    const links = [{ parentType: 'feature', parentId: feature.id }]
    const { task } = call<{ task: Task }>('task_create', {
      title: 'Follow-up descoberto na sessão',
      tags: ['auto'],
      links,
    })
    expect(task.tags).toContain('auto')
    expect(task.links).toEqual(links)
    expect(notify.affected.at(-1)).toEqual(links)

    // Round-trip: o filtro por parent feature devolve a task com a tag intacta.
    const { items } = call<{ items: Task[] }>('task_list', {
      parentType: 'feature',
      parentId: feature.id,
    })
    const found = items.find((t) => t.id === task.id)
    expect(found).toBeDefined()
    expect(found?.tags).toContain('auto')
    expect(found?.links).toEqual(links)
  })

  it('task_set_links substitui vínculos e notifica quem ganhou E quem perdeu', () => {
    const { objective: a } = call<{ objective: Objective }>('objective_create', {
      title: 'Perde tarefa',
      kind: 'okr',
    })
    const { objective: b } = call<{ objective: Objective }>('objective_create', {
      title: 'Ganha tarefa',
      kind: 'okr',
    })
    const { task } = call<{ task: Task }>('task_create', {
      title: 'Migra de objetivo',
      links: [{ parentType: 'objective', parentId: a.id }],
    })
    const newLinks = [{ parentType: 'objective', parentId: b.id }]
    const { task: relinked } = call<{ task: Task }>('task_set_links', {
      taskId: task.id,
      links: newLinks,
    })
    expect(relinked.links).toEqual(newLinks)
    expect(notify.affected.at(-1)).toEqual([
      { parentType: 'objective', parentId: a.id },
      { parentType: 'objective', parentId: b.id },
    ])
  })

  it('task_create via MCP sempre grava origin "auto" (Onda 0)', () => {
    const { task } = call<{ task: Task }>('task_create', { title: 'Criada pela sessão' })
    expect(task.origin).toBe('auto')
  })

  it('task_create com link pra um alvo inexistente falha (mata órfão por id alucinado)', () => {
    expect(() =>
      tool('task_create').handler({
        title: 'Link fantasma',
        links: [{ parentType: 'objective', parentId: 'nao-existe' }],
      }),
    ).toThrow(/target not found/)
    // Nada foi persistido: a transação de create+links foi revertida.
    const { items } = call<{ items: Task[] }>('task_list', { search: 'Link fantasma' })
    expect(items).toHaveLength(0)
  })
})

describe('mcp tools — features', () => {
  function seedProject(id: string): void {
    getDb()
      .prepare(
        `INSERT OR IGNORE INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)`,
      )
      .run(id, `Projeto ${id}`, Date.now(), Date.now())
  }

  it('feature_create persiste, escreve o .md e broadcasta', () => {
    seedProject('proj-mcp')
    const { feature } = call<{ feature: Feature }>('feature_create', {
      projectId: 'proj-mcp',
      title: 'Feature via MCP',
      overview: 'Criada pelo teste de tools',
    })
    expect(feature.id).toBeTruthy()
    expect(feature.origin).toBe('manual')
    expect(existsSync(feature.docPath)).toBe(true)

    const row = getDb().prepare('SELECT title FROM features WHERE id = ?').get(feature.id) as {
      title: string
    }
    expect(row.title).toBe('Feature via MCP')
    expect(notify.calls.at(-1)?.[0]).toBe('feature:updated')
  })

  it('feature_get traz o corpo; feature_list filtra por projeto', () => {
    seedProject('proj-mcp')
    const { feature } = call<{ feature: Feature }>('feature_create', {
      projectId: 'proj-mcp',
      title: 'Com corpo',
      overview: 'Texto da visão geral',
    })
    const { feature: fetched } = call<{ feature: Feature }>('feature_get', { id: feature.id })
    expect(fetched.body).toContain('Texto da visão geral')

    const { items } = call<{ items: Feature[] }>('feature_list', { projectId: 'proj-mcp' })
    expect(items.some((f) => f.id === feature.id)).toBe(true)
    expect(items.every((f) => f.projectId === 'proj-mcp')).toBe(true)
  })

  it('feature_update e feature_archive espelham o IPC', () => {
    seedProject('proj-mcp')
    const { feature } = call<{ feature: Feature }>('feature_create', {
      projectId: 'proj-mcp',
      title: 'Pra arquivar',
    })
    const { feature: updated } = call<{ feature: Feature }>('feature_update', {
      id: feature.id,
      status: 'in-progress',
    })
    expect(updated.status).toBe('in-progress')

    const out = call<{ id: string; archived: boolean }>('feature_archive', { id: feature.id })
    expect(out).toEqual({ id: feature.id, archived: true })
    expect(notify.calls.at(-1)).toEqual(['feature:updated', { id: feature.id, archived: true }])
    const { items } = call<{ items: Feature[] }>('feature_list', { projectId: 'proj-mcp' })
    expect(items.some((f) => f.id === feature.id)).toBe(false)
  })

  it('feature_set_objective_links notifica objetivos que ganharam e perderam', () => {
    seedProject('proj-mcp')
    const { objective: a } = call<{ objective: Objective }>('objective_create', {
      title: 'Objetivo A da feature',
      kind: 'okr',
    })
    const { objective: b } = call<{ objective: Objective }>('objective_create', {
      title: 'Objetivo B da feature',
      kind: 'okr',
    })
    const { feature } = call<{ feature: Feature }>('feature_create', {
      projectId: 'proj-mcp',
      title: 'Linkável',
    })
    call('feature_set_objective_links', {
      featureId: feature.id,
      links: [{ targetType: 'objective', targetId: a.id }],
    })
    const { feature: relinked } = call<{ feature: Feature }>('feature_set_objective_links', {
      featureId: feature.id,
      links: [{ targetType: 'objective', targetId: b.id }],
    })
    expect(relinked.id).toBe(feature.id)
    expect(notify.calls.at(-1)?.[0]).toBe('feature:updated')
    expect(notify.affected.at(-1)).toEqual([
      { targetType: 'objective', targetId: a.id },
      { targetType: 'objective', targetId: b.id },
    ])
  })

  it('feature_set_objective_links com alvo inexistente falha (mata órfão por id alucinado)', () => {
    seedProject('proj-mcp')
    const { feature } = call<{ feature: Feature }>('feature_create', {
      projectId: 'proj-mcp',
      title: 'Sem alvo válido',
    })
    expect(() =>
      tool('feature_set_objective_links').handler({
        featureId: feature.id,
        links: [{ targetType: 'objective', targetId: 'nao-existe' }],
      }),
    ).toThrow(/target not found/)
  })

  it('feature_list/feature_get expõem objectiveLinkCount (Onda 0)', () => {
    seedProject('proj-mcp')
    const { objective } = call<{ objective: Objective }>('objective_create', {
      title: 'Objetivo pra contar',
      kind: 'okr',
    })
    const { feature } = call<{ feature: Feature }>('feature_create', {
      projectId: 'proj-mcp',
      title: 'Sem OKR ainda',
    })
    const { items } = call<{ items: Feature[] }>('feature_list', { projectId: 'proj-mcp' })
    expect(items.find((f) => f.id === feature.id)?.objectiveLinkCount).toBe(0)

    call('feature_set_objective_links', {
      featureId: feature.id,
      links: [{ targetType: 'objective', targetId: objective.id }],
    })
    const { feature: linked } = call<{ feature: Feature }>('feature_get', { id: feature.id })
    expect(linked.objectiveLinkCount).toBe(1)
  })

  it('objective_get expõe feature arquivada depois de vinculada como órfã em vez de sumir (Onda 1), e a exclui do rollup', () => {
    seedProject('proj-mcp')
    const { objective } = call<{ objective: Objective }>('objective_create', {
      title: 'Objetivo com feature órfã',
      kind: 'okr',
    })
    const { feature } = call<{ feature: Feature }>('feature_create', {
      projectId: 'proj-mcp',
      title: 'Vai ser arquivada',
    })
    call('feature_update', { id: feature.id, status: 'in-progress' })
    call('feature_set_objective_links', {
      featureId: feature.id,
      links: [{ targetType: 'objective', targetId: objective.id }],
    })
    call('feature_archive', { id: feature.id })

    const { objective: detail } = call<{ objective: ObjectiveDetail }>('objective_get', {
      id: objective.id,
    })
    expect(detail.linkedFeatures).toHaveLength(1)
    expect(detail.linkedFeatures[0]).toMatchObject({ id: feature.id, archived: true })
    // Arquivada sai do rollup (sem outro filho elegível) — progresso fica indeterminado,
    // não 0: a feature não conta contra o objetivo, só sai da conta.
    expect(detail.progress).toBeNull()
  })
})

describe('mcp tools — overview', () => {
  it('overview_get retorna o snapshot agregado', () => {
    call('objective_create', { title: 'Ativo no overview', kind: 'okr' })
    const { overview } = call<{ overview: OverviewData }>('overview_get', {})
    expect(overview.counts.activeObjectives).toBeGreaterThan(0)
    expect(Array.isArray(overview.objectives)).toBe(true)
    expect(Array.isArray(overview.pending)).toBe(true)
    expect(Array.isArray(overview.features)).toBe(true)
  })
})

describe('mcp tools — scheduled jobs', () => {
  it('scheduled_job_create persiste + broadcasta e scheduled_job_list lista', () => {
    const { job } = call<{ job: ScheduledJob }>('scheduled_job_create', {
      name: 'crítique das extrações',
      prompt: 'audite as extrações do TRF2',
      schedule: { type: 'interval', hours: 24 },
    })
    expect(job.id).toBeTruthy()
    expect(job.name).toBe('crítique das extrações')
    expect(job.enabled).toBe(true)
    expect(job.nextRunAt).toBeGreaterThan(Date.now())
    // permissionMode default = observe-only ('default': crítica no relatório + lockdown).
    expect(job.permissionMode).toBe('default')
    expect(notify.calls.at(-1)).toEqual(['scheduledJob:updated', job])

    const { items } = call<{ items: ScheduledJob[] }>('scheduled_job_list', {})
    expect(items.some((j) => j.id === job.id)).toBe(true)
  })

  it('scheduled_job_create rejeita input inválido (zod)', () => {
    expect(() =>
      tool('scheduled_job_create').handler({
        name: '',
        prompt: 'x',
        schedule: { type: 'interval', hours: 24 },
      }),
    ).toThrow()
    // HH:MM fora do range no schedule daily.
    expect(() =>
      tool('scheduled_job_create').handler({
        name: 'X',
        prompt: 'x',
        schedule: { type: 'daily', hour: 99, minute: 0 },
      }),
    ).toThrow()
  })

  it('scheduled_job_create/update rejeitam permissionMode autônomo (gate observe-only)', () => {
    const base = { name: 'gated', prompt: 'roda', schedule: { type: 'interval', hours: 24 } }
    // Modos autônomos barrados na fronteira MCP (fecha a self-elevation por injection).
    for (const permissionMode of ['bypassPermissions', 'dontAsk', 'acceptEdits', 'auto']) {
      expect(() =>
        tool('scheduled_job_create').handler({ ...base, permissionMode }),
      ).toThrow(/autônomo indisponível via MCP/)
    }
    // Observe-only passa: plan e default são aceitos.
    const { job } = call<{ job: ScheduledJob }>('scheduled_job_create', {
      ...base,
      permissionMode: 'plan',
    })
    expect(job.permissionMode).toBe('plan')

    // O gate sobrevive ao .partial() do update schema.
    expect(() =>
      tool('scheduled_job_update').handler({ id: job.id, permissionMode: 'bypassPermissions' }),
    ).toThrow(/autônomo indisponível via MCP/)
    const { job: updated } = call<{ job: ScheduledJob }>('scheduled_job_update', {
      id: job.id,
      permissionMode: 'default',
    })
    expect(updated.permissionMode).toBe('default')
  })

  it('scheduled_job_update pausa o job (enabled=false → row enabled=0)', () => {
    const { job } = call<{ job: ScheduledJob }>('scheduled_job_create', {
      name: 'pausável',
      prompt: 'roda',
      schedule: { type: 'interval', hours: 12 },
    })
    const { job: paused } = call<{ job: ScheduledJob }>('scheduled_job_update', {
      id: job.id,
      enabled: false,
    })
    expect(paused.enabled).toBe(false)
    const row = getDb()
      .prepare('SELECT enabled FROM scheduled_jobs WHERE id = ?')
      .get(job.id) as { enabled: number }
    expect(row.enabled).toBe(0)
    expect(notify.calls.at(-1)).toEqual(['scheduledJob:updated', paused])
  })

  it('job_run_list retorna o histórico de runs de um job (com filtro por status)', () => {
    const { job } = call<{ job: ScheduledJob }>('scheduled_job_create', {
      name: 'com runs',
      prompt: 'roda',
      schedule: { type: 'interval', hours: 6 },
    })
    // Semeia runs direto no store (não há tool de create-run; runs nascem do scheduler).
    const r1 = jobStore.createRun({ jobId: job.id, status: 'success' })
    jobStore.createRun({ jobId: job.id, status: 'failed' })

    const { items } = call<{ items: JobRun[] }>('job_run_list', { jobId: job.id })
    expect(items.length).toBe(2)
    expect(items.every((r) => r.jobId === job.id)).toBe(true)

    const { items: onlySuccess } = call<{ items: JobRun[] }>('job_run_list', {
      jobId: job.id,
      status: 'success',
    })
    expect(onlySuccess.map((r) => r.id)).toEqual([r1.id])
  })

  it('job_report grava o report e marca a run success', () => {
    const { job } = call<{ job: ScheduledJob }>('scheduled_job_create', {
      name: 'reportável',
      prompt: 'roda',
      schedule: { type: 'interval', hours: 6 },
    })
    const run = jobStore.createRun({ jobId: job.id, status: 'running' })
    const { run: reported } = call<{ run: JobRun }>('job_report', {
      runId: run.id,
      report: '## Achados\n- item novo detectado',
    })
    expect(reported.id).toBe(run.id)
    expect(reported.status).toBe('success')
    expect(reported.reportText).toContain('item novo detectado')
    expect(reported.captureQuality).toBe('full')
    expect(notify.calls.at(-1)).toEqual(['jobRun:updated', reported])
  })

  it('job_report lança quando o runId não existe', () => {
    expect(() => tool('job_report').handler({ runId: 'nao-existe', report: 'x' })).toThrow()
  })
})

describe('composeJobKickoff (delta-via-prompt)', () => {
  it('com run anterior: injeta o relatório pedindo novo/resolvido/persistente', () => {
    const kickoff = composeJobKickoff({
      prompt: 'audite as extrações',
      runId: 'run-1',
      previousReport: '## Achados anteriores\n- fan-out no endpoint X',
    })
    expect(kickoff).toContain('audite as extrações')
    expect(kickoff).toContain('execução anterior')
    expect(kickoff).toContain('novo')
    expect(kickoff).toContain('persistente')
    // o texto do relatório anterior é embutido literalmente.
    expect(kickoff).toContain('fan-out no endpoint X')
  })

  it('sem run anterior: kickoff limpo (não injeta o bloco de delta)', () => {
    const kickoff = composeJobKickoff({
      prompt: 'audite as extrações',
      runId: 'run-1',
      previousReport: null,
    })
    expect(kickoff).toContain('audite as extrações')
    expect(kickoff).not.toContain('execução anterior')
  })

  it('NÃO injeta a instrução job_report (MCP inalcançável no spawn headless)', () => {
    const kickoff = composeJobKickoff({ prompt: 'roda', runId: 'run-42' })
    expect(kickoff).not.toContain('job_report')
    // sem run anterior nem delta: o kickoff é só o prompt do job.
    expect(kickoff).toBe('roda')
  })

  it('critique NÃO injeta o playbook de browser', () => {
    expect(composeJobKickoff({ prompt: 'roda' })).not.toContain('Playbook de auditoria web')
    expect(composeJobKickoff({ prompt: 'roda', kind: 'critique' })).not.toContain(
      'Playbook de auditoria web',
    )
  })
})

describe('composeJobKickoff (web-audit playbook)', () => {
  it('injeta o playbook + a targetUrl + o formato de saída JSON', () => {
    const kickoff = composeJobKickoff({
      prompt: 'audite a home',
      kind: 'web-audit',
      targetUrl: 'https://app.legalstaging.lexter.ai',
    })
    expect(kickoff).toContain('audite a home')
    expect(kickoff).toContain('Playbook de auditoria web')
    expect(kickoff).toContain('https://app.legalstaging.lexter.ai')
    // bloco JSON de métricas que a Fase 2 vai parsear.
    expect(kickoff).toContain('"lcp"')
    expect(kickoff).toContain('consoleErrors')
    // regra de segurança presente.
    expect(kickoff).toContain('NUNCA escreva as credenciais')
    // proíbe delegar a sub-agentes (eles não herdam as browser tools do job).
    expect(kickoff).toContain('NÃO delegue a sub-agentes')
  })

  it('resolve as env vars de login por staging vs prod pela targetUrl (determinístico)', () => {
    const staging = composeJobKickoff({
      prompt: 'x',
      kind: 'web-audit',
      targetUrl: 'https://app.legalstaging.lexter.ai/app/casos',
    })
    expect(staging).toContain('LEGAL_UI_STAGING_USERNAME')
    expect(staging).toContain('LEGAL_UI_STAGING_PASSWORD')
    expect(staging).not.toContain('LEGAL_UI_PROD_USERNAME')

    const prod = composeJobKickoff({
      prompt: 'x',
      kind: 'web-audit',
      targetUrl: 'https://app.legal.lexter.ai/app/casos',
    })
    expect(prod).toContain('LEGAL_UI_PROD_USERNAME')
    expect(prod).not.toContain('LEGAL_UI_STAGING_USERNAME')
  })

  it('ambíguo/sem URL cai em STAGING (fail toward non-prod)', () => {
    const kickoff = composeJobKickoff({ prompt: 'x', kind: 'web-audit', targetUrl: null })
    expect(kickoff).toContain('LEGAL_UI_STAGING_USERNAME')
    expect(kickoff).not.toContain('LEGAL_UI_PROD_USERNAME')
  })

  it('NUNCA embute o valor real de uma credencial (só os nomes das env vars)', () => {
    // O playbook referencia printenv <VAR>; jamais o valor. Prova textual: não há
    // "password=" nem literais de senha — só instruções de leitura via env.
    const kickoff = composeJobKickoff({
      prompt: 'x',
      kind: 'web-audit',
      targetUrl: 'https://app.legalstaging.lexter.ai',
    })
    expect(kickoff).toContain('printenv LEGAL_UI_STAGING_PASSWORD')
    expect(kickoff.toLowerCase()).not.toContain('senha real')
  })
})

describe('mcp tools — session_handoff sem gate', () => {
  // Todos opcionais: o retorno varia por caminho (spawn ok / gate pending / dedup
  // recusado / falha de spawn) e o dedup NÃO devolve mais handle nenhum.
  interface HandoffResult {
    handoffId?: string
    alias?: string | null
    status?: string
    duplicate?: boolean
    error?: string
  }

  let spawned: SpawnHandoffChildInput[]

  function seedRepo(label: string, path: string): void {
    const db = getDb()
    db.prepare(
      'INSERT OR IGNORE INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)',
    ).run('proj-handoff', 'Projeto handoff', Date.now(), Date.now())
    db.prepare(
      'INSERT OR IGNORE INTO repos (id, project_id, label, path, role, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(`repo-${label}`, 'proj-handoff', label, path, null, 0, Date.now())
  }

  beforeEach(() => {
    spawned = []
    // O DB persiste entre os casos deste arquivo: sem limpar, os handoffs ativos
    // acumulam e o dedup por repo-alvo recusa o despacho de quem rodar por último.
    // Handoffs antes de sessions (FK child_session_id).
    getDb().prepare('DELETE FROM handoffs').run()
    getDb().prepare('DELETE FROM sessions').run()
    // Fake do seam: registra o input e devolve uma sessão real no DB (markRunning
    // tem FK pra sessions).
    setSpawnHandoffChild((input) => {
      spawned.push(input)
      // Id único por spawn: o DB deste arquivo persiste entre os testes, e um id
      // repetido estouraria a PK de sessions (mascarando o caso sob teste).
      const id = `sess-${randomUUID()}`
      getDb()
        .prepare(
          `INSERT INTO sessions (id, repo_id, cc_session_id, title, title_source, pane_id, status, started_at, ended_at)
           VALUES (?, ?, ?, ?, 'manual', NULL, 'running', ?, NULL)`,
        )
        .run(id, input.repoId, `cc-${id}`, input.name, Date.now())
      return {
        id,
        repoId: input.repoId,
        ccSessionId: `cc-${id}`,
        title: input.name,
        titleSource: 'manual',
        paneId: null,
        status: 'running',
        startedAt: Date.now(),
        endedAt: null,
      }
    })
    setPref('handoffs.requireApproval', false)
  })

  it('spawna direto (running, sem pending) e devolve o alias endereçável', () => {
    seedRepo('backend', '/repos/backend')
    const res = call<HandoffResult>('session_handoff', {
      targetRepo: 'backend',
      task: 'Refatorar autenticação (OAuth)',
      mode: 'auto-edits',
    })

    expect(res.status).toBe('running')
    expect(res.alias).toBe('mauricio-refatorar-autenticacao-oauth')
    expect(spawned).toHaveLength(1)
    expect(spawned[0].name).toBe('mauricio-refatorar-autenticacao-oauth')
    expect(spawned[0].permissionMode).toBe('acceptEdits')
    // O briefing entregue à filha anuncia o MESMO apelido pelo qual ela é
    // endereçada — o alias não pode divergir entre o -n e o system prompt.
    expect(spawned[0].systemPromptText).toContain(
      'Seu apelido: mauricio-refatorar-autenticacao-oauth',
    )
    expect(spawned[0].systemPromptText).toContain('<cross-session-message>')

    // A UI não spawna mais — o broadcast do main é o que a mantém viva.
    const last = notify.calls.at(-1)
    expect(last?.[0]).toBe('handoff:updated')
    expect((last?.[1] as { status: string }).status).toBe('running')

    // E o alias volta pelo handoff_list (fonte da verdade do roster).
    const { items } = call<{ items: Array<{ handoffId: string; alias: string | null }> }>(
      'handoff_list',
      {},
    )
    expect(items.find((i) => i.handoffId === res.handoffId)?.alias).toBe(
      'mauricio-refatorar-autenticacao-oauth',
    )
  })

  // Não há mais teto de handoffs ativos: o Crew Dock dá a visibilidade das filhas
  // e o gate humano que o cap protegia deixou de existir.
  it('despacha além de 5 filhas ativas simultâneas', () => {
    for (let i = 0; i < 8; i++) {
      seedRepo(`svc-${i}`, `/repos/svc-${i}`)
      const res = call<HandoffResult>('session_handoff', {
        targetRepo: `svc-${i}`,
        task: `Tarefa ${i}`,
      })
      expect(res.status).toBe('running')
    }
    expect(spawned).toHaveLength(8)
  })

  it('kill-switch handoffs.requireApproval=true volta a nascer pending, sem spawnar', () => {
    seedRepo('billing', '/repos/billing')
    setPref('handoffs.requireApproval', true)
    const res = call<HandoffResult>('session_handoff', {
      targetRepo: 'billing',
      task: 'Corrigir webhook',
    })
    expect(res.status).toBe('pending')
    expect(spawned).toHaveLength(0)
  })

  // REGRESSÃO: o dedup é por REPO-alvo, não por sessão-mãe (mother_session_id nem
  // é gravado). Devolver { handoffId, alias, status } fazia uma segunda mãe adotar
  // a filha de OUTRA mãe e passar a conversar com ela.
  it('dedup por repo-alvo RECUSA com erro em vez de entregar o handle da filha alheia', () => {
    seedRepo('search', '/repos/search')
    const first = call<HandoffResult>('session_handoff', {
      targetRepo: 'search',
      task: 'Indexar documentos',
      mode: 'auto-edits',
    })
    const dup = call<HandoffResult>('session_handoff', {
      targetRepo: 'search',
      task: 'Outra coisa qualquer',
    })

    expect(dup.duplicate).toBe(true)
    // Nada de handle utilizável: sem handoffId/alias/status pra adotar.
    expect(dup.handoffId).toBeUndefined()
    expect(dup.alias).toBeUndefined()
    expect(dup.status).toBeUndefined()
    // Erro informativo: diz quem já está lá e como forçar.
    expect(dup.error).toContain(first.alias as string)
    expect(dup.error).toMatch(/force: true/)
    expect(spawned).toHaveLength(1)
  })

  it('force: true despacha a segunda filha mesmo com o repo-alvo ocupado', () => {
    seedRepo('payments', '/repos/payments')
    call<HandoffResult>('session_handoff', { targetRepo: 'payments', task: 'Primeira tarefa' })
    const second = call<HandoffResult>('session_handoff', {
      targetRepo: 'payments',
      task: 'Segunda tarefa',
      force: true,
    })
    expect(second.status).toBe('running')
    expect(second.error).toBeUndefined()
    expect(spawned).toHaveLength(2)
  })

  it('falha de spawn não deixa o handoff preso: vira failed com o erro', () => {
    seedRepo('ghost', '/repos/ghost')
    setSpawnHandoffChild(() => {
      throw new Error('Repositório não existe no disco: /repos/ghost')
    })
    const res = call<HandoffResult>('session_handoff', {
      targetRepo: 'ghost',
      task: 'Qualquer coisa',
    })
    expect(res.status).toBe('failed')
    expect(res.error).toMatch(/não existe no disco/)
  })

  // A identidade da mãe vem do CTX (carimbado pelo app no spawn), nunca dos
  // args da tool. Com ela o dedup ganha um segundo nível: "já é sua" ≠ "não é sua".
  describe('identidade da sessão-mãe (ctx)', () => {
    const MOTHER_A = '3f2504e0-4f89-11d3-9a0c-0305e82c3301'
    const MOTHER_B = '11111111-2222-3333-4444-555555555555'

    // Cada mãe fala com o MESMO server por um conjunto próprio de ToolDefs — é
    // o que o server faz por request (McpServer novo, registerTools com o ctx).
    function callAs<T>(motherSessionId: string | null, name: string, args: unknown): T {
      const def = buildTools(notify, { motherSessionId }).find((t) => t.name === name)
      if (!def) throw new Error(`tool not registered: ${name}`)
      return def.handler(args).structuredContent as T
    }

    const motherOf = (handoffId: string): string | null =>
      (
        getDb()
          .prepare('SELECT mother_session_id FROM handoffs WHERE id = ?')
          .get(handoffId) as { mother_session_id: string | null }
      ).mother_session_id

    it('grava o mother_session_id do ctx no handoff', () => {
      seedRepo('ident', '/repos/ident')
      const res = callAs<HandoffResult>(MOTHER_A, 'session_handoff', {
        targetRepo: 'ident',
        task: 'Trabalho da mãe A',
      })
      expect(res.status).toBe('running')
      expect(motherOf(res.handoffId as string)).toBe(MOTHER_A)
    })

    it('ctx ausente mantém o legado: mother_session_id null', () => {
      seedRepo('legado', '/repos/legado')
      const res = call<HandoffResult>('session_handoff', {
        targetRepo: 'legado',
        task: 'Sem carimbo',
      })
      expect(motherOf(res.handoffId as string)).toBeNull()
    })

    it('NÍVEL 1 — mesma mãe: recusa dizendo que a filha já é dela', () => {
      seedRepo('mesma', '/repos/mesma')
      callAs<HandoffResult>(MOTHER_A, 'session_handoff', { targetRepo: 'mesma', task: 'Primeira' })
      const dup = callAs<HandoffResult>(MOTHER_A, 'session_handoff', {
        targetRepo: 'mesma',
        task: 'Segunda',
      })
      expect(dup.duplicate).toBe(true)
      expect(dup.handoffId).toBeUndefined()
      expect(dup.error).toMatch(/JÁ despachou/)
      expect(dup.error).toMatch(/ela é sua/)
      expect(dup.error).toMatch(/force: true/)
      expect(spawned).toHaveLength(1)
    })

    it('NÍVEL 2 — outra mãe: recusa dizendo que a filha NÃO é dela', () => {
      seedRepo('alheia', '/repos/alheia')
      callAs<HandoffResult>(MOTHER_A, 'session_handoff', { targetRepo: 'alheia', task: 'Da mãe A' })
      const dup = callAs<HandoffResult>(MOTHER_B, 'session_handoff', {
        targetRepo: 'alheia',
        task: 'Da mãe B',
      })
      expect(dup.duplicate).toBe(true)
      expect(dup.error).toMatch(/NÃO é sua/)
      expect(dup.error).toMatch(/outra sessão-mãe/)
      // Mensagem DISTINTA da do nível 1 — a mãe B não pode ler "você já despachou".
      expect(dup.error).not.toMatch(/JÁ despachou/)
      expect(spawned).toHaveLength(1)
    })

    it('NÍVEL 2 — identidade conhecida NÃO libera o repo ocupado por uma mãe legada (null)', () => {
      seedRepo('misto', '/repos/misto')
      call<HandoffResult>('session_handoff', { targetRepo: 'misto', task: 'Legada' })
      const dup = callAs<HandoffResult>(MOTHER_A, 'session_handoff', {
        targetRepo: 'misto',
        task: 'Com carimbo',
      })
      // Escopar SÓ pela mãe reabriria duas mães mutando o mesmo repo.
      expect(dup.duplicate).toBe(true)
      expect(spawned).toHaveLength(1)
    })

    it('NÍVEL 3 — sem identidade: cai no dedup por repo (mensagem legada)', () => {
      seedRepo('anonimo', '/repos/anonimo')
      callAs<HandoffResult>(MOTHER_A, 'session_handoff', { targetRepo: 'anonimo', task: 'Da mãe A' })
      const dup = call<HandoffResult>('session_handoff', {
        targetRepo: 'anonimo',
        task: 'Sem carimbo',
      })
      expect(dup.duplicate).toBe(true)
      expect(dup.error).toMatch(/pode NÃO ser sua/)
      expect(dup.error).toMatch(/sem identidade da sessão-mãe/)
      expect(spawned).toHaveLength(1)
    })

    it('repos-alvo diferentes: a mesma mãe segue despachando', () => {
      seedRepo('um', '/repos/um')
      seedRepo('dois', '/repos/dois')
      callAs<HandoffResult>(MOTHER_A, 'session_handoff', { targetRepo: 'um', task: 'A' })
      const second = callAs<HandoffResult>(MOTHER_A, 'session_handoff', {
        targetRepo: 'dois',
        task: 'B',
      })
      expect(second.status).toBe('running')
      expect(spawned).toHaveLength(2)
    })

    it('force: true segue como válvula de escape em qualquer nível', () => {
      seedRepo('forcado', '/repos/forcado')
      callAs<HandoffResult>(MOTHER_A, 'session_handoff', { targetRepo: 'forcado', task: 'A' })
      const forced = callAs<HandoffResult>(MOTHER_B, 'session_handoff', {
        targetRepo: 'forcado',
        task: 'B',
        force: true,
      })
      expect(forced.status).toBe('running')
      expect(motherOf(forced.handoffId as string)).toBe(MOTHER_B)
      expect(spawned).toHaveLength(2)
    })
  })
})
// Content contract: o valor da feature é o gate REPROVAR sem quebrar a sessão —
// quem decide o que fazer com um material não-entregável é quem chamou, não a
// tool. E é o schema, não o banco, que recusa emenda sem linha de changelog.
describe('mcp tools — content contracts', () => {
  const CONTRATO_BASE = {
    title: 'Orientação a requerentes',
    outputLabel: 'roteiro',
    status: 'active' as const,
    summary: 'contrato inicial',
    reason: 'briefing dos vídeos do INSS',
    forbiddenFacts: [
      {
        id: 'bpc-vitalicio',
        claim: 'o BPC é vitalício',
        forms: ['BPC é vitalício'],
        neutralForm: 'o BPC é revisto periodicamente',
      },
    ],
  }

  function novoContrato(slug: string): ContentContract {
    const { contract } = call<{ contract: ContentContract }>('content_contract_upsert', {
      ...CONTRATO_BASE,
      slug,
    })
    return contract
  }

  it('content_contract_get por slug devolve o contrato inteiro e o changelog', () => {
    const criado = novoContrato('inss-get')
    const { contract, versions } = call<{
      contract: ContentContract
      versions: Array<{ version: number; summary: string }>
    }>('content_contract_get', { slug: 'inss-get' })

    expect(contract.id).toBe(criado.id)
    expect(contract.outputLabel).toBe('roteiro')
    expect(contract.forbiddenFacts[0].neutralForm).toBe('o BPC é revisto periodicamente')
    expect(versions.map((v) => v.version)).toEqual([1])
  })

  it('content_contract_upsert sem a linha de changelog falha no parse (zod), sem tocar no banco', () => {
    expect(() =>
      tool('content_contract_upsert').handler({
        slug: 'sem-changelog',
        title: 'X',
        outputLabel: 'roteiro',
      }),
    ).toThrow()
    expect(() =>
      tool('content_contract_upsert').handler({
        slug: 'sem-changelog',
        title: 'X',
        outputLabel: 'roteiro',
        summary: 'só o summary',
      }),
    ).toThrow()

    expect(notify.calls).toEqual([])
    const row = getDb()
      .prepare('SELECT COUNT(*) AS n FROM content_contracts WHERE slug = ?')
      .get('sem-changelog') as { n: number }
    expect(row.n).toBe(0)
  })

  it('content_contract_upsert emenda o contrato existente: bumpa versão e broadcasta', () => {
    const criado = novoContrato('inss-bump')
    const { contract, created, bumped } = call<{
      contract: ContentContract
      created: boolean
      bumped: boolean
    }>('content_contract_upsert', {
      slug: 'inss-bump',
      status: 'draft',
      summary: 'volta pra rascunho',
      reason: 'revisão jurídica pendente',
    })

    expect(created).toBe(false)
    expect(bumped).toBe(true)
    expect(contract.version).toBe(criado.version + 1)
    expect(notify.calls.at(-1)).toEqual(['contentContract:updated', contract])
  })

  it('content_gate_run com gate bloqueante retorna blocking:true e NÃO lança', () => {
    novoContrato('inss-bloqueante')
    const res = call<{ run: ContentGateRun; passed: boolean; blocking: boolean; evidence: string }>(
      'content_gate_run',
      {
        slug: 'inss-bloqueante',
        gate: 'forbidden-facts',
        material: 'Muita gente acha que o BPC é vitalício.\n',
      },
    )

    expect(res.passed).toBe(false)
    expect(res.blocking).toBe(true)
    expect(res.run.status).toBe('failed')
    expect(res.evidence).toMatch(/fato proibido/)
    // A forma neutra viaja na evidência: reprovar sem dizer o que escrever no
    // lugar devolveria o problema pro modelo sem a saída.
    expect(res.evidence).toMatch(/o BPC é revisto periodicamente/)
  })

  it('content_gate_run grava a linha em content_gate_runs e dispara o broadcast', () => {
    const contrato = novoContrato('inss-evidencia')
    const antes = notify.calls.length
    const { run } = call<{ run: ContentGateRun }>('content_gate_run', {
      slug: 'inss-evidencia',
      gate: 'forbidden-facts',
      material: 'O BPC é vitalício, sim.\n',
    })

    const row = getDb()
      .prepare('SELECT contract_id, contract_version, gate, status, blocking_count FROM content_gate_runs WHERE id = ?')
      .get(run.id) as {
      contract_id: string
      contract_version: number
      gate: string
      status: string
      blocking_count: number
    }
    expect(row.contract_id).toBe(contrato.id)
    expect(row.contract_version).toBe(contrato.version)
    expect(row.gate).toBe('forbidden-facts')
    expect(row.status).toBe('failed')
    expect(row.blocking_count).toBe(1)
    expect(notify.calls.slice(antes)).toEqual([['contentGateRun:updated', run]])
  })

  it('content_gate_run_list filtra por contrato e gate, mais recente primeiro', () => {
    const contrato = novoContrato('inss-historico')
    call('content_gate_run', {
      slug: 'inss-historico',
      gate: 'forbidden-facts',
      material: 'Texto limpo.\n',
    })
    call('content_gate_run', {
      slug: 'inss-historico',
      gate: 'scope',
      material: 'Texto limpo.\n',
    })

    const { items } = call<{ items: ContentGateRun[] }>('content_gate_run_list', {
      contractId: contrato.id,
    })
    expect(items.map((r) => r.gate)).toEqual(['scope', 'forbidden-facts'])

    const so = call<{ items: ContentGateRun[] }>('content_gate_run_list', {
      contractId: contrato.id,
      gate: 'scope',
    })
    expect(so.items).toHaveLength(1)
  })
})

describe('mcp tools — diagrams', () => {
  interface DiagramMetaOut {
    id: string
    title: string
    kind: string
    status: string
    version: number
    sourceFormat: string | null
    links: Array<{ diagramId: string; parentType: string; parentId: string }>
  }
  interface SkeletonOut {
    id: string
    type: string
    label?: { text: string }
    start?: { id: string }
    end?: { id: string }
  }

  function novoDiagrama(title = 'Fluxo de auth'): DiagramMetaOut {
    const { diagram } = call<{ diagram: DiagramMetaOut }>('diagram_create', {
      title,
      kind: 'flow',
      summary: 'esboço inicial',
      elements: [
        { id: 'ui', type: 'rectangle', label: { text: 'Web UI' } },
        { id: 'api', type: 'rectangle', label: { text: 'Auth API' } },
        { id: 'e1', type: 'arrow', start: { id: 'ui' }, end: { id: 'api' }, label: { text: 'POST /login' } },
      ],
    })
    return diagram
  }

  it('diagram_create converte skeleton, persiste, broadcasta e devolve skeleton derivado', () => {
    const antes = notify.calls.length
    const { diagram, skeleton } = tool('diagram_create').handler({
      title: 'Fluxo de auth',
      kind: 'flow',
      summary: 'esboço inicial',
      elements: [
        { id: 'ui', type: 'rectangle', label: { text: 'Web UI' } },
        { id: 'api', type: 'rectangle', label: { text: 'Auth API' } },
        { id: 'e1', type: 'arrow', start: { id: 'ui' }, end: { id: 'api' }, label: { text: 'POST /login' } },
      ],
      links: [{ parentType: 'feature', parentId: 'feat-1' }],
    }).structuredContent as { diagram: DiagramMetaOut; skeleton: SkeletonOut[] }

    expect(diagram.id).toBeTruthy()
    expect(diagram.sourceFormat).toBe('skeleton')
    expect(diagram.version).toBe(1)
    expect(diagram.links).toEqual([
      { diagramId: diagram.id, parentType: 'feature', parentId: 'feat-1' },
    ])
    // Meta sem a cena crua.
    expect(diagram).not.toHaveProperty('scene')

    // Skeleton derivado da cena persistida (roundtrip semântico).
    expect(skeleton.map((s) => s.id).sort()).toEqual(['api', 'e1', 'ui'])
    const arrow = skeleton.find((s) => s.id === 'e1')!
    expect(arrow.start).toEqual({ id: 'ui' })
    expect(arrow.end).toEqual({ id: 'api' })
    expect(arrow.label).toEqual({ text: 'POST /login' })

    const row = getDb()
      .prepare('SELECT source_format, source, version FROM diagrams WHERE id = ?')
      .get(diagram.id) as { source_format: string; source: string; version: number }
    expect(row.source_format).toBe('skeleton')
    expect(JSON.parse(row.source)).toHaveLength(3)

    const broadcast = notify.calls.slice(antes)
    expect(broadcast).toHaveLength(1)
    expect(broadcast[0][0]).toBe('diagram:updated')
    expect((broadcast[0][1] as { id: string }).id).toBe(diagram.id)
  })

  it('diagram_create exige exatamente um de elements|scene (zod refine)', () => {
    expect(() =>
      tool('diagram_create').handler({ title: 'X', summary: 's' }),
    ).toThrow()
    expect(() =>
      tool('diagram_create').handler({
        title: 'X',
        summary: 's',
        elements: [{ id: 'a', type: 'rectangle' }],
        scene: { elements: [] },
      }),
    ).toThrow()
  })

  it('diagram_patch aplica ops sobre a cena vigente e grava snapshot', () => {
    const diagram = novoDiagrama()
    const antes = notify.calls.length

    const { diagram: depois, skeleton } = tool('diagram_patch').handler({
      id: diagram.id,
      summary: 'adiciona o banco',
      ops: [
        { op: 'add', element: { id: 'db', type: 'ellipse', label: { text: 'Sessions DB' } } },
        { op: 'update', id: 'ui', label: { text: 'Frontend' } },
        { op: 'delete', id: 'e1' },
      ],
    }).structuredContent as { diagram: DiagramMetaOut; skeleton: SkeletonOut[] }

    expect(depois.version).toBe(2)
    const ids = skeleton.map((s) => s.id)
    expect(ids).toContain('db')
    expect(ids).not.toContain('e1')
    expect(skeleton.find((s) => s.id === 'ui')?.label).toEqual({ text: 'Frontend' })

    // Snapshot com autor claude e o summary do patch.
    const version = getDb()
      .prepare('SELECT author, summary FROM diagram_versions WHERE diagram_id = ? AND version = 2')
      .get(diagram.id) as { author: string; summary: string }
    expect(version).toEqual({ author: 'claude', summary: 'adiciona o banco' })

    const broadcast = notify.calls.slice(antes)
    expect(broadcast).toHaveLength(1)
    expect(broadcast[0][0]).toBe('diagram:updated')
  })

  it('diagram_delete recusa diagrama ativo (two-step) e apaga após archive', () => {
    const diagram = novoDiagrama('Pra apagar')

    expect(() =>
      tool('diagram_delete').handler({ id: diagram.id, confirm: true }),
    ).toThrow(/archive first \(diagram_archive\), then delete/)
    // Guard também na validação: confirm literal true é obrigatório.
    expect(() => tool('diagram_delete').handler({ id: diagram.id })).toThrow()
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM diagrams WHERE id = ?').get(diagram.id)).toEqual({ n: 1 })

    call('diagram_archive', { id: diagram.id })
    const antes = notify.calls.length
    const out = call<{ id: string; deleted: boolean }>('diagram_delete', {
      id: diagram.id,
      confirm: true,
    })
    expect(out).toEqual({ id: diagram.id, deleted: true })
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM diagrams WHERE id = ?').get(diagram.id)).toEqual({ n: 0 })
    expect(notify.calls.slice(antes)).toEqual([['diagram:deleted', { id: diagram.id }]])
  })

  it('diagram_link/unlink devolvem o conjunto de links e broadcastam', () => {
    const diagram = novoDiagrama('Com vínculos')
    const antes = notify.calls.length

    const linked = call<{ links: unknown[] }>('diagram_link', {
      id: diagram.id,
      parentType: 'task',
      parentId: 'task-9',
    })
    expect(linked.links).toEqual([
      { diagramId: diagram.id, parentType: 'task', parentId: 'task-9' },
    ])
    expect(notify.calls.slice(antes)).toEqual([
      ['diagramLinks:updated', { diagramId: diagram.id, links: linked.links }],
    ])

    const unlinked = call<{ links: unknown[] }>('diagram_unlink', {
      id: diagram.id,
      parentType: 'task',
      parentId: 'task-9',
    })
    expect(unlinked.links).toEqual([])
  })

  it('integração: create (4 nós/3 setas) → get → patch (move + rename) → archive → delete', () => {
    interface SkeletonFull extends SkeletonOut {
      x?: number
      y?: number
      text?: string
    }
    interface VersionMetaOut {
      id: string
      diagramId: string
      version: number
      author: string
      summary: string
      createdAt: number
    }

    const { diagram } = call<{ diagram: DiagramMetaOut; skeleton: SkeletonFull[] }>(
      'diagram_create',
      {
        title: 'Pipeline de ingestão',
        kind: 'architecture',
        summary: 'primeira versão',
        elements: [
          { id: 'src', type: 'rectangle', label: { text: 'Fonte' } },
          { id: 'etl', type: 'rectangle', label: { text: 'ETL' } },
          { id: 'db', type: 'ellipse', label: { text: 'Warehouse' } },
          { id: 'bi', type: 'diamond', label: { text: 'BI' } },
          { id: 'a1', type: 'arrow', start: { id: 'src' }, end: { id: 'etl' } },
          { id: 'a2', type: 'arrow', start: { id: 'etl' }, end: { id: 'db' }, label: { text: 'upsert' } },
          { id: 'a3', type: 'arrow', start: { id: 'db' }, end: { id: 'bi' } },
        ],
      },
    )

    // get (skeleton): meta + skeleton derivado + histórico de versões.
    const got = call<{
      diagram: DiagramMetaOut
      skeleton: SkeletonFull[]
      versions: VersionMetaOut[]
    }>('diagram_get', { id: diagram.id })
    expect(got.diagram.id).toBe(diagram.id)
    expect(got.diagram.version).toBe(1)
    expect(got.skeleton.map((s) => s.id).sort()).toEqual(['a1', 'a2', 'a3', 'bi', 'db', 'etl', 'src'])
    expect(got.skeleton.find((s) => s.id === 'a2')).toMatchObject({
      start: { id: 'etl' },
      end: { id: 'db' },
      label: { text: 'upsert' },
    })
    expect(got.versions).toHaveLength(1)
    expect(got.versions[0]).toMatchObject({
      diagramId: diagram.id,
      version: 1,
      author: 'claude',
      summary: 'primeira versão',
    })

    // patch: move o nó etl + renomeia o label da fonte.
    const patched = call<{ diagram: DiagramMetaOut; skeleton: SkeletonFull[] }>('diagram_patch', {
      id: diagram.id,
      summary: 'move etl e renomeia fonte',
      ops: [
        { op: 'update', id: 'etl', x: 520, y: 340 },
        { op: 'update', id: 'src', label: { text: 'Fonte externa' } },
      ],
    })
    expect(patched.diagram.version).toBe(2)
    expect(patched.skeleton.find((s) => s.id === 'etl')).toMatchObject({ x: 520, y: 340 })
    expect(patched.skeleton.find((s) => s.id === 'src')?.label).toEqual({ text: 'Fonte externa' })
    // Setas continuam vinculadas após o move.
    expect(patched.skeleton.find((s) => s.id === 'a1')).toMatchObject({
      start: { id: 'src' },
      end: { id: 'etl' },
    })

    // get (full): a cena persistida tem os campos que o restoreElements espera.
    const full = call<{ diagram: DiagramMetaOut & { scene: { elements: unknown[] } } }>(
      'diagram_get',
      { id: diagram.id, format: 'full' },
    )
    const elements = full.diagram.scene.elements as Array<Record<string, unknown>>
    expect(elements.length).toBeGreaterThanOrEqual(7)
    const BASE_FIELDS = [
      'id', 'type', 'x', 'y', 'width', 'height', 'angle', 'strokeColor', 'backgroundColor',
      'fillStyle', 'strokeWidth', 'strokeStyle', 'roughness', 'opacity', 'groupIds', 'frameId',
      'roundness', 'seed', 'version', 'versionNonce', 'index', 'isDeleted', 'boundElements',
      'updated', 'link', 'locked',
    ]
    for (const el of elements) {
      for (const field of BASE_FIELDS) expect(el).toHaveProperty(field)
      if (el.type === 'text') {
        for (const field of [
          'fontSize', 'fontFamily', 'text', 'textAlign', 'verticalAlign',
          'containerId', 'originalText', 'autoResize', 'lineHeight',
        ]) expect(el).toHaveProperty(field)
      }
      if (el.type === 'arrow') {
        for (const field of [
          'points', 'lastCommittedPoint', 'startBinding', 'endBinding',
          'startArrowhead', 'endArrowhead', 'elbowed',
        ]) expect(el).toHaveProperty(field)
      }
    }
    const etl = elements.find((el) => el.id === 'etl')!
    expect(etl).toMatchObject({ x: 520, y: 340 })
    // Label bound acompanha o container movido.
    const etlLabel = elements.find((el) => el.id === 'etl__label') as Record<string, unknown>
    expect(etlLabel.containerId).toBe('etl')

    // archive → delete (two-step) apaga diagrama, versões e links.
    const archived = call<{ id: string; status: string }>('diagram_archive', { id: diagram.id })
    expect(archived.status).toBe('archived')
    const deleted = call<{ id: string; deleted: boolean }>('diagram_delete', {
      id: diagram.id,
      confirm: true,
    })
    expect(deleted).toEqual({ id: diagram.id, deleted: true })
    const db = getDb()
    expect(db.prepare('SELECT COUNT(*) AS n FROM diagrams WHERE id = ?').get(diagram.id)).toEqual({ n: 0 })
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM diagram_versions WHERE diagram_id = ?').get(diagram.id),
    ).toEqual({ n: 0 })
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM diagram_links WHERE diagram_id = ?').get(diagram.id),
    ).toEqual({ n: 0 })
  })
})
