/** @vitest-environment node */
// Tools MCP do mapa de sessões contra o banco real (tmpdir). A identidade de quem
// chama vem do ?s= carimbado no spawn (McpRequestContext) — nunca de um argumento.
import { rmSync } from 'node:fs'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'mcp-canvas-tools-test-'))
  return {
    app: { getPath: () => dir, getVersion: () => '0.0.0-test' },
    BrowserWindow: { getAllWindows: () => [] },
  }
})

import { app } from 'electron'
import { closeDb, getDb } from '../db'
import { buildTools, type McpNotify, type ToolDef, type ToolResult } from './tools'
import { SERVER_INSTRUCTIONS } from './instructions'

const CALLER = '11111111-2222-4333-8444-555555555555'
const broadcasts: Array<[string, unknown]> = []
const notify: McpNotify = {
  broadcast: (channel, payload) => broadcasts.push([channel, payload]),
  affectedObjectives: () => {},
  affectedObjectivesForFeatureLinks: () => {},
}

function toolsFor(motherSessionId: string | null): ToolDef[] {
  return buildTools(notify, { motherSessionId })
}

async function call<T>(tools: ToolDef[], name: string, args: unknown): Promise<T> {
  const def = tools.find((t) => t.name === name)
  if (!def) throw new Error(`tool not registered: ${name}`)
  return ((await def.handler(args)) as ToolResult).structuredContent as T
}

function sessionRow(id: string) {
  return getDb().prepare('SELECT purpose FROM sessions WHERE id = ?').get(id) as {
    purpose: string | null
  }
}

afterAll(() => {
  closeDb()
  rmSync(app.getPath('userData'), { recursive: true, force: true })
})

beforeEach(() => {
  broadcasts.length = 0
  const db = getDb()
  db.exec('DELETE FROM canvas_notes; DELETE FROM sessions;')
  db.prepare(
    `INSERT INTO sessions (id, repo_id, cc_session_id, status, started_at) VALUES (?, NULL, 'cc-x', 'running', 1)`,
  ).run(CALLER)
})

describe('canvas tools (MCP)', () => {
  it('session_purpose_set grava o propósito DA SESSÃO QUE CHAMOU e avisa a UI', async () => {
    const out = await call<{ sessionId: string; purpose: string }>(
      toolsFor(CALLER),
      'session_purpose_set',
      { purpose: 'Migrar o checkout para o novo gateway' },
    )
    expect(out).toEqual({ sessionId: CALLER, purpose: 'Migrar o checkout para o novo gateway' })
    expect(sessionRow(CALLER).purpose).toBe('Migrar o checkout para o novo gateway')
    expect(broadcasts).toContainEqual(['canvas:updated', { scope: null }])
  })

  it('sem identidade carimbada (config global) recusa em vez de adivinhar a sessão', async () => {
    await expect(
      call(toolsFor(null), 'session_purpose_set', { purpose: 'qualquer' }),
    ).rejects.toThrow(/sessão aberta pelo Pitwall/)
  })

  it('canvas_note_create com attachToSelf prende a nota na sessão que chamou', async () => {
    const out = await call<{
      note: { attachedSessionId: string | null; bodyMd: string; scope: string }
    }>(toolsFor(CALLER), 'canvas_note_create', { body: '- api expõe /health', attachToSelf: true })
    expect(out.note).toMatchObject({
      attachedSessionId: CALLER,
      bodyMd: '- api expõe /health',
      scope: 'all',
    })
  })

  it('canvas_note_create sem attachToSelf cria nota solta; attachToSelf sem identidade falha', async () => {
    const loose = await call<{ note: { attachedSessionId: string | null } }>(
      toolsFor(null),
      'canvas_note_create',
      { body: 'nota solta' },
    )
    expect(loose.note.attachedSessionId).toBeNull()
    await expect(
      call(toolsFor(null), 'canvas_note_create', { body: 'x', attachToSelf: true }),
    ).rejects.toThrow(/sessão aberta pelo Pitwall/)
  })

  it('as instructions do servidor pedem que a sessão declare o propósito', () => {
    expect(SERVER_INSTRUCTIONS).toMatch(/session_purpose_set/)
  })
})
