/** @vitest-environment node */
// O humano fala com a filha pelo canal da mãe (card, peek, mapa, Room): o pulso
// mãe→filha sai dizendo que foi ele. Store e banco REAIS (SQLite in-memory
// migrado); os dublês são a escrita no PTY e a entrega da resposta.
import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Handoff } from '../../../shared/types/ipc'
import type { SessionLinkPulse } from '../../../shared/types/session-link-pulse'
import { migrations } from '../services/migrations/index'

const handlers = new Map<string, (e: unknown, ...args: unknown[]) => unknown>()
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/cm-test-userdata' },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: {
    handle: (channel: string, cb: (e: unknown, ...args: unknown[]) => unknown) => {
      handlers.set(channel, cb)
    },
  },
}))

let testDb: Database.Database
vi.mock('../services/db', () => ({ getDb: () => testDb }))
vi.mock('../services/transcript-path', () => ({ findTranscriptPath: () => null }))
vi.mock('../services/notify', () => ({ broadcast: () => {} }))
vi.mock('../services/pty-manager', () => ({
  ptyManager: { isRunning: () => true, kill: () => {} },
}))
vi.mock('../services/handoff/guarded-inject', () => ({
  injectIntoChildGuarded: async () => {},
}))
vi.mock('../services/handoff/answer-delivery', () => ({ deliverAnswer: async () => {} }))

const store = await import('../services/handoff-store')
const requestStore = await import('../services/handoff-requests')
const { onSessionLinkPulse } = await import('../services/session-link-pulse')
const { registerHandoffsIpc } = await import('./handoffs')
registerHandoffsIpc()

function runningChild(mother: string, child: string): Handoff {
  const h = store.create({
    targetRepoId: 'r1',
    task: 'do thing',
    composedPrompt: 'prompt',
    motherSessionId: mother,
  })
  return store.markRunning(h.id, child)
}

async function heardDuring(run: () => unknown): Promise<SessionLinkPulse[]> {
  const heard: SessionLinkPulse[] = []
  const off = onSessionLinkPulse((p) => heard.push(p))
  try {
    await run()
  } finally {
    off()
  }
  return heard
}

beforeEach(() => {
  testDb = new Database(':memory:')
  testDb.pragma('foreign_keys = ON')
  for (const m of migrations) {
    if (!m.disableForeignKeys) {
      m.up(testDb)
      continue
    }
    testDb.pragma('foreign_keys = OFF')
    try {
      m.up(testDb)
    } finally {
      testDb.pragma('foreign_keys = ON')
    }
  }
  const now = Date.now()
  testDb
    .prepare(`INSERT INTO projects (id, name, created_at, updated_at) VALUES ('p1','P1',?,?)`)
    .run(now, now)
  testDb
    .prepare(
      `INSERT INTO repos (id, project_id, label, path, position, created_at) VALUES ('r1','p1','R1','/tmp/r1',0,?)`,
    )
    .run(now)
})

describe('pulso do humano pelo canal do handoff', () => {
  it('handoffs:send-message: o pulso mãe→filha diz que foi o usuário', async () => {
    const h = runningChild('mae-a', 'filha-a')

    const heard = await heardDuring(() =>
      handlers.get('handoffs:send-message')!(null, { id: h.id, text: 'segue assim' }),
    )

    expect(heard).toMatchObject([
      { fromSessionId: 'mae-a', toSessionId: 'filha-a', kind: 'message', by: 'human' },
    ])
  })

  it('handoffs:answer-request: a resposta da Room também sai como do usuário', async () => {
    const h = runningChild('mae-b', 'filha-b')
    const { request } = requestStore.createRequest(h.id, { question: 'qual branch?' }, 'filha-b')

    const heard = await heardDuring(() =>
      handlers.get('handoffs:answer-request')!(null, { requestId: request.id, text: 'main' }),
    )

    expect(heard).toMatchObject([
      { fromSessionId: 'mae-b', toSessionId: 'filha-b', kind: 'answer', by: 'human' },
    ])
  })
})
