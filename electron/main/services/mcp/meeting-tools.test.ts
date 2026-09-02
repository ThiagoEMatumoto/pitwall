/** @vitest-environment node */
// Tools MCP de reuniões contra store real (tmpdir). Sem recorder: só as tools
// de leitura são exercitadas aqui — start/stop/nota delegam ao recorder, que
// tem a própria suíte.
import { rmSync } from 'node:fs'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'mcp-meeting-tools-test-'))
  return {
    app: { getPath: () => dir, getVersion: () => '0.0.0-test' },
    BrowserWindow: { getAllWindows: () => [] },
  }
})

import { app } from 'electron'
import { closeDb, getDb } from '../db'
import * as store from '../meetings/meeting-store'
import { buildTools, type McpNotify, type ToolDef, type ToolResult } from './tools'
import type { Meeting, MeetingDetail } from '../../../../shared/types/meetings'
import type { MeetingSearchHit } from '../meetings/meeting-store'

const notify: McpNotify = {
  broadcast: () => {},
  affectedObjectives: () => {},
  affectedObjectivesForFeatureLinks: () => {},
}
let tools: ToolDef[]

function call<T>(name: string, args: unknown): T {
  const def = tools.find((t) => t.name === name)
  if (!def) throw new Error(`tool not registered: ${name}`)
  return (def.handler(args) as ToolResult).structuredContent as T
}

afterAll(() => {
  closeDb()
  rmSync(app.getPath('userData'), { recursive: true, force: true })
})

beforeEach(() => {
  getDb().exec('DELETE FROM meeting_v2_action_items; DELETE FROM meeting_v2_segments; DELETE FROM meetings_v2;')
  tools = buildTools(notify)
})

describe('meeting tools', () => {
  it('registra as 6 tools', () => {
    const names = tools.map((t) => t.name).filter((n) => n.startsWith('meeting_'))
    expect(names.sort()).toEqual(
      ['meeting_get', 'meeting_list', 'meeting_note_append', 'meeting_search', 'meeting_start', 'meeting_stop'].sort(),
    )
  })

  it('meeting_search acha por texto de segmento e devolve trecho', () => {
    const a = store.create({ title: 'Daily' })
    store.appendSegment({ meetingId: a.id, speaker: 'them', text: 'precisamos migrar o banco para o Postgres', startMs: 0, endMs: 1000, chunkIndex: 0 })
    const b = store.create({ title: 'Outra' })
    store.appendSegment({ meetingId: b.id, speaker: 'me', text: 'nada a ver', startMs: 0, endMs: 1000, chunkIndex: 0 })

    const { items } = call<{ items: MeetingSearchHit[] }>('meeting_search', { q: 'POSTGRES' })

    expect(items).toHaveLength(1)
    expect(items[0].meeting.id).toBe(a.id)
    expect(items[0].matchedIn).toBe('transcript')
    expect(items[0].snippet).toContain('Postgres')
  })

  it('meeting_search escapa curingas do LIKE e acha por título/notas', () => {
    const m = store.create({ title: '100% alinhado' })
    store.update({ id: m.id, rawNotes: 'falar com a_equipe' })
    expect(call<{ items: MeetingSearchHit[] }>('meeting_search', { q: '100%' }).items[0].matchedIn).toBe('title')
    expect(call<{ items: MeetingSearchHit[] }>('meeting_search', { q: 'a_equipe' }).items[0].matchedIn).toBe('notes')
    expect(call<{ items: MeetingSearchHit[] }>('meeting_search', { q: 'a%equipe' }).items).toEqual([])
  })

  it('meeting_list e meeting_get (com rawNotes no topo)', () => {
    const m = store.create({ title: 'Sync' })
    store.update({ id: m.id, rawNotes: 'nota' })
    expect(call<{ items: Meeting[] }>('meeting_list', {}).items.map((x) => x.id)).toEqual([m.id])
    const got = call<MeetingDetail & { rawNotes: string }>('meeting_get', { id: m.id })
    expect(got.meeting.id).toBe(m.id)
    expect(got.rawNotes).toBe('nota')
    expect(got.segments).toEqual([])
    expect(() => call('meeting_get', { id: 'nope' })).toThrow(/not found/)
  })
})
