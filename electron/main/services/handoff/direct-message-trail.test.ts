/** @vitest-environment node */
// SendMessage filha→mãe observado no transcript vira child_direct_message. Linha
// JSONL REAL gravada pela CLI 2.1.286 (a mesma do session-activity-send-message),
// passando pelo watcher singleton do app (scanTranscriptForSendMessage) com o DB
// real em tmp e o handoff criado pelos produtores do store.
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'direct-message-trail-test-'))
  return {
    app: { getPath: () => dir, getVersion: () => '0.0.0-test' },
    BrowserWindow: { getAllWindows: () => [] },
  }
})

import { app } from 'electron'
import { closeDb, getDb } from '../db'
import * as handoffStore from '../handoff-store'
import { scanTranscriptForSendMessage, setSendMessageObserver } from '../session-link-pulse'
import { recordChildDirectMessage } from './direct-message-trail'

const FIXTURE = readFileSync(
  join(__dirname, '..', '..', '..', '..', 'shared', 'tui', '__fixtures__', 'claude-2.1.286-send-message.jsonl'),
  'utf8',
)
// `to` = apelido "otavio-fazer-lia-responder", tool_use toolu_01Fyug6k2b6p9nxpnb8gSWYx.
const ALIAS_LINE = FIXTURE.split('\n').find((l) => l.includes('otavio-fazer-lia-responder'))!
const TARGET_ALIAS = 'otavio-fazer-lia-responder'

let n = 0
function seed(opts: { motherIsTarget: boolean }): { childCc: string; handoffId: string } {
  n++
  const db = getDb()
  db.prepare(
    `INSERT OR IGNORE INTO projects (id, name, created_at, updated_at) VALUES ('p1','P1',1,1)`,
  ).run()
  db.prepare(
    `INSERT OR IGNORE INTO repos (id, project_id, label, path, position, created_at) VALUES ('r1','p1','R1','/tmp/r1',0,1)`,
  ).run()
  const insert = db.prepare(
    `INSERT INTO sessions (id, repo_id, cc_session_id, title, status, started_at) VALUES (?, 'r1', ?, ?, 'running', ?)`,
  )
  insert.run(`mother-${n}`, `cc-mother-${n}`, opts.motherIsTarget ? TARGET_ALIAS : `mae-${n}`, Date.now())
  insert.run(`other-${n}`, `cc-other-${n}`, opts.motherIsTarget ? `outra-${n}` : TARGET_ALIAS, Date.now())
  insert.run(`child-${n}`, `cc-child-${n}`, `filha-${n}`, Date.now())
  const h = handoffStore.create({
    targetRepoId: 'r1',
    task: 't',
    composedPrompt: 'p',
    motherSessionId: `mother-${n}`,
  })
  handoffStore.approve(h.id, {})
  handoffStore.markRunning(h.id, `child-${n}`)
  return { childCc: `cc-child-${n}`, handoffId: h.id }
}

function events(handoffId: string): Array<{ event: string; detail: string | null }> {
  return getDb()
    .prepare("SELECT event, detail FROM handoff_events WHERE handoff_id = ? AND event = 'child_direct_message'")
    .all(handoffId) as Array<{ event: string; detail: string | null }>
}

// Sem índice de ~/.claude/sessions: o apelido casa com sessions.title (running).
const NO_INDEX = new Map<string, { pid: number; name: string | null }>()

function observe(childCc: string): void {
  // 1ª leitura sem SendMessage: baseline. A linha real vem depois, como chamada nova.
  scanTranscriptForSendMessage(childCc, '{"type":"user","message":{"content":"oi"}}', NO_INDEX)
  scanTranscriptForSendMessage(childCc, ALIAS_LINE, NO_INDEX)
}

beforeEach(() => {
  setSendMessageObserver(recordChildDirectMessage)
  const db = getDb()
  db.prepare('DELETE FROM handoff_events').run()
  db.prepare('DELETE FROM handoffs').run()
  db.prepare('DELETE FROM sessions').run()
})

afterAll(() => {
  setSendMessageObserver(null)
  closeDb()
  rmSync(app.getPath('userData'), { recursive: true, force: true })
})

describe('recordChildDirectMessage', () => {
  it('filha → mãe grava 1 child_direct_message com o toolUseId; relida não duplica', () => {
    const { childCc, handoffId } = seed({ motherIsTarget: true })
    observe(childCc)
    scanTranscriptForSendMessage(childCc, ALIAS_LINE, NO_INDEX)
    const ev = events(handoffId)
    expect(ev).toHaveLength(1)
    expect(JSON.parse(ev[0].detail!)).toEqual({
      toolUseId: 'toolu_01Fyug6k2b6p9nxpnb8gSWYx',
      chars: '[redigido]'.length,
      preview: '[redigido]',
    })
  })

  it('filha → outra sessão não grava', () => {
    const { childCc, handoffId } = seed({ motherIsTarget: false })
    // toolUseId já visto pelo singleton no caso anterior: usa um id novo.
    const line = ALIAS_LINE.replace('toolu_01Fyug6k2b6p9nxpnb8gSWYx', 'toolu_outro_destino')
    scanTranscriptForSendMessage(childCc, '{"type":"user"}', NO_INDEX)
    scanTranscriptForSendMessage(childCc, line, NO_INDEX)
    expect(events(handoffId)).toEqual([])
  })
})
