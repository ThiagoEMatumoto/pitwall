/** @vitest-environment node */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'

// HOME próprio com um índice e um transcript de verdade: o batch do teste sai do
// produtor (sessionActivityService), não de um literal escrito à mão.
const { home } = await vi.hoisted(async () => {
  const fs = await import('node:fs')
  const os = await vi.importActual<typeof import('node:os')>('node:os')
  const path = await import('node:path')
  return { home: fs.mkdtempSync(path.join(os.tmpdir(), 'cm-live-activity-merge-')) }
})

vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }))
vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os')
  return { ...actual, homedir: () => home }
})
vi.mock('chokidar', () => ({ default: { watch: () => ({ on: () => {}, close: async () => {} }) } }))
vi.mock('../electron/main/services/db', () => ({
  getDb: () => ({ prepare: () => ({ all: () => [], get: () => undefined }) }),
}))
vi.mock('../electron/main/services/notifications', () => ({
  getNotifPrefs: () => ({}),
  getMainWindow: () => null,
  getRendererFocusedSession: () => null,
  notify: () => {},
}))
vi.mock('../electron/main/services/usage-monitor', () => ({ notifyUsageConsumption: () => {} }))
vi.mock('../electron/main/services/handoff-store', () => ({
  getByChildSession: () => null,
  isActiveCrewChild: () => false,
}))
vi.mock('../electron/main/services/task-store', () => ({ affectedObjectiveIds: () => [] }))

import { onBroadcast } from '../electron/main/services/notify'
import { sessionActivityService } from '../electron/main/services/session-activity'
import { mergeGlobalActivity } from './live-activity-merge'
import type { GlobalActivityBatch, LiveSessionInfo } from './types/ipc'

const SESSIONS = join(home, '.claude', 'sessions')
const PROJECT = join(home, '.claude', 'projects', 'proj')
mkdirSync(SESSIONS, { recursive: true })
mkdirSync(PROJECT, { recursive: true })

// pid deste processo: vivo, então o status sai do arquivo e não vira 'ended'.
function writeSession(ccSessionId: string, status: 'busy' | 'idle'): void {
  writeFileSync(
    join(SESSIONS, `${ccSessionId}.json`),
    JSON.stringify({ pid: process.pid, sessionId: ccSessionId, status, updatedAt: 1_000 }),
  )
}

function writeTranscript(ccSessionId: string, text: string): void {
  const line = {
    type: 'assistant',
    message: {
      content: [{ type: 'text', text }],
      usage: { output_tokens: 12, input_tokens: 30, cache_read_input_tokens: 70 },
    },
  }
  writeFileSync(join(PROJECT, `${ccSessionId}.jsonl`), `${JSON.stringify(line)}\n`)
}

// Um batch do produtor real, clonado como o IPC entrega ao renderer.
async function produceBatch(): Promise<GlobalActivityBatch> {
  const heard: GlobalActivityBatch[] = []
  const off = onBroadcast('session:activity:global', (_c, payload) =>
    heard.push(payload as GlobalActivityBatch),
  )
  sessionActivityService.watchGlobal()
  await vi.waitFor(() => expect(heard).toHaveLength(1))
  off()
  sessionActivityService.unwatchGlobal()
  return structuredClone(heard[0])
}

function seed(ccSessionId: string): LiveSessionInfo {
  return {
    id: `row-${ccSessionId}`,
    ccSessionId,
    name: null,
    title: null,
    status: 'starting',
    repo: null,
    projectName: null,
    projectIcon: null,
    projectColor: null,
    lastActivityAt: null,
    lastText: null,
  }
}

const WITH_TRANSCRIPT = 'cc-with-transcript'
const NO_TRANSCRIPT = 'cc-no-transcript'
const PTY_ONLY = 'pty-only'
const UNTOUCHED = 'cc-outside-the-batch'

// Estado depois do primeiro batch: os campos de atividade já são os do produtor.
async function settled(): Promise<LiveSessionInfo[]> {
  writeSession(WITH_TRANSCRIPT, 'busy')
  writeSession(NO_TRANSCRIPT, 'idle')
  writeTranscript(WITH_TRANSCRIPT, 'primeira resposta')
  sessionActivityService.trackPty(PTY_ONLY)
  const seeds = [WITH_TRANSCRIPT, NO_TRANSCRIPT, PTY_ONLY, UNTOUCHED].map(seed)
  return mergeGlobalActivity(seeds, await produceBatch())
}

const byCc = (list: LiveSessionInfo[], ccSessionId: string): LiveSessionInfo =>
  list.find((s) => s.ccSessionId === ccSessionId)!

describe('mergeGlobalActivity', () => {
  afterEach(() => {
    sessionActivityService.closeAll()
    rmSync(SESSIONS, { recursive: true, force: true })
    rmSync(PROJECT, { recursive: true, force: true })
    mkdirSync(SESSIONS, { recursive: true })
    mkdirSync(PROJECT, { recursive: true })
  })
  afterAll(() => rmSync(home, { recursive: true, force: true }))

  it('aplica os campos de atividade do batch do produtor', async () => {
    const list = await settled()

    expect(byCc(list, WITH_TRANSCRIPT)).toMatchObject({
      status: 'working',
      lastActivityAt: 1_000,
      lastText: 'primeira resposta',
      tokens: { output: 12, context: 100 },
    })
    expect(byCc(list, NO_TRANSCRIPT)).toMatchObject({ status: 'idle', lastText: null })
    expect(byCc(list, PTY_ONLY).status).toBe('ended')
    expect(byCc(list, UNTOUCHED)).toEqual(seed(UNTOUCHED))
  })

  it('batch idêntico devolve o mesmo array e os mesmos objetos', async () => {
    const list = await settled()

    const again = mergeGlobalActivity(list, await produceBatch())

    expect(again).toBe(list)
    again.forEach((sess, i) => expect(sess).toBe(list[i]))
  })

  it('um status mudado troca só aquele objeto', async () => {
    const list = await settled()
    writeSession(NO_TRANSCRIPT, 'busy')

    const next = mergeGlobalActivity(list, await produceBatch())

    expect(next).not.toBe(list)
    expect(byCc(next, NO_TRANSCRIPT)).not.toBe(byCc(list, NO_TRANSCRIPT))
    expect(byCc(next, NO_TRANSCRIPT).status).toBe('working')
    for (const cc of [WITH_TRANSCRIPT, PTY_ONLY, UNTOUCHED]) {
      expect(byCc(next, cc)).toBe(byCc(list, cc))
    }
  })

  it('um texto novo no transcript troca só aquele objeto', async () => {
    const list = await settled()
    writeTranscript(WITH_TRANSCRIPT, 'segunda resposta')

    const next = mergeGlobalActivity(list, await produceBatch())

    expect(byCc(next, WITH_TRANSCRIPT).lastText).toBe('segunda resposta')
    for (const cc of [NO_TRANSCRIPT, PTY_ONLY, UNTOUCHED]) {
      expect(byCc(next, cc)).toBe(byCc(list, cc))
    }
  })

  // A entrada de PTY sem índice nativo não traz lastText nem tokens no batch.
  it('lastText indefinido e tokens ausente herdam o valor anterior', async () => {
    const list = (await settled()).map((sess) =>
      sess.ccSessionId === PTY_ONLY
        ? { ...sess, lastText: 'texto do snapshot', tokens: { output: 5, context: 9 } }
        : sess,
    )
    const batch = await produceBatch()
    const ptyEntry = batch.find((b) => b.ccSessionId === PTY_ONLY)!
    expect(ptyEntry.lastText).toBeUndefined()
    expect(ptyEntry.tokens).toBeUndefined()

    const next = mergeGlobalActivity(list, batch)

    expect(next).toBe(list)
    expect(byCc(next, PTY_ONLY)).toMatchObject({
      lastText: 'texto do snapshot',
      tokens: { output: 5, context: 9 },
    })
  })

  // Sessão indexada sem transcript manda lastText null explícito: isso limpa.
  it('lastText null no batch substitui o valor anterior', async () => {
    const list = (await settled()).map((sess) =>
      sess.ccSessionId === NO_TRANSCRIPT ? { ...sess, lastText: 'texto velho' } : sess,
    )

    const next = mergeGlobalActivity(list, await produceBatch())

    expect(byCc(next, NO_TRANSCRIPT).lastText).toBeNull()
  })

  it('attentionReason substitui: ausente no batch limpa o motivo', async () => {
    const list = await settled()
    const batch = await produceBatch()
    const asking = batch.map((b) =>
      b.ccSessionId === WITH_TRANSCRIPT ? { ...b, attentionReason: 'permission' as const } : b,
    )

    const withReason = mergeGlobalActivity(list, asking)
    expect(byCc(withReason, WITH_TRANSCRIPT).attentionReason).toBe('permission')
    expect(mergeGlobalActivity(withReason, structuredClone(asking))).toBe(withReason)

    const cleared = mergeGlobalActivity(withReason, batch)
    expect(byCc(cleared, WITH_TRANSCRIPT)).not.toBe(byCc(withReason, WITH_TRANSCRIPT))
    expect(byCc(cleared, WITH_TRANSCRIPT).attentionReason).toBeUndefined()
  })

  it('ignora ids do batch que não estão na lista', async () => {
    const list = (await settled()).filter((s) => s.ccSessionId !== NO_TRANSCRIPT)

    const next = mergeGlobalActivity(list, await produceBatch())

    expect(next).toBe(list)
    expect(next.map((s) => s.ccSessionId)).toEqual([WITH_TRANSCRIPT, PTY_ONLY, UNTOUCHED])
  })
})
