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
  db.exec('DELETE FROM canvas_notes; DELETE FROM mother_pins; DELETE FROM sessions;')
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

describe('session_mother_pin', () => {
  it('marca e desmarca A SESSÃO QUE CHAMOU, pela conversa, e avisa a UI', async () => {
    const out = await call<{ pinnedMother: boolean }>(toolsFor(CALLER), 'session_mother_pin', {
      pinned: true,
    })
    expect(out.pinnedMother).toBe(true)
    const keys = () =>
      (
        getDb().prepare('SELECT cc_session_id FROM mother_pins').all() as Array<{
          cc_session_id: string
        }>
      ).map((r) => r.cc_session_id)
    expect(keys()).toEqual(['cc-x'])
    expect(broadcasts.some(([c]) => c === 'mother-pins:updated')).toBe(true)
    await call(toolsFor(CALLER), 'session_mother_pin', { pinned: false })
    expect(keys()).toEqual([])
  })

  it('sem identidade de sessão recusa', async () => {
    await expect(call(toolsFor(null), 'session_mother_pin', { pinned: true })).rejects.toThrow()
  })
})

describe('session_title_set', () => {
  function autoRow(id: string) {
    return getDb()
      .prepare(
        'SELECT auto_title, auto_title_source, title, title_source FROM sessions WHERE id = ?',
      )
      .get(id)
  }

  it("grava o auto-título 'self' DA SESSÃO QUE CHAMOU, sem tocar no título/endereço", async () => {
    const out = await call<{ sessionId: string; title: string }>(
      toolsFor(CALLER),
      'session_title_set',
      { title: '  Corrige login no Safari  ' },
    )
    expect(out).toEqual({ sessionId: CALLER, title: 'Corrige login no Safari' })
    expect(autoRow(CALLER)).toEqual({
      auto_title: 'Corrige login no Safari',
      auto_title_source: 'self',
      title: null,
      title_source: null,
    })
    expect(broadcasts).toContainEqual(['canvas:updated', { scope: null }])
    expect(broadcasts).toContainEqual([
      'session:auto-titled',
      {
        sessionId: CALLER,
        ccSessionId: 'cc-x',
        autoTitle: 'Corrige login no Safari',
        autoTitleSource: 'self',
      },
    ])
  })

  it("vence o título 'llm' já gravado", async () => {
    getDb()
      .prepare("UPDATE sessions SET auto_title = 'Gerado', auto_title_source = 'llm' WHERE id = ?")
      .run(CALLER)
    await call(toolsFor(CALLER), 'session_title_set', { title: 'Migra checkout' })
    expect(autoRow(CALLER)).toMatchObject({
      auto_title: 'Migra checkout',
      auto_title_source: 'self',
    })
  })

  it('recusa sessão com título manual', async () => {
    getDb()
      .prepare("UPDATE sessions SET title = 'meu nome', title_source = 'manual' WHERE id = ?")
      .run(CALLER)
    await expect(
      call(toolsFor(CALLER), 'session_title_set', { title: 'Corrige login' }),
    ).rejects.toThrow(/renomeada pelo usuário/)
    expect(autoRow(CALLER)).toMatchObject({ auto_title: null })
  })

  it('recusa filha de handoff (já tem apelido)', async () => {
    const db = getDb()
    const MOTHER = '99999999-2222-4333-8444-555555555555'
    db.prepare(
      `INSERT INTO sessions (id, repo_id, cc_session_id, status, started_at) VALUES (?, NULL, 'cc-mae', 'running', 1)`,
    ).run(MOTHER)
    db.prepare(
      `INSERT INTO projects (id, name, color, position, created_at, updated_at) VALUES ('p-t', 'P', NULL, 0, 1, 1)`,
    ).run()
    db.prepare(
      `INSERT INTO repos (id, project_id, label, path, position, created_at) VALUES ('r-t', 'p-t', 'api', '/tmp/r-t', 0, 1)`,
    ).run()
    const { create, markRunning } = await import('../handoff-store')
    const h = create({
      motherSessionId: MOTHER,
      targetRepoId: 'r-t',
      task: 'x',
      composedPrompt: 'x',
    })
    markRunning(h.id, CALLER)
    try {
      await expect(
        call(toolsFor(CALLER), 'session_title_set', { title: 'Corrige login' }),
      ).rejects.toThrow(/filha/)
      expect(autoRow(CALLER)).toMatchObject({ auto_title: null })
    } finally {
      db.exec(
        "DELETE FROM handoff_events; DELETE FROM handoffs; DELETE FROM repos WHERE id = 'r-t'; DELETE FROM projects WHERE id = 'p-t';",
      )
    }
  })

  it('valida 1..48 caracteres', async () => {
    await expect(call(toolsFor(CALLER), 'session_title_set', { title: '   ' })).rejects.toThrow()
    await expect(
      call(toolsFor(CALLER), 'session_title_set', { title: 'x'.repeat(49) }),
    ).rejects.toThrow()
  })

  it('as instructions pedem session_title_set para sessões não-filhas', () => {
    expect(SERVER_INSTRUCTIONS).toMatch(/session_title_set/)
  })
})
