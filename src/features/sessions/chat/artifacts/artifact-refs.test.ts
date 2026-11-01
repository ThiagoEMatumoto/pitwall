/** @vitest-environment node */
// O transcript daqui sai do produtor real: os tool_result são o que as tools
// MCP devolvem (buildTools num better-sqlite3 real) e as mensagens passam pelo
// parser do chat (parseChatMessages). O envelope JSONL segue o formato que a
// CLI grava (tool_use no assistant, tool_result com content string no user).
import { rmSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'chat-artifact-refs-test-'))
  return {
    app: { getPath: () => dir, getVersion: () => '0.0.0-test' },
    BrowserWindow: { getAllWindows: () => [] },
  }
})

vi.mock('../../../../../electron/main/services/design/screenshot', () => ({
  captureArtboard: () => Promise.reject(new Error('BrowserWindow is not a constructor')),
  computeStyles: () => Promise.reject(new Error('BrowserWindow is not a constructor')),
}))

import { app } from 'electron'
import { closeDb } from '../../../../../electron/main/services/db'
import { parseChatMessages } from '../../../../../electron/main/services/chat-transcript'
import {
  buildTools,
  type McpNotify,
  type ToolResult,
} from '../../../../../electron/main/services/mcp/tools'
import type { ChatMessage } from '@shared/types/chat'
import { planArtifacts } from './artifact-refs'

const notify: McpNotify = {
  broadcast: () => {},
  affectedObjectives: () => {},
  affectedObjectivesForFeatureLinks: () => {},
}
const tools = buildTools(notify, { motherSessionId: 's-chat' })

const lines: string[] = []
let seq = 0

async function toolCall(
  name: string,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const def = tools.find((t) => t.name === name)
  if (!def) throw new Error(`tool not registered: ${name}`)
  const result = (await def.handler(input)) as ToolResult
  const id = `toolu_${++seq}`
  lines.push(
    JSON.stringify({
      type: 'assistant',
      message: {
        id: `msg_${seq}`,
        role: 'assistant',
        model: 'claude-opus-5-5',
        content: [{ type: 'tool_use', id, name: `mcp__pitwall__${name}`, input }],
      },
    }),
    JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [{ tool_use_id: id, type: 'tool_result', content: result.content[0].text }],
      },
    }),
  )
  return result.structuredContent
}

function humanSays(text: string): void {
  lines.push(JSON.stringify({ type: 'user', message: { role: 'user', content: text } }))
}

let messages: ChatMessage[]
let diagramId: string
let docId: string

beforeAll(async () => {
  humanSays('desenha a arquitetura')
  const created = await toolCall('diagram_create', {
    title: 'Arquitetura',
    summary: 'v1',
    elements: [{ id: 'api', type: 'rectangle', label: { text: 'API' } }],
  })
  diagramId = (created.diagram as { id: string }).id
  await toolCall('diagram_patch', {
    id: diagramId,
    summary: 'v2',
    ops: [{ op: 'add', element: { id: 'db', type: 'rectangle', label: { text: 'DB' } } }],
  })
  await toolCall('diagram_patch', {
    id: diagramId,
    summary: 'v3',
    ops: [{ op: 'add', element: { id: 'q', type: 'rectangle', label: { text: 'Fila' } } }],
  })
  humanSays('agora as telas')
  const doc = await toolCall('design_document_create', { title: 'Landing' })
  docId = (doc.document as { id: string }).id
  const ab = await toolCall('design_artboard_create', {
    docId,
    name: 'Home',
    width: 1440,
    height: 900,
  })
  const artboardId = (ab.artboard as { id: string }).id
  await toolCall('design_write_html', {
    artboardId,
    mode: 'replace',
    summary: 'hero',
    html: '<section style="display:flex"><h1>Oi</h1></section>',
  })
  await toolCall('design_guide', {})
  messages = parseChatMessages(lines.join('\n'))
})

afterAll(() => {
  closeDb()
  rmSync(app.getPath('userData'), { recursive: true, force: true })
})

describe('planArtifacts — transcript produzido pelas tools reais', () => {
  it('um card por artefato por turno, no tool_use mais recente', () => {
    const plan = planArtifacts(messages)
    const cards = [...plan.cards.entries()].map(([idx, c]) => ({
      name: (messages[idx] as { name: string }).name,
      ...c,
    }))
    expect(cards).toEqual([
      {
        name: 'mcp__pitwall__diagram_patch',
        ref: { kind: 'diagram', id: diagramId },
        title: 'Arquitetura',
        calls: 3,
        lastTool: 'diagram_patch',
      },
      {
        name: 'mcp__pitwall__design_write_html',
        ref: { kind: 'design', id: docId },
        title: 'Landing',
        calls: 3,
        lastTool: 'design_write_html',
      },
    ])
  })

  it('esconde os tool_use fundidos e os tool_result que o card representa', () => {
    const plan = planArtifacts(messages)
    const visible = messages
      .map((m, i) => ({ m, i }))
      .filter(({ i }) => !plan.hidden.has(i) && !plan.cards.has(i))
      .map(({ m }) => (m.kind === 'tool_use' ? m.name : m.kind))
    // design_guide não tem artefato: segue no card genérico, com o resultado.
    expect(visible).toEqual(['user', 'user', 'mcp__pitwall__design_guide', 'tool_result'])
  })

  it('write de artboard criado fora da conversa resolve o doc pelo docId do resultado', () => {
    const lastWrite = messages.findLastIndex(
      (m) => m.kind === 'tool_use' && m.name === 'mcp__pitwall__design_write_html',
    )
    const plan = planArtifacts(messages.slice(lastWrite))
    expect([...plan.cards.values()].map((c) => c.ref)).toEqual([{ kind: 'design', id: docId }])
  })

  it('tool_result com erro continua visível', () => {
    const plan = planArtifacts([
      { kind: 'tool_use', id: 't1', name: 'mcp__pitwall__diagram_patch', input: { id: 'd1' } },
      { kind: 'tool_result', forId: 't1', content: 'diagram não encontrado: d1', isError: true },
    ])
    expect(plan.cards.has(0)).toBe(true)
    expect(plan.hidden.has(1)).toBe(false)
  })
})
