/** @vitest-environment node */
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'

// HOME real (temporário): o índice e o transcript são lidos do disco, como em produção.
const { HOME } = vi.hoisted(() => ({
  HOME: `${process.env.TMPDIR ?? '/tmp'}/cm-sendmsg-${process.pid}-${Date.now()}`,
}))

vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }))
vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os')
  return { ...actual, homedir: () => HOME }
})
vi.mock('chokidar', () => ({ default: { watch: () => ({ on: () => {}, close: async () => {} }) } }))
// cc_session_id → sessions.id "s-<cc>"; títulos não importam aqui.
vi.mock('./db', () => ({
  getDb: () => ({
    prepare: () => ({
      all: () => [],
      get: (arg: unknown) => (typeof arg === 'string' ? { id: `s-${arg}`, name: null } : undefined),
    }),
  }),
}))
vi.mock('./notifications', () => ({
  getNotifPrefs: () => ({}),
  getMainWindow: () => null,
  getRendererFocusedSession: () => null,
  notify: () => {},
}))
vi.mock('./usage-monitor', () => ({ notifyUsageConsumption: () => {} }))
vi.mock('./handoff-store', () => ({
  getByChildSession: () => null,
  isActiveCrewChild: () => false,
}))
vi.mock('./task-store', () => ({ affectedObjectiveIds: () => [] }))

import { sessionActivityService } from './session-activity'
import { onSessionLinkPulse } from './session-link-pulse'
import type { SessionLinkPulse } from '../../../shared/types/session-link-pulse'

const FIXTURE = readFileSync(
  join(
    __dirname,
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
// Linha real com `to` = apelido; o carimbo dela é de 2026-09-30 (bem mais de 30s atrás).
const ALIAS_LINE = FIXTURE.split('\n').find((l) => l.includes('otavio-fazer-lia-responder'))!

function writeSession(pid: number, cc: string, name: string, status: string): void {
  mkdirSync(join(HOME, '.claude', 'sessions'), { recursive: true })
  writeFileSync(
    join(HOME, '.claude', 'sessions', `${pid}.json`),
    JSON.stringify({ pid, sessionId: cc, name, status, updatedAt: Date.now() }),
  )
}

describe('SendMessage nativo de mãe sem pane, no meio de um turno longo', () => {
  afterEach(() => sessionActivityService.closeAll())
  afterAll(() => rmSync(HOME, { recursive: true, force: true }))

  it('o JSONL cresce sem o sessions/<pid>.json mudar e o pulso sai mesmo assim', async () => {
    writeSession(process.pid, 'cc-mae', 'mae', 'busy')
    writeSession(process.ppid, 'cc-otavio', 'otavio-fazer-lia-responder', 'idle')
    const dir = join(HOME, '.claude', 'projects', '-repo')
    mkdirSync(dir, { recursive: true })
    const transcript = join(dir, 'cc-mae.jsonl')
    writeFileSync(transcript, '{"type":"user","message":{"content":"oi"}}\n')

    const heard: SessionLinkPulse[] = []
    const off = onSessionLinkPulse((p) => heard.push(p))
    sessionActivityService.watchGlobal()
    // 1ª leitura (snapshot global) estabelece o baseline da mãe.
    await new Promise((r) => setTimeout(r, 50))
    appendFileSync(transcript, `${ALIAS_LINE}\n`)
    await vi.waitFor(
      () =>
        expect(heard).toContainEqual(
          expect.objectContaining({
            fromSessionId: 's-cc-mae',
            toSessionId: 's-cc-otavio',
            kind: 'message',
          }),
        ),
      { timeout: 6_000, interval: 100 },
    )
    off()
  }, 10_000)
})
