/** @vitest-environment node */
// Tools MCP agente↔agente contra o banco real (tmpdir). Quem chama é o ?s=
// carimbado no spawn (McpRequestContext) — nunca um argumento do modelo.
import { rmSync } from 'node:fs'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'mcp-agent-tools-test-'))
  return {
    app: { getPath: () => dir, getVersion: () => '0.0.0-test' },
    BrowserWindow: { getAllWindows: () => [] },
  }
})

import { app } from 'electron'
import { closeDb, getDb } from '../db'
import { AgentBus, setAgentBus } from '../agent-bus'
import { buildTools, type McpNotify, type ToolDef, type ToolResult } from './tools'
import { SERVER_INSTRUCTIONS } from './instructions'
import type { AgentPeer } from '../../../../shared/types/agent-bus'
import type { SendPromptInput } from '../../../../shared/types/send-prompt'

const FRONT = '11111111-2222-4333-8444-000000000001'
const API = '11111111-2222-4333-8444-000000000002'

const notify: McpNotify = {
  broadcast: () => {},
  affectedObjectives: () => {},
  affectedObjectivesForFeatureLinks: () => {},
}

const sent: SendPromptInput[] = []
const peers: AgentPeer[] = [
  {
    sessionId: FRONT,
    alias: 'web-front',
    projectId: 'p1',
    projectName: 'Loja',
    repoId: 'r-front',
    repoLabel: 'front',
    provider: 'claude',
    status: 'working',
    purpose: 'tela de pedidos',
    lastActivityAt: 1,
    startedAt: 1,
    address: null,
  },
  {
    sessionId: API,
    alias: 'api-contrato',
    projectId: 'p2',
    projectName: 'Backend',
    repoId: 'r-api',
    repoLabel: 'api',
    provider: 'claude',
    status: 'idle',
    purpose: 'endpoints de pedidos',
    lastActivityAt: 2,
    startedAt: 2,
    address: null,
  },
]

function toolsFor(motherSessionId: string | null): ToolDef[] {
  return buildTools(notify, { motherSessionId })
}

async function call<T>(caller: string | null, name: string, args: unknown): Promise<T> {
  const def = toolsFor(caller).find((t) => t.name === name)
  if (!def) throw new Error(`tool not registered: ${name}`)
  return ((await def.handler(args)) as ToolResult).structuredContent as T
}

let bus: AgentBus

afterAll(() => {
  bus.dispose()
  setAgentBus(null)
  closeDb()
  rmSync(app.getPath('userData'), { recursive: true, force: true })
})

beforeEach(() => {
  sent.length = 0
  const db = getDb()
  db.exec(
    'DELETE FROM agent_messages; DELETE FROM sessions; DELETE FROM repos; DELETE FROM projects;',
  )
  db.exec(`
    INSERT INTO projects (id, name, created_at, updated_at) VALUES ('p1', 'Loja', 1, 1), ('p2', 'Backend', 1, 1);
    INSERT INTO repos (id, project_id, label, path, position, created_at) VALUES
      ('r-front', 'p1', 'front', '/tmp/front', 0, 1), ('r-api', 'p2', 'api', '/tmp/api', 0, 1),
      ('r-docs', 'p2', 'docs', '/tmp/docs', 1, 1);
  `)
  const ins = db.prepare(
    `INSERT INTO sessions (id, repo_id, cc_session_id, status, started_at) VALUES (?, ?, ?, 'running', 1)`,
  )
  ins.run(FRONT, 'r-front', 'cc-front')
  ins.run(API, 'r-api', 'cc-api')
  bus?.dispose()
  bus = new AgentBus({
    db,
    peers: () => peers,
    send: async (input) => {
      sent.push(input)
      return { ok: true, delivered: true }
    },
    cancel: () => {},
    emit: () => {},
    warn: () => {},
  })
  setAgentBus(bus)
})

describe('agent_* tools', () => {
  it('registra as quatro tools', () => {
    const names = toolsFor(FRONT).map((t) => t.name)
    expect(names).toEqual(
      expect.arrayContaining(['agent_list', 'agent_ask', 'agent_reply', 'agent_check']),
    )
  })

  it('agent_list mostra as outras sessões vivas com alias, projeto, repo e propósito', async () => {
    const res = await call<{ you: { alias: string }; items: Array<Record<string, unknown>> }>(
      FRONT,
      'agent_list',
      {},
    )
    expect(res.you.alias).toBe('web-front')
    expect(res.items).toEqual([
      expect.objectContaining({
        sessionId: API,
        alias: 'api-contrato',
        project: 'Backend',
        repo: 'api',
        provider: 'claude',
        status: 'idle',
        purpose: 'endpoints de pedidos',
      }),
    ])
  })

  it('ask → reply → check: a identidade de cada lado vem do ?s=', async () => {
    const asked = await call<{ askId: string; mode: string; routedTo: { alias: string } }>(
      FRONT,
      'agent_ask',
      { repo: 'api', text: 'como está o contrato de POST /orders?' },
    )
    expect(asked).toMatchObject({ mode: 'delivered', routedTo: { alias: 'api-contrato' } })
    expect(sent[0]).toMatchObject({ sessionId: API, when: 'on-idle' })
    expect(sent[0].text).toContain(`id="${asked.askId}"`)

    await expect(
      call(FRONT, 'agent_reply', { askId: asked.askId, text: 'eu mesma respondo' }),
    ).rejects.toThrow(/destino/)
    await call(API, 'agent_reply', { askId: asked.askId, text: '201 com { id }' })

    const checked = await call<{ status: string; reply: string }>(FRONT, 'agent_check', {
      askId: asked.askId,
    })
    expect(checked).toMatchObject({ status: 'answered', reply: '201 com { id }' })
  })

  it('agent_ask para repo sem sessão viva devolve needs-handoff com a sugestão', async () => {
    const res = await call<{ mode: string; askId: null; suggestion: string }>(FRONT, 'agent_ask', {
      repo: 'docs',
      text: 'cadê o guia?',
    })
    expect(res).toMatchObject({ mode: 'needs-handoff', askId: null })
    expect(res.suggestion).toContain('session_handoff')
  })

  it('sem identidade de sessão as tools recusam (não há "de quem")', async () => {
    await expect(call(null, 'agent_ask', { to: 'api-contrato', text: 'oi' })).rejects.toThrow(
      /sessão aberta pelo Pitwall/,
    )
  })

  it('exige to ou repo, e limita waitSeconds a 60', async () => {
    await expect(call(FRONT, 'agent_ask', { text: 'oi' })).rejects.toThrow()
    await expect(call(FRONT, 'agent_check', { askId: 'x', waitSeconds: 61 })).rejects.toThrow()
  })

  it('as instructions do servidor explicam quando usar agent_list/agent_ask/agent_reply', () => {
    expect(SERVER_INSTRUCTIONS).toContain('agent_ask')
    expect(SERVER_INSTRUCTIONS).toContain('<pitwall-ask')
    expect(SERVER_INSTRUCTIONS).toContain('agent_reply')
    expect(SERVER_INSTRUCTIONS).toContain('SendMessage')
  })
})
