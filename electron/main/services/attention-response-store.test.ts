import Database from 'better-sqlite3'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { migrations } from './migrations/index'

let testDb: Database.Database
vi.mock('./db', () => ({ getDb: () => testDb }))

import { attentionResponseStats, recordAttentionResponse } from './attention-response-store'
import { TuiMenuWatch, type AttentionRespondedEvent } from './tui-menu-watch'

const PERMISSION = readFileSync(
  join(__dirname, '..', '..', '..', 'shared', 'tui', '__fixtures__', 'claude-2.1.286-permission-bash.ansi'),
  'utf8',
)

class FakePty extends EventEmitter {
  write(): void {}
}

// O evento vem do produtor real (espelho headless + captura do 2.1.286), não de
// um menu montado à mão.
async function realResponse(optionIndex: number): Promise<AttentionRespondedEvent> {
  const pty = new FakePty()
  const watch = new TuiMenuWatch()
  watch.attach(pty)
  pty.emit('spawn', { sessionId: 's1', cols: 80, rows: 24 })
  pty.emit('data', { sessionId: 's1', data: PERMISSION })
  const snap = await watch.snapshot('s1')
  const got = new Promise<AttentionRespondedEvent>((r) => watch.once('responded', r))
  await watch.respond({
    sessionId: 's1',
    fingerprint: snap!.fingerprint,
    menuSeq: snap!.menuSeq,
    action: { kind: 'select', optionIndex },
  })
  return got
}

describe('attention-response-store', () => {
  beforeEach(() => {
    testDb = new Database(':memory:')
    for (const m of migrations) m.up(testDb)
  })
  afterEach(() => testDb.close())

  it('grava a resposta real com tool, comando resumido, escolha e espera', async () => {
    const ev = await realResponse(1)
    recordAttentionResponse({
      sessionId: ev.sessionId,
      handoffId: 'h1',
      menu: ev.menu,
      action: ev.action,
      waitedMs: 1234,
      at: 1000,
    })
    expect(testDb.prepare('SELECT * FROM attention_responses').get()).toMatchObject({
      session_id: 's1',
      handoff_id: 'h1',
      menu_kind: 'permission',
      tool: 'Bash',
      command_summary: 'Bash: touch permissao-fixture.txt',
      choice: 'always',
      waited_ms: 1234,
      created_at: 1000,
    })
  })

  it('stats: contagem e mediana na janela, separando filhas', async () => {
    const ev = await realResponse(0)
    const now = 10 * 86_400_000
    const rec = (handoffId: string | null, waitedMs: number | null, at = now) =>
      recordAttentionResponse({ sessionId: 's1', handoffId, menu: ev.menu, action: ev.action, waitedMs, at })
    rec('h1', 1000)
    rec('h1', 3000)
    rec(null, 9000)
    rec(null, null)
    rec('h1', 50, now - 8 * 86_400_000) // fora da janela
    expect(attentionResponseStats(now)).toEqual({
      windowDays: 7,
      count: 4,
      crewCount: 2,
      medianWaitMs: 3000,
      crewMedianWaitMs: 2000,
      byChoice: { approve: 4 },
    })
  })
})
