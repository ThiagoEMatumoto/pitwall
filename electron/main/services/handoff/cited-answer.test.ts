/** @vitest-environment node */
// SendMessage mãe → filha citando um requestId, pelo watcher singleton do app
// (scanTranscriptForSendMessage) com a linha JSONL REAL da CLI 2.1.286, só com o
// texto e o tool_use id trocados. Pedido criado pelo produtor real (handoffStore.ask).
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'cited-answer-test-'))
  return {
    app: { getPath: () => dir, getVersion: () => '0.0.0-test' },
    BrowserWindow: { getAllWindows: () => [] },
  }
})

import { app } from 'electron'
import { closeDb, getDb } from '../db'
import * as handoffStore from '../handoff-store'
import * as requestStore from '../handoff-requests'
import { scanTranscriptForSendMessage, setSendMessageObserver } from '../session-link-pulse'
import { answerCitedRequests } from './cited-answer'

const FIXTURE = readFileSync(
  join(
    __dirname,
    '..',
    '..',
    '..',
    '..',
    'shared',
    'tui',
    '__fixtures__',
    'claude-2.1.286-send-message.jsonl',
  ),
  'utf8',
)
const ALIAS = 'otavio-fazer-lia-responder'
const ALIAS_LINE = FIXTURE.split('\n').find((l) => l.includes(ALIAS))!
const NO_INDEX = new Map<string, { pid: number; name: string | null }>()

let n = 0
function seed(): { motherCc: string; handoffId: string } {
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
  insert.run(`mother-${n}`, `cc-mother-${n}`, `mae-${n}`, Date.now())
  insert.run(`child-${n}`, `cc-child-${n}`, ALIAS, Date.now())
  const h = handoffStore.create({
    targetRepoId: 'r1',
    task: 't',
    composedPrompt: 'p',
    motherSessionId: `mother-${n}`,
  })
  handoffStore.approve(h.id, {})
  handoffStore.markRunning(h.id, `child-${n}`)
  return { motherCc: `cc-mother-${n}`, handoffId: h.id }
}

// A mãe manda a SendMessage: baseline sem chamada, depois a chamada nova.
function motherSends(motherCc: string, message: string): void {
  const line = JSON.parse(ALIAS_LINE)
  const call = line.message.content[0]
  call.id = `toolu_cited_${n}`
  call.input.message = message
  scanTranscriptForSendMessage(motherCc, '{"type":"user","message":{"content":"oi"}}', NO_INDEX)
  scanTranscriptForSendMessage(motherCc, JSON.stringify(line), NO_INDEX)
}

beforeEach(() => {
  setSendMessageObserver((e) => void answerCitedRequests(e))
  const db = getDb()
  for (const t of ['handoff_requests', 'handoff_events', 'handoffs', 'sessions'])
    db.prepare(`DELETE FROM ${t}`).run()
})

afterAll(() => {
  setSendMessageObserver(null)
  closeDb()
  rmSync(app.getPath('userData'), { recursive: true, force: true })
})

describe('answerCitedRequests', () => {
  it('SendMessage da mãe citando o requestId fecha o pedido e tira da fila', () => {
    const { motherCc, handoffId } = seed()
    const { request } = handoffStore.ask(handoffId, 'qual branch?', `child-${n}`)
    expect(handoffStore.get(handoffId)!.status).toBe('needs_input')

    motherSends(motherCc, `Sobre ${request!.id}: use a main.`)

    expect(requestStore.get(request!.id)).toMatchObject({
      status: 'answered',
      answeredBy: 'mother',
      answer: `Sobre ${request!.id}: use a main.`,
    })
    expect(requestStore.listOpen()).toEqual([])
    expect(handoffStore.get(handoffId)!.status).toBe('running')
  })

  it('human_only citado não fecha', () => {
    const { motherCc, handoffId } = seed()
    const { request } = handoffStore.ask(
      handoffId,
      { question: 'deploy?', risk: 'deploy_infra_spend' },
      `child-${n}`,
    )
    motherSends(motherCc, `${request!.id}: pode`)
    expect(requestStore.get(request!.id)!.status).toBe('open')
    expect(handoffStore.get(handoffId)!.status).toBe('needs_input')
  })

  it('mensagem sem requestId não resolve nada', () => {
    const { motherCc, handoffId } = seed()
    const { request } = handoffStore.ask(handoffId, 'q', `child-${n}`)
    motherSends(motherCc, 'segue o plano')
    expect(requestStore.get(request!.id)!.status).toBe('open')
  })
})
