/** @vitest-environment node */
// Teste de contrato: sobe o server HTTP real numa porta efêmera e fala MCP de
// verdade via o client SDK (initialize / tools/list / tools/call), incluindo um
// write que dispara o notify. Também valida as camadas de guarda (401/403/404)
// e o mcp.json (conteúdo + mode 0600).
import { randomUUID } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { request as httpRequest } from 'node:http'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join: joinPath } = await import('node:path')
  const dir = mkdtempSync(joinPath(tmpdir(), 'mcp-server-test-'))
  return {
    app: { getPath: () => dir, getVersion: () => '0.0.0-test' },
    BrowserWindow: { getAllWindows: () => [] },
  }
})

import { app } from 'electron'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { closeDb, getDb } from '../db'
import { startMcpServer, type McpServerHandle } from './server'
import { setPref } from '../prefs-store'
import type { McpNotify } from './tools'

const TOKEN = 'contract-test-token-0123456789abcdef0123456789abcdef'

const notifyCalls: Array<[string, unknown]> = []
const notify: McpNotify = {
  broadcast: (channel, payload) => notifyCalls.push([channel, payload]),
  affectedObjectives: () => {},
  affectedObjectivesForFeatureLinks: () => {},
}

let handle: McpServerHandle
let configPath: string

beforeAll(async () => {
  getDb()
  configPath = join(app.getPath('userData'), 'mcp.json')
  const started = await startMcpServer({ port: 0, token: TOKEN, notify, configFilePath: configPath })
  if (!started) throw new Error('mcp server failed to start on ephemeral port')
  handle = started
})

afterAll(async () => {
  await handle.close()
  closeDb()
  rmSync(app.getPath('userData'), { recursive: true, force: true })
})

// url = endpoint a usar; default o global (sem carimbo de sessão-mãe).
async function connectedClient(url: string = handle.url): Promise<Client> {
  const client = new Client({ name: 'contract-test', version: '1.0.0' })
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
  })
  await client.connect(transport)
  return client
}

describe('mcp server — contrato', () => {
  it('escreve mcp.json com url/token/pid e mode 0600', () => {
    const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as {
      url: string
      token: string
      pid: number
    }
    expect(parsed.url).toBe(handle.url)
    expect(parsed.token).toBe(TOKEN)
    expect(parsed.pid).toBe(process.pid)
    expect(statSync(configPath).mode & 0o777).toBe(0o600)
  })

  it('escreve mcp-client-config.json no formato mcpServers (--mcp-config) com mode 0600', () => {
    const clientConfigPath = join(app.getPath('userData'), 'mcp-client-config.json')
    const parsed = JSON.parse(readFileSync(clientConfigPath, 'utf8')) as {
      mcpServers: Record<string, { type: string; url: string; headers: Record<string, string> }>
    }
    const server = parsed.mcpServers['claude-manager']
    expect(server.type).toBe('http')
    expect(server.url).toBe(handle.url)
    expect(server.headers.Authorization).toBe(`Bearer ${TOKEN}`)
    expect(statSync(clientConfigPath).mode & 0o777).toBe(0o600)
  })

  it('initialize anuncia as instructions de auto-tracking', async () => {
    const client = await connectedClient()
    try {
      const instructions = client.getInstructions()
      expect(instructions).toBeTruthy()
      expect(instructions).toContain('auto')
      expect(instructions).toContain('task_list')
    } finally {
      await client.close()
    }
  })

  it('initialize + tools/list expõe as tools de objectives/KRs', async () => {
    const client = await connectedClient()
    try {
      const { tools } = await client.listTools()
      const names = tools.map((t) => t.name)
      for (const expected of [
        'objective_list',
        'objective_get',
        'objective_create',
        'objective_update',
        'objective_archive',
        'key_result_create',
        'key_result_update',
      ]) {
        expect(names).toContain(expected)
      }
    } finally {
      await client.close()
    }
  })

  it('tools/call de write cria no DB e dispara o notify', async () => {
    const client = await connectedClient()
    try {
      notifyCalls.length = 0
      const result = await client.callTool({
        name: 'objective_create',
        arguments: { title: 'Criado via MCP', kind: 'okr' },
      })
      expect(result.isError ?? false).toBe(false)
      const structured = result.structuredContent as { objective: { id: string; title: string } }
      expect(structured.objective.title).toBe('Criado via MCP')

      const row = getDb()
        .prepare('SELECT title FROM objectives WHERE id = ?')
        .get(structured.objective.id) as { title: string }
      expect(row.title).toBe('Criado via MCP')

      expect(notifyCalls.length).toBe(1)
      expect(notifyCalls[0][0]).toBe('objective:updated')
    } finally {
      await client.close()
    }
  })

  it('rejeita request sem bearer token (401)', async () => {
    const res = await fetch(handle.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    })
    expect(res.status).toBe(401)
  })

  it('rejeita Host não-local (403) e path desconhecido (404)', async () => {
    const statusFor = (path: string, host: string): Promise<number> =>
      new Promise((resolve, reject) => {
        const req = httpRequest(
          { host: '127.0.0.1', port: handle.port, path, method: 'POST', headers: { Host: host } },
          (res) => {
            res.resume()
            resolve(res.statusCode ?? 0)
          },
        )
        req.on('error', reject)
        req.end()
      })
    expect(await statusFor('/mcp', 'evil.example.com')).toBe(403)
    expect(await statusFor('/outra-rota', '127.0.0.1')).toBe(404)
  })
})

// A identidade da sessão-mãe é carimbada pelo APP no mcp-config da sessão
// (?s=<sessions.id>) e tem que atravessar HTTP → server → ctx → tool → banco.
// requireApproval=true deixa o handoff em pending (sem spawnar filha), o que
// isola exatamente o que se quer provar: o mother_session_id gravado.
describe('mcp server — identidade da sessão-mãe (?s=)', () => {
  const MOTHER = '3f2504e0-4f89-11d3-9a0c-0305e82c3301'

  beforeAll(() => {
    const db = getDb()
    db.prepare(
      'INSERT OR IGNORE INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)',
    ).run('proj-ident', 'Projeto identidade', Date.now(), Date.now())
    db.prepare(
      'INSERT OR IGNORE INTO repos (id, project_id, label, path, role, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run('repo-ident', 'proj-ident', 'ident', '/repos/ident', null, 0, Date.now())
    setPref('handoffs.requireApproval', true)
  })

  afterAll(() => {
    setPref('handoffs.requireApproval', false)
  })

  async function dispatch(url: string): Promise<string> {
    const client = await connectedClient(url)
    try {
      const result = await client.callTool({
        name: 'session_handoff',
        arguments: { targetRepo: 'ident', task: `Tarefa ${randomUUID()}`, force: true },
      })
      return (result.structuredContent as { handoffId: string }).handoffId
    } finally {
      await client.close()
    }
  }

  const motherOf = (handoffId: string): string | null =>
    (
      getDb()
        .prepare('SELECT mother_session_id FROM handoffs WHERE id = ?')
        .get(handoffId) as { mother_session_id: string | null }
    ).mother_session_id

  it('com ?s=<uuid> o handler enxerga o id e o grava em mother_session_id', async () => {
    expect(motherOf(await dispatch(`${handle.url}?s=${MOTHER}`))).toBe(MOTHER)
  })

  it('sem s (config global legada) o handler vê null — comportamento de hoje', async () => {
    expect(motherOf(await dispatch(handle.url))).toBeNull()
  })

  it('s malformado é descartado (null), nunca vira id inventado', async () => {
    expect(motherOf(await dispatch(`${handle.url}?s=nao-e-uuid`))).toBeNull()
  })

  it('a query string NÃO afeta o auth nem o 404 de path', async () => {
    // Sem bearer, com query: continua 401 (o token é checado antes de tudo).
    const unauth = await fetch(`${handle.url}?s=${MOTHER}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    })
    expect(unauth.status).toBe(401)

    // Path errado com query: segue 404 (o pathname é o que decide).
    const notFound = await fetch(`http://127.0.0.1:${handle.port}/outra-rota?s=${MOTHER}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}` },
    })
    expect(notFound.status).toBe(404)
  })
})
