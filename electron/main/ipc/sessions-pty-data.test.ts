/** @vitest-environment node */
// O pty:data coalescido pelos produtores reais do ipc/sessions.ts: o listener de
// data, o handler sessions:get-backlog e o listener de exit. Fake só na borda: a
// PTY (com o backlog crescendo ANTES do evento, como o deliver do pty-manager) e
// a janela, que guarda o que o renderer receberia, na ordem.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { PTY_DATA_WINDOW_MS } from '../services/pty-data-coalescer'

const seam = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  listeners: new Map<string, Array<(e: unknown) => void>>(),
  backlog: new Map<string, string>(),
  sent: [] as Array<{ channel: string; payload: unknown }>,
}))

vi.mock('../services/handoff/claude-trust', () => ({ preTrustClaudeDirs: vi.fn(() => true) }))
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/cm-test-userdata' },
  BrowserWindow: {
    getAllWindows: () => [
      {
        isDestroyed: () => false,
        webContents: {
          isDestroyed: () => false,
          send: (channel: string, payload: unknown) => seam.sent.push({ channel, payload }),
        },
      },
    ],
  },
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) => {
      seam.handlers.set(channel, fn)
    },
  },
}))
vi.mock('../services/db', () => ({
  getDb: () => ({
    prepare: () => ({ run: () => ({ changes: 1 }), get: () => undefined, all: () => [] }),
  }),
}))
vi.mock('../services/pty-manager', () => ({
  ptyManager: {
    on: (event: string, fn: (e: unknown) => void) => {
      seam.listeners.set(event, [...(seam.listeners.get(event) ?? []), fn])
    },
    off: () => {},
    write: () => {},
    isRunning: () => true,
    runningIds: () => [],
    getPid: () => null,
    sessionIdByPid: () => null,
    getBacklog: (sessionId: string) => seam.backlog.get(sessionId) ?? '',
  },
}))
vi.mock('../services/custom-env', () => ({ sessionSpawnEnv: () => ({}) }))
vi.mock('../services/feature-store', () => ({ get: () => null, linkedObjectiveTitles: () => [] }))
vi.mock('../services/feature-memory', () => ({ featureMemory: { onSessionExit: () => {} } }))
vi.mock('../services/handoff-store', () => ({
  get: () => null,
  workDirOf: () => null,
  findActiveWriterByWorkDir: () => null,
  getByChildSession: () => null,
  failIfRunning: () => null,
  transferMother: () => [],
  adoptResumedConversation: () => [],
}))
vi.mock('../services/mcp/server', () => ({ getMcpRuntime: () => null }))
vi.mock('../services/mcp/config', () => ({
  mcpClientConfigPath: () => '/tmp/mcp.json',
  writeSessionMcpClientConfig: () => '/tmp/mcp-session.json',
  removeSessionMcpConfig: () => {},
}))
vi.mock('../services/session-activity', () => ({
  sessionActivityService: {},
  findTranscriptPath: () => null,
  buildSessionsFileIndex: () => new Map(),
  readTranscriptTitle: () => null,
  readTail: () => null,
  deriveEnrichment: () => ({}),
  isPidAlive: () => false,
  mapStatus: () => 'idle',
}))

import { registerSessionIpc } from './sessions'

const ID = 'pty-1'
const OTHER = 'pty-2'

function emitData(sessionId: string, data: string): void {
  seam.backlog.set(sessionId, (seam.backlog.get(sessionId) ?? '') + data)
  for (const fn of seam.listeners.get('data') ?? []) fn({ sessionId, data })
}

function emitExit(sessionId: string): void {
  for (const fn of seam.listeners.get('exit') ?? []) fn({ sessionId, exitCode: 0, signal: null })
}

function getBacklog(sessionId: string): string {
  return seam.handlers.get('sessions:get-backlog')!(null, sessionId) as string
}

const ptyChannels = () => seam.sent.map((s) => s.channel).filter((c) => c.startsWith('pty:'))

// O que um terminal montado no envio de índice `from` recebeu ao vivo até `to`.
function live(sessionId: string, from: number, to = seam.sent.length): string {
  return seam.sent
    .slice(from, to)
    .filter((s) => s.channel === 'pty:data')
    .map((s) => s.payload as { sessionId: string; data: string })
    .filter((e) => e.sessionId === sessionId)
    .map((e) => e.data)
    .join('')
}

// Espelho do replay de src/features/sessions/Terminal.tsx (setDataHandler +
// getBacklog().then): o live que chegou antes da resposta só entra pela cauda que
// o backlog ainda não cobre; o que chega depois é escrito direto.
function replayScreen(liveBeforeReply: string, backlog: string, liveAfterReply: string): string {
  const tail = liveBeforeReply.length > backlog.length ? liveBeforeReply.slice(backlog.length) : ''
  return backlog + tail + liveAfterReply
}

describe('pty:data coalescido no ipc/sessions', () => {
  beforeAll(() => registerSessionIpc())

  beforeEach(() => {
    vi.useFakeTimers()
    seam.backlog.clear()
    seam.sent.length = 0
  })
  afterEach(() => {
    // Fecha as janelas abertas antes de devolver os timers reais.
    vi.advanceTimersByTime(PTY_DATA_WINDOW_MS * 2)
    vi.useRealTimers()
  })

  it('o eco isolado sai na hora e a rajada vira um envio por janela', () => {
    emitData(ID, 'eco')
    expect(live(ID, 0)).toBe('eco')

    for (let i = 0; i < 50; i++) emitData(ID, `linha ${i}\r\n`)
    expect(ptyChannels()).toHaveLength(1)

    vi.advanceTimersByTime(PTY_DATA_WINDOW_MS)
    expect(ptyChannels()).toHaveLength(2)
    expect(live(ID, 0)).toBe(seam.backlog.get(ID))
  })

  it('sessions:get-backlog entrega o pendente antes de responder', () => {
    emitData(ID, 'a')
    emitData(ID, 'b')
    emitData(OTHER, 'x')
    emitData(OTHER, 'y')

    const backlog = getBacklog(ID)

    expect(backlog).toBe('ab')
    expect(live(ID, 0)).toBe(backlog)
    // Só a sessão pedida: a outra segue na janela dela.
    expect(live(OTHER, 0)).toBe('x')
  })

  it('terminal montado desde o início: a tela do replay é o backlog, sem duplicar', () => {
    const mountedAt = seam.sent.length
    emitData(ID, 'banner\r\n')
    emitData(ID, 'linha 1\r\n')
    emitData(ID, 'linha 2\r\n')

    const backlog = getBacklog(ID)
    const repliedAt = seam.sent.length

    emitData(ID, 'linha 3\r\n')
    emitData(ID, 'linha 4\r\n')
    vi.advanceTimersByTime(PTY_DATA_WINDOW_MS * 2)

    const screen = replayScreen(live(ID, mountedAt, repliedAt), backlog, live(ID, repliedAt))
    expect(screen).toBe(seam.backlog.get(ID))
  })

  it('terminal remontado no meio do streaming: a tela do replay é o backlog', () => {
    emitData(ID, 'banner\r\n')
    emitData(ID, 'antes do mount 1\r\n')
    emitData(ID, 'antes do mount 2\r\n')

    // Remount com bytes já no backlog e ainda na janela.
    const mountedAt = seam.sent.length
    emitData(ID, 'entre mount e backlog\r\n')
    const backlog = getBacklog(ID)
    const repliedAt = seam.sent.length

    emitData(ID, 'depois 1\r\n')
    vi.advanceTimersByTime(3)
    emitData(ID, 'depois 2\r\n')
    vi.advanceTimersByTime(PTY_DATA_WINDOW_MS * 2)
    emitData(ID, 'depois 3\r\n')
    vi.advanceTimersByTime(PTY_DATA_WINDOW_MS * 2)

    const screen = replayScreen(live(ID, mountedAt, repliedAt), backlog, live(ID, repliedAt))
    expect(screen).toBe(seam.backlog.get(ID))
  })

  it('a cauda pendente chega antes do pty:exit e nada sai depois dele', () => {
    emitData(ID, 'saída ')
    emitData(ID, 'final\r\n')

    emitExit(ID)

    expect(ptyChannels()).toEqual(['pty:data', 'pty:data', 'pty:exit'])
    expect(live(ID, 0)).toBe('saída final\r\n')

    vi.advanceTimersByTime(PTY_DATA_WINDOW_MS * 2)
    expect(ptyChannels()).toEqual(['pty:data', 'pty:data', 'pty:exit'])
  })
})
