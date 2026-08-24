/** @vitest-environment node */
// Unit das tools MCP do proxy de serviços. Electron mockado (app.getPath → tmp)
// pra auditoria real em better-sqlite3; rede stubada via global fetch; env
// injetado por proxyDeps — nenhum valor real de credencial em jogo.
import { rmSync } from 'node:fs'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'mcp-service-tools-test-'))
  return {
    app: { getPath: () => dir, getVersion: () => '0.0.0-test' },
    BrowserWindow: { getAllWindows: () => [] },
    safeStorage: {},
  }
})

import { app } from 'electron'
import { closeDb, getDb } from '../db'
import { clearServiceHealthCache } from '../service-proxy'
import { serviceTools } from './service-tools'
import { buildTools, type McpNotify, type ToolDef } from './tools'

const LITELLM_KEY = 'sk-litellm-teste-secreta-123'
const MOTHER = 'mother-session-1'

const env =
  (vars: Record<string, string>) =>
  (key: string): string | undefined =>
    vars[key]

function tools(vars: Record<string, string>): ToolDef[] {
  return serviceTools({ motherSessionId: MOTHER }, { getEnvVar: env(vars) })
}

function tool(list: ToolDef[], name: string): ToolDef {
  const def = list.find((t) => t.name === name)
  if (!def) throw new Error(`tool not registered: ${name}`)
  return def
}

async function call<T>(list: ToolDef[], name: string, args: unknown): Promise<T> {
  const result = await tool(list, name).handler(args)
  return result.structuredContent as T
}

const validChatParams = {
  model: 'gpt-5',
  messages: [{ role: 'user', content: 'oi' }],
}

interface CallOut {
  ok: boolean
  status: number
  body?: string
  error?: string
}

interface ListOut {
  services: Array<{
    id: string
    configured: boolean
    health: { status: string }
    operations: Array<{
      id: string
      method: string
      env: string
      params: Record<string, unknown>
    }>
  }>
}

beforeEach(() => {
  clearServiceHealthCache()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

afterAll(() => {
  closeDb()
  rmSync(app.getPath('userData'), { recursive: true, force: true })
})

describe('service_list', () => {
  it('descreve serviços, health e operações sem NENHUM valor de env', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 200 })),
    )
    const out = await call<ListOut>(tools({ LITE_LLM_API_KEY: LITELLM_KEY }), 'service_list', {})

    expect(out.services).toHaveLength(6)
    const litellm = out.services.find((s) => s.id === 'litellm')
    expect(litellm).toMatchObject({
      configured: true,
      health: { status: 'ok' },
    })
    const op = litellm?.operations.find((o) => o.id === 'chat_completions')
    expect(op).toMatchObject({ method: 'POST', env: 'staging' })
    expect((op?.params.properties as Record<string, unknown>).model).toBeDefined()

    expect(out.services.find((s) => s.id === 'gemini')).toMatchObject({
      configured: false,
      health: { status: 'unconfigured' },
    })
    expect(JSON.stringify(out)).not.toContain(LITELLM_KEY)
  })
})

describe('service_call', () => {
  it('caminho feliz: retorna o corpo e grava auditoria com o session_id da mãe', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"id":"cmpl-1"}', { status: 200 })),
    )
    const out = await call<CallOut>(tools({ LITE_LLM_API_KEY: LITELLM_KEY }), 'service_call', {
      service: 'litellm',
      operation: 'chat_completions',
      params: validChatParams,
    })

    expect(out).toMatchObject({
      ok: true,
      status: 200,
      body: '{"id":"cmpl-1"}',
    })
    const row = getDb()
      .prepare(
        `SELECT session_id, service, operation, status FROM service_proxy_calls
         WHERE operation = 'chat_completions' ORDER BY ts DESC LIMIT 1`,
      )
      .get() as { session_id: string; service: string; status: string }
    expect(row).toEqual({
      session_id: MOTHER,
      service: 'litellm',
      operation: 'chat_completions',
      status: 'ok',
    })
  })

  it('operação inexistente vira erro sem tocar a rede', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const out = await call<CallOut>(tools({ LITE_LLM_API_KEY: LITELLM_KEY }), 'service_call', {
      service: 'litellm',
      operation: 'nope',
      params: {},
    })

    expect(fetchMock).not.toHaveBeenCalled()
    expect(out.ok).toBe(false)
    expect(out.error).toContain('operação desconhecida')
  })

  it('params fora do schema da operação são recusados antes do fetch', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const out = await call<CallOut>(tools({ LITE_LLM_API_KEY: LITELLM_KEY }), 'service_call', {
      service: 'litellm',
      operation: 'chat_completions',
      params: { ...validChatParams, url: 'https://evil.example' },
    })

    expect(fetchMock).not.toHaveBeenCalled()
    expect(out.ok).toBe(false)
    expect(out.error).toContain('params inválidos')
  })

  it('input inválido da própria tool é rejeitado pelo zod', async () => {
    const list = tools({})
    await expect(tool(list, 'service_call').handler({ service: 123 })).rejects.toThrow()
  })

  it('erro HTTP sai redigido — a credencial nunca aparece, nem na auditoria', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(`invalid key ${LITELLM_KEY}`, { status: 401 })),
    )
    const out = await call<CallOut>(tools({ LITE_LLM_API_KEY: LITELLM_KEY }), 'service_call', {
      service: 'litellm',
      operation: 'chat_completions',
      params: validChatParams,
    })

    expect(out.ok).toBe(false)
    expect(out.error).toContain('HTTP 401')
    expect(out.error).toContain('[REDACTED]')
    expect(out.error).not.toContain(LITELLM_KEY)

    const row = getDb()
      .prepare(
        `SELECT error FROM service_proxy_calls WHERE status = 'error' ORDER BY ts DESC LIMIT 1`,
      )
      .get() as { error: string }
    expect(row.error).not.toContain(LITELLM_KEY)
  })
})

describe('buildTools', () => {
  it('expõe service_list e service_call no conjunto registrado', () => {
    const notify: McpNotify = {
      broadcast: () => {},
      affectedObjectives: () => {},
      affectedObjectivesForFeatureLinks: () => {},
    }
    const names = buildTools(notify, { motherSessionId: MOTHER }).map((t) => t.name)
    expect(names).toContain('service_list')
    expect(names).toContain('service_call')
  })
})
