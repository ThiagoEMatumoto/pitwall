import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { applyAllMigrations, scanFixture, seedRepos, seedSession } from './attention-test-harness'
import { projectAttention } from '../../../../shared/attention/project-attention'
import { humanQueue } from '../../../../shared/attention/selectors'
import {
  deriveAttentionReason,
  type LiveStatus,
  type ScreenScan,
} from '../../../../shared/tui/attention-reason'
import type { AttentionItem, AttentionLiveSession } from '../../../../shared/types/attention'

let testDb: Database.Database
vi.mock('../db', () => ({ getDb: () => testDb }))
let transcriptPath: string | null = null
vi.mock('../transcript-path', () => ({ findTranscriptPath: () => transcriptPath }))

import * as store from '../handoff-store'

// Mesmo derivador que o main usa para a tela (handoffAsking fica de fora: a regra
// de retomada é da projeção).
function liveOf(
  sessionId: string,
  status: LiveStatus,
  scan: ScreenScan | null,
): AttentionLiveSession {
  const reason = deriveAttentionReason({ status, scan, handoffAsking: false })
  return {
    sessionId,
    status,
    screenReason: reason === 'handoff-input' ? undefined : reason,
    menuSeq: scan?.menu ? 1 : null,
    lastActivityAt: 1_000,
    featureId: null,
    repoId: 'r1',
  }
}

const T0 = 1_700_000_000_000

// Filha rodando sob a mãe 'm', criada pelo caminho real: create → markRunning.
function runningChild(repo: string, childSid: string) {
  seedSession(testDb, childSid, { repoId: repo })
  const h = store.create({
    targetRepoId: repo,
    motherSessionId: 'm',
    task: `task ${childSid}`,
    composedPrompt: 'p',
  })
  return store.markRunning(h.id, childSid)
}

function project(live: AttentionLiveSession[]): AttentionItem[] {
  return projectAttention({ handoffs: store.list(), transitions: new Map(), live })
}

describe('projectAttention — estado produzido pelo handoffStore real', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(T0)
    testDb = new Database(':memory:')
    testDb.pragma('foreign_keys = ON')
    applyAllMigrations(testDb)
    seedRepos(testDb)
    seedSession(testDb, 'm')
    transcriptPath = null
  })
  afterEach(() => {
    testDb.close()
    vi.useRealTimers()
  })

  it('1) ask sem progress posterior → 1 child_question com o relógio da pergunta', () => {
    const h = runningChild('r1', 'c1')
    vi.setSystemTime(T0 + 1_000)
    store.ask(h.id, 'Qual branch?')
    const asked = store.get(h.id)!
    const items = project([])
    expect(items).toHaveLength(1)
    expect(items[0].kind).toBe('child_question')
    expect(items[0].createdAt).toBe(asked.questionAskedAt)
    expect(items[0].dedupKey).toContain(String(asked.questionAskedAt))
    expect(items[0].severity).toBe('blocking')
    expect(items[0].actions.map((a) => a.kind)).toEqual(['send_message', 'open_session', 'dismiss'])
  })

  it('2) ask e depois progress (relógio avançado) → 0 itens', () => {
    const h = runningChild('r1', 'c1')
    vi.setSystemTime(T0 + 1_000)
    store.ask(h.id, 'Qual branch?')
    vi.setSystemTime(T0 + 2_000)
    store.progress(h.id, 'segui com main')
    expect(store.get(h.id)!.status).toBe('needs_input')
    expect(project([])).toEqual([])
  })

  it('3) waiting com a tela de fim de turno (idle-prompt) → 0 itens', async () => {
    const scan = await scanFixture('idle-prompt')
    expect(project([liveOf('m', 'waiting', scan)])).toEqual([])
  })

  it('4) waiting com menu de permissão → 1 session_menu com respond_menu', async () => {
    const scan = await scanFixture('permission-bash')
    const items = project([liveOf('m', 'waiting', scan)])
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      kind: 'session_menu',
      menuReason: 'permission',
      sessionId: 'm',
    })
    expect(items[0].actions[0]).toEqual({ kind: 'respond_menu', sessionId: 'm', menuSeq: 1 })
  })

  it('5) waiting sem scan → session_menu unrecognized, sem respond_menu', () => {
    const items = project([liveOf('m', 'waiting', null)])
    expect(items).toHaveLength(1)
    expect(items[0].menuReason).toBe('unrecognized')
    expect(items[0].actions.map((a) => a.kind)).toEqual(['open_session'])
  })

  it('6) filha com ask E menu de permissão na tela → 1 item só (session_menu do handoff)', async () => {
    const h = runningChild('r1', 'c1')
    store.ask(h.id, 'Posso apagar?')
    const scan = await scanFixture('permission-bash')
    const items = project([liveOf('c1', 'waiting', scan)])
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ kind: 'session_menu', handoffId: h.id, sessionId: 'c1' })
  })

  it('é determinística: mesmo input → mesmo JSON', async () => {
    const a = runningChild('r1', 'c1')
    store.ask(a.id, 'q')
    const scan = await scanFixture('permission-bash')
    const input = {
      handoffs: store.list(),
      transitions: new Map(),
      live: [liveOf('m', 'waiting', scan), liveOf('c1', 'working', null)],
    }
    expect(JSON.stringify(projectAttention(input))).toBe(JSON.stringify(projectAttention(input)))
  })

  it('ordena blocking antes de action/info e, dentro, pelo relógio', async () => {
    const a = runningChild('r1', 'c1')
    vi.setSystemTime(T0 + 5_000)
    store.ask(a.id, 'q')
    const scan = await scanFixture('permission-bash')
    // lastActivityAt 1_000 < questionAskedAt: o menu vem primeiro.
    const items = project([liveOf('m', 'waiting', scan)])
    expect(items.map((i) => i.kind)).toEqual(['session_menu', 'child_question'])
  })
})

describe('humanQueue', () => {
  beforeEach(() => {
    testDb = new Database(':memory:')
    testDb.pragma('foreign_keys = ON')
    applyAllMigrations(testDb)
    seedRepos(testDb)
    seedSession(testDb, 'm')
  })
  afterEach(() => testDb.close())

  it('11) exclui info por padrão e inclui com includeInfo', () => {
    const h = runningChild('r1', 'c1')
    store.report(h.id, 'feito')
    // Mãe viva: o resultado não lido vira item da mãe (info).
    const items = project([liveOf('m', 'working', null)])
    expect(items.map((i) => [i.kind, i.severity, i.audience])).toEqual([
      ['result_unconsumed', 'info', 'mother'],
    ])
    expect(humanQueue(items)).toEqual([])
    expect(humanQueue(items, { includeInfo: true })).toHaveLength(1)
  })
})
