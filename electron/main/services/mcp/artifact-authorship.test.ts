/** @vitest-environment node */
// Autoria de artefatos contra o produtor real: as próprias tools MCP
// (buildTools com o ctx que o server.ts monta a partir do ?s=) e um handoff
// criado pelo handoff-store, num better-sqlite3 real (tmp dir).
import { rmSync } from 'node:fs'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'mcp-artifact-authorship-test-'))
  return {
    app: { getPath: () => dir, getVersion: () => '0.0.0-test' },
    BrowserWindow: { getAllWindows: () => [] },
  }
})

vi.mock('../design/screenshot', () => ({
  captureArtboard: () => Promise.reject(new Error('BrowserWindow is not a constructor')),
  computeStyles: () => Promise.reject(new Error('BrowserWindow is not a constructor')),
}))

import { app } from 'electron'
import { closeDb, getDb } from '../db'
import * as diagramStore from '../diagram-store'
import * as designStore from '../design/design-store'
import * as handoffStore from '../handoff-store'
import { buildTools, type McpNotify, type ToolDef, type ToolResult } from './tools'
import type { DiagramMeta } from '../../../../shared/types/ipc'

const calls: Array<[string, unknown]> = []
const notify: McpNotify = {
  broadcast: (channel, payload) => calls.push([channel, payload]),
  affectedObjectives: () => {},
  affectedObjectivesForFeatureLinks: () => {},
}

function toolsFor(sessionId: string | null): (name: string, args: unknown) => Promise<unknown> {
  const tools: ToolDef[] = buildTools(notify, { motherSessionId: sessionId })
  return async (name, args) => {
    const def = tools.find((t) => t.name === name)
    if (!def) throw new Error(`tool not registered: ${name}`)
    return ((await def.handler(args)) as ToolResult).structuredContent
  }
}

const SKELETON = [{ id: 'a', type: 'rectangle', label: { text: 'A' } }]

function seedSession(id: string): void {
  const db = getDb()
  db.prepare(
    `INSERT OR IGNORE INTO projects (id, name, created_at, updated_at) VALUES ('p1','P1',?,?)`,
  ).run(Date.now(), Date.now())
  db.prepare(
    `INSERT OR IGNORE INTO repos (id, project_id, label, path, position, created_at) VALUES ('r1','p1','R1','/tmp/r1',0,?)`,
  ).run(Date.now())
  db.prepare(
    `INSERT INTO sessions (id, repo_id, cc_session_id, status, started_at) VALUES (?, 'r1', ?, 'running', ?)`,
  ).run(id, `cc-${id}`, Date.now())
}

function seedChildOfHandoff(childId: string): string {
  seedSession(childId)
  const h = handoffStore.create({ targetRepoId: 'r1', task: 't', composedPrompt: 'p' })
  handoffStore.approve(h.id, {})
  handoffStore.markRunning(h.id, childId)
  return h.id
}

const linkPairs = (links: Array<{ parentType: string; parentId: string }>) =>
  links.map((l) => `${l.parentType}:${l.parentId}`).sort()

beforeEach(() => {
  calls.length = 0
  getDb().exec(
    'DELETE FROM diagrams; DELETE FROM design_documents; DELETE FROM handoffs; DELETE FROM sessions;',
  )
})

afterAll(() => {
  closeDb()
  rmSync(app.getPath('userData'), { recursive: true, force: true })
})

describe('artifact authorship — diagrams', () => {
  it('diagram_create de uma sessão carimbada liga o diagrama à sessão', async () => {
    seedSession('s-main')
    const call = toolsFor('s-main')
    const { diagram } = (await call('diagram_create', {
      title: 'Fluxo',
      summary: 'v1',
      elements: SKELETON,
      links: [{ parentType: 'feature', parentId: 'f1' }],
    })) as { diagram: DiagramMeta & { links: Array<{ parentType: string; parentId: string }> } }
    expect(linkPairs(diagramStore.listLinks(diagram.id))).toEqual(['feature:f1', 'session:s-main'])
    // O filtro que os chips da sidebar usam (diagrams:list por parent).
    expect(
      diagramStore.list({ parentType: 'session', parentId: 's-main' }).map((d) => d.id),
    ).toEqual([diagram.id])
  })

  it('filha de handoff liga sessão e handoff', async () => {
    const handoffId = seedChildOfHandoff('s-child')
    const call = toolsFor('s-child')
    const { diagram } = (await call('diagram_create', {
      title: 'Arq',
      summary: 'v1',
      elements: SKELETON,
    })) as { diagram: DiagramMeta }
    expect(linkPairs(diagramStore.listLinks(diagram.id))).toEqual([
      `handoff:${handoffId}`,
      'session:s-child',
    ])
  })

  it('diagram_patch de outra sessão adiciona o link dela uma vez e avisa a UI', async () => {
    seedSession('s-a')
    seedSession('s-b')
    const { diagram } = (await toolsFor('s-a')('diagram_create', {
      title: 'X',
      summary: 'v1',
      elements: SKELETON,
    })) as { diagram: DiagramMeta }
    calls.length = 0
    const patch = toolsFor('s-b')
    const ops = [{ op: 'add', element: { id: 'b', type: 'rectangle', label: { text: 'B' } } }]
    await patch('diagram_patch', { id: diagram.id, summary: 'v2', ops })
    await patch('diagram_patch', {
      id: diagram.id,
      summary: 'v3',
      ops: [{ op: 'delete', id: 'b' }],
    })
    expect(linkPairs(diagramStore.listLinks(diagram.id))).toEqual(['session:s-a', 'session:s-b'])
    expect(calls.filter(([c]) => c === 'diagramLinks:updated')).toHaveLength(1)
  })

  it('sem carimbo (config global legada) não cria link', async () => {
    const { diagram } = (await toolsFor(null)('diagram_create', {
      title: 'Y',
      summary: 'v1',
      elements: SKELETON,
    })) as { diagram: DiagramMeta }
    expect(diagramStore.listLinks(diagram.id)).toEqual([])
  })
})

describe('artifact authorship — design', () => {
  it('design_document_create e design_write_html ligam a sessão autora', async () => {
    const handoffId = seedChildOfHandoff('s-child')
    const call = toolsFor('s-child')
    const { document } = (await call('design_document_create', { title: 'Landing' })) as {
      document: { id: string }
    }
    expect(linkPairs(designStore.listLinks(document.id))).toEqual([
      `handoff:${handoffId}`,
      'session:s-child',
    ])

    seedSession('s-other')
    const other = toolsFor('s-other')
    const { artboard } = (await other('design_artboard_create', {
      docId: document.id,
      name: 'Home',
      width: 1440,
      height: 900,
    })) as { artboard: { id: string } }
    await other('design_write_html', {
      artboardId: artboard.id,
      mode: 'replace',
      html: '<section style="display:flex"><h1>Oi</h1></section>',
      summary: 'hero',
    })
    expect(linkPairs(designStore.listLinks(document.id))).toContain('session:s-other')
    expect(
      designStore.listDocuments({ parentType: 'session', parentId: 's-other' }).map((d) => d.id),
    ).toEqual([document.id])
  })
})
