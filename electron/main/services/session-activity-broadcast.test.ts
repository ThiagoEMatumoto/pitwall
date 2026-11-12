/** @vitest-environment node */
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// HOME próprio com índice e transcript de verdade: o batch sai do produtor real.
// A sonda fica ligada porque é ela que prova que um tick rodou sem transmitir.
const { HOME, dirHandlers } = await vi.hoisted(async () => {
  const fs = await import('node:fs')
  const os = await vi.importActual<typeof import('node:os')>('node:os')
  const path = await import('node:path')
  vi.stubEnv('CM_PERF', '1')
  return {
    HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'cm-activity-broadcast-')),
    dirHandlers: [] as Array<() => void>,
  }
})

vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }))
vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os')
  return { ...actual, homedir: () => HOME }
})
// No modo global o único watcher é o de ~/.claude/sessions: o handler capturado
// é o "o índice mudou" que o chokidar entregaria.
vi.mock('chokidar', () => ({
  default: {
    watch: () => ({
      on: (_event: string, handler: () => void) => void dirHandlers.push(handler),
      close: async () => {},
    }),
  },
}))
vi.mock('./db', () => ({
  getDb: () => ({ prepare: () => ({ all: () => [], get: () => undefined }) }),
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

import { onBroadcast } from './notify'
import { drainPerfWindow } from './perf-probe'
import { sessionActivityService } from './session-activity'
import { tuiMenuWatch } from './tui-menu-watch'
import type { GlobalActivityBatch } from '../../../shared/types/ipc'

const SESSIONS = join(HOME, '.claude', 'sessions')
const PROJECT = join(HOME, '.claude', 'projects', 'proj')
const A = 'cc-a'
const B = 'cc-b'
const C = 'cc-c'

// pid deste processo: vivo, então o status sai do arquivo e não vira 'ended'.
function writeSession(ccSessionId: string, status: 'busy' | 'idle'): void {
  writeFileSync(
    join(SESSIONS, `${ccSessionId}.json`),
    JSON.stringify({ pid: process.pid, sessionId: ccSessionId, status, updatedAt: 1_000 }),
  )
}

function appendTranscript(ccSessionId: string, text: string): void {
  const line = {
    type: 'assistant',
    message: {
      content: [{ type: 'text', text }],
      usage: { output_tokens: 12, input_tokens: 30, cache_read_input_tokens: 70 },
    },
  }
  appendFileSync(join(PROJECT, `${ccSessionId}.jsonl`), `${JSON.stringify(line)}\n`)
}

const ids = (batch: GlobalActivityBatch): string[] => batch.map((b) => b.ccSessionId).sort()
const item = (batch: GlobalActivityBatch, ccSessionId: string) =>
  batch.find((b) => b.ccSessionId === ccSessionId)

describe('sessionActivityService — batch global', () => {
  let heard: GlobalActivityBatch[] = []
  let off: () => void = () => {}
  let seen = { ticks: 0, skipped: 0, tailReads: 0 }

  function drain(): void {
    const window = drainPerfWindow(1)
    seen = {
      ticks: seen.ticks + (window.spans.broadcastGlobal?.n ?? 0),
      skipped: seen.skipped + (window.counters['broadcastGlobal.skipped'] ?? 0),
      tailReads: seen.tailReads + (window.counters['broadcastGlobal.tailReads'] ?? 0),
    }
  }

  // Espera o batch disparado por `trigger` terminar, tenha ele saído ou não.
  async function tick(trigger: () => void): Promise<void> {
    drain()
    const before = seen.ticks
    trigger()
    await vi.waitFor(
      () => {
        drain()
        expect(seen.ticks).toBe(before + 1)
      },
      { timeout: 3_000, interval: 20 },
    )
  }

  const start = (): void => sessionActivityService.watchGlobal()
  const menuChanged = (): boolean => tuiMenuWatch.emit('change', 'pty-1')
  const indexChanged = (): void => dirHandlers.at(-1)!()

  beforeEach(() => {
    rmSync(join(HOME, '.claude'), { recursive: true, force: true })
    mkdirSync(SESSIONS, { recursive: true })
    mkdirSync(PROJECT, { recursive: true })
    dirHandlers.length = 0
    drainPerfWindow(1)
    seen = { ticks: 0, skipped: 0, tailReads: 0 }
    heard = []
    off = onBroadcast('session:activity:global', (_c, payload) =>
      heard.push(structuredClone(payload as GlobalActivityBatch)),
    )
  })
  afterEach(() => {
    off()
    sessionActivityService.closeAll()
    vi.restoreAllMocks()
  })
  afterAll(() => {
    vi.unstubAllEnvs()
    rmSync(HOME, { recursive: true, force: true })
  })

  // O grafo de sessões escuta pelo onBroadcast do notify: um broadcast local
  // (webContents.send direto) chegaria só no renderer.
  it('passa pelos ouvintes do main', async () => {
    await tick(start)
    expect(heard).toEqual([[]])
  })

  it('tick sem mudança não transmite nem relê o transcript', async () => {
    writeSession(A, 'busy')
    writeSession(B, 'idle')
    appendTranscript(A, 'primeira resposta')
    await tick(start)
    expect(heard).toHaveLength(1)
    expect(item(heard[0], A)).toMatchObject({ status: 'working', lastText: 'primeira resposta' })

    await tick(menuChanged)
    await tick(indexChanged)
    expect(heard).toHaveLength(1)
    expect(seen).toEqual({ ticks: 3, skipped: 2, tailReads: 1 })
  })

  it('um campo de uma sessão mudou: a lista completa sai, não só o item', async () => {
    writeSession(A, 'busy')
    writeSession(B, 'idle')
    appendTranscript(A, 'primeira resposta')
    await tick(start)

    writeSession(B, 'busy')
    await tick(indexChanged)
    expect(heard).toHaveLength(2)
    expect(ids(heard[1])).toEqual([A, B])
    expect(item(heard[1], B)?.status).toBe('working')
    expect(item(heard[1], A)).toEqual(item(heard[0], A))
    expect(seen.tailReads).toBe(1)
  })

  it('transcript cresceu sem o índice mudar: é relido uma vez e a lista completa sai', async () => {
    writeSession(A, 'busy')
    writeSession(B, 'idle')
    appendTranscript(A, 'primeira resposta')
    await tick(start)

    appendTranscript(A, 'segunda resposta')
    await tick(menuChanged)
    expect(heard).toHaveLength(2)
    expect(ids(heard[1])).toEqual([A, B])
    expect(item(heard[1], A)?.lastText).toBe('segunda resposta')

    await tick(menuChanged)
    expect(heard).toHaveLength(2)
    expect(seen.tailReads).toBe(2)
  })

  it('sessão nova e sessão removida transmitem a lista nova', async () => {
    writeSession(A, 'busy')
    writeSession(B, 'idle')
    await tick(start)

    writeSession(C, 'idle')
    await tick(indexChanged)
    expect(ids(heard[1])).toEqual([A, B, C])

    rmSync(join(SESSIONS, `${B}.json`))
    await tick(indexChanged)
    expect(heard).toHaveLength(3)
    expect(ids(heard[2])).toEqual([A, C])
  })

  it("rajada de 'change' do TuiMenuWatch com mudança vira um batch só", async () => {
    writeSession(A, 'busy')
    appendTranscript(A, 'primeira resposta')
    await tick(start)

    appendTranscript(A, 'segunda resposta')
    await tick(() => {
      for (let i = 0; i < 5; i++) tuiMenuWatch.emit('change', `pty-${i}`)
    })
    await new Promise((resolve) => setTimeout(resolve, 600))
    drain()
    expect(seen.ticks).toBe(2)
    expect(heard).toHaveLength(2)
  })

  it('assinar de novo (janela recarregada) reenvia a lista mesmo sem mudança', async () => {
    writeSession(A, 'busy')
    appendTranscript(A, 'primeira resposta')
    await tick(start)
    await tick(start)
    expect(heard).toHaveLength(2)
    expect(heard[1]).toEqual(heard[0])
  })

  it('transcript que nasce depois é achado quando a entry da sessão muda', async () => {
    writeSession(A, 'idle')
    await tick(start)
    expect(item(heard[0], A)?.lastText).toBeNull()

    appendTranscript(A, 'nasceu')
    writeSession(A, 'busy')
    await tick(indexChanged)
    expect(item(heard[1], A)).toMatchObject({ status: 'working', lastText: 'nasceu' })
  })

  it('transcript que nasce sem a entry mudar é procurado de novo depois de 5 s', async () => {
    writeSession(A, 'idle')
    await tick(start)

    appendTranscript(A, 'nasceu')
    await tick(menuChanged)
    expect(heard).toHaveLength(1)

    const later = Date.now() + 5_000
    vi.spyOn(Date, 'now').mockReturnValue(later)
    await tick(menuChanged)
    expect(item(heard[1], A)?.lastText).toBe('nasceu')
  })
})
