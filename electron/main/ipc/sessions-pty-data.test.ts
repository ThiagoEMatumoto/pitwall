/** @vitest-environment node */
// O pty:data coalescido pelos produtores reais do ipc/sessions.ts: o listener de
// data, o pedido sessions:get-backlog e o listener de exit. Fake só na borda: a
// PTY (com o backlog crescendo ANTES do evento, como o deliver do pty-manager) e
// as janelas, que guardam o que cada renderer receberia, na ordem.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  REPLAY_PENDING,
  replayStep,
  type ReplayEvent,
} from '../../../src/features/sessions/backlog-replay'
import { PTY_DATA_WINDOW_MS } from '../services/pty-data-coalescer'

const seam = vi.hoisted(() => {
  const sent: Array<{ to: number; channel: string; payload: unknown }> = []
  const webContentsOf = (id: number) => ({
    destroyed: false,
    isDestroyed(): boolean {
      return this.destroyed
    },
    send: (channel: string, payload: unknown) => sent.push({ to: id, channel, payload }),
  })
  const main = webContentsOf(1)
  return {
    events: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
    listeners: new Map<string, Array<(e: unknown) => void>>(),
    backlog: new Map<string, string>(),
    backlogError: null as Error | null,
    cap: Infinity,
    sent,
    webContentsOf,
    main,
    windows: [main],
  }
})

vi.mock('../services/handoff/claude-trust', () => ({ preTrustClaudeDirs: vi.fn(() => true) }))
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/cm-test-userdata' },
  BrowserWindow: {
    getAllWindows: () =>
      seam.windows.map((webContents) => ({ isDestroyed: () => false, webContents })),
  },
  ipcMain: {
    handle: () => {},
    on: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) => {
      seam.events.set(channel, fn)
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
    getBacklog: (sessionId: string) => {
      if (seam.backlogError) throw seam.backlogError
      return seam.backlog.get(sessionId) ?? ''
    },
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

// O backlog guarda só a cauda acima do cap, como o deliver do pty-manager.
function emitData(sessionId: string, data: string): void {
  const next = (seam.backlog.get(sessionId) ?? '') + data
  seam.backlog.set(sessionId, next.length > seam.cap ? next.slice(next.length - seam.cap) : next)
  for (const fn of seam.listeners.get('data') ?? []) fn({ sessionId, data })
}

function emitExit(sessionId: string): void {
  for (const fn of seam.listeners.get('exit') ?? []) fn({ sessionId, exitCode: 0, signal: null })
}

type BacklogReply = { requestId: string; backlog?: string; error?: string }

// O pedido como o preload o faz: evento com id, resposta por sender.send.
function requestBacklog(requestId: string, sessionId: string, sender = seam.main): void {
  seam.events.get('sessions:get-backlog')!({ sender }, requestId, sessionId)
}

const backlogReplies = () =>
  seam.sent.filter((s) => s.channel === 'sessions:backlog').map((s) => s.payload as BacklogReply)

function getBacklog(sessionId: string): string {
  requestBacklog('r1', sessionId)
  return backlogReplies().at(-1)!.backlog!
}

const channelsTo = (to: number) => seam.sent.filter((s) => s.to === to).map((s) => s.channel)
const ptyChannels = () => channelsTo(1).filter((c) => c.startsWith('pty:'))

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

function replayEventOf(sessionId: string, channel: string, payload: unknown): ReplayEvent | null {
  if (channel === 'sessions:backlog') {
    const reply = payload as BacklogReply
    return reply.backlog === undefined
      ? { kind: 'backlog-failed' }
      : { kind: 'backlog', backlog: reply.backlog }
  }
  if (channel !== 'pty:data') return null
  const e = payload as { sessionId: string; data: string }
  return e.sessionId === sessionId ? { kind: 'data', data: e.data } : null
}

// A tela de um terminal montado no envio de índice `mountedAt`: a regra de replay
// que o Terminal.tsx usa, aplicada ao que a janela recebeu, na ordem em que saiu.
function replayScreen(sessionId: string, mountedAt: number): string {
  return seam.sent.slice(mountedAt).reduce(
    (acc, s) => {
      const event = replayEventOf(sessionId, s.channel, s.payload)
      if (!event) return acc
      const step = replayStep(acc.state, event)
      return { state: step.state, screen: acc.screen + step.write }
    },
    { state: REPLAY_PENDING, screen: '' },
  ).screen
}

describe('pty:data coalescido no ipc/sessions', () => {
  beforeAll(() => registerSessionIpc())

  beforeEach(() => {
    vi.useFakeTimers()
    seam.backlog.clear()
    seam.backlogError = null
    seam.cap = Infinity
    seam.sent.length = 0
    seam.main.destroyed = false
    seam.windows = [seam.main]
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

  it('a resposta do backlog sai na fila dos pty:data, atrás de tudo que saiu antes do snapshot', () => {
    emitData(ID, 'a')
    emitData(ID, 'b')
    emitData(ID, 'c')

    requestBacklog('r7', ID)

    expect(channelsTo(1)).toEqual(['pty:data', 'pty:data', 'sessions:backlog'])
    expect(backlogReplies()).toEqual([{ requestId: 'r7', backlog: 'abc' }])
    // Tudo que o backlog cobre já está na frente da resposta.
    expect(live(ID, 0)).toBe('abc')

    emitData(ID, 'd')
    vi.advanceTimersByTime(PTY_DATA_WINDOW_MS * 2)
    expect(channelsTo(1).at(-1)).toBe('pty:data')
    expect(live(ID, 3)).toBe('d')
  })

  it('a resposta do backlog vai só para o remetente do pedido', () => {
    const other = seam.webContentsOf(2)
    seam.windows = [seam.main, other]
    emitData(ID, 'a')
    emitData(ID, 'b')

    requestBacklog('r1', ID, other)

    expect(channelsTo(2)).toEqual(['pty:data', 'pty:data', 'sessions:backlog'])
    expect(channelsTo(1)).toEqual(['pty:data', 'pty:data'])
  })

  it('erro ao ler o backlog vira resposta de erro para o pedido', () => {
    seam.backlogError = new Error('pty sumiu')

    expect(() => requestBacklog('r3', ID)).not.toThrow()

    expect(backlogReplies()).toEqual([{ requestId: 'r3', error: 'pty sumiu' }])
  })

  it('pedido com id ou sessão de tipo errado é ignorado, sem lançar', () => {
    emitData(ID, 'a')
    const handler = seam.events.get('sessions:get-backlog')!

    expect(() => handler({ sender: seam.main }, 7, ID)).not.toThrow()
    expect(() => handler({ sender: seam.main }, 'r7', undefined)).not.toThrow()

    expect(backlogReplies()).toEqual([])
  })

  it('remetente destruído: não lança e não envia', () => {
    emitData(ID, 'a')
    seam.main.destroyed = true
    seam.windows = []

    expect(() => requestBacklog('r4', ID)).not.toThrow()

    expect(backlogReplies()).toEqual([])
  })

  it('dois pedidos concorrentes: cada resposta leva o id e o backlog do seu pedido', () => {
    emitData(ID, 'a')
    emitData(ID, 'b')
    emitData(OTHER, 'x')
    emitData(OTHER, 'y')

    requestBacklog('r1', ID)
    requestBacklog('r2', OTHER)

    expect(backlogReplies()).toEqual([
      { requestId: 'r1', backlog: 'ab' },
      { requestId: 'r2', backlog: 'xy' },
    ])
    const sent = seam.sent.map((s) => {
      const p = s.payload as { sessionId?: string; data?: string; requestId?: string }
      return p.sessionId ? `${p.sessionId}:${p.data}` : `reply ${p.requestId}`
    })
    expect(sent).toEqual(['pty-1:a', 'pty-2:x', 'pty-1:b', 'reply r1', 'pty-2:y', 'reply r2'])
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

    getBacklog(ID)

    emitData(ID, 'linha 3\r\n')
    emitData(ID, 'linha 4\r\n')
    vi.advanceTimersByTime(PTY_DATA_WINDOW_MS * 2)

    expect(replayScreen(ID, mountedAt)).toBe(seam.backlog.get(ID))
  })

  it('terminal remontado no meio do streaming: a tela do replay é o backlog', () => {
    emitData(ID, 'banner\r\n')
    emitData(ID, 'antes do mount 1\r\n')
    emitData(ID, 'antes do mount 2\r\n')

    // Remount com bytes já no backlog e ainda na janela.
    const mountedAt = seam.sent.length
    emitData(ID, 'entre mount e backlog\r\n')
    getBacklog(ID)

    emitData(ID, 'depois 1\r\n')
    vi.advanceTimersByTime(3)
    emitData(ID, 'depois 2\r\n')
    vi.advanceTimersByTime(PTY_DATA_WINDOW_MS * 2)
    emitData(ID, 'depois 3\r\n')
    vi.advanceTimersByTime(PTY_DATA_WINDOW_MS * 2)

    expect(replayScreen(ID, mountedAt)).toBe(seam.backlog.get(ID))
  })

  it('backlog cortado pelo cap: a tela é o backlog mais o que veio depois, sem repetir', () => {
    seam.cap = 16
    const mountedAt = seam.sent.length
    emitData(ID, 'linha 1\r\n')
    emitData(ID, 'linha 2\r\n')
    emitData(ID, 'linha 3\r\n')

    const backlog = getBacklog(ID)
    const repliedAt = seam.sent.length
    expect(backlog).toBe('nha 2\r\nlinha 3\r\n')
    expect(live(ID, mountedAt, repliedAt).length).toBeGreaterThan(backlog.length)

    emitData(ID, 'linha 4\r\n')
    emitData(ID, 'linha 5\r\n')
    vi.advanceTimersByTime(PTY_DATA_WINDOW_MS * 2)

    expect(replayScreen(ID, mountedAt)).toBe(backlog + 'linha 4\r\nlinha 5\r\n')
  })

  it('backlog que falhou: a tela fica com o live visto desde o mount, na ordem', () => {
    emitData(ID, 'antes do mount\r\n')
    const mountedAt = seam.sent.length
    emitData(ID, 'linha 1\r\n')
    emitData(ID, 'linha 2\r\n')
    seam.backlogError = new Error('pty sumiu')

    requestBacklog('r5', ID)
    emitData(ID, 'linha 3\r\n')
    vi.advanceTimersByTime(PTY_DATA_WINDOW_MS * 2)

    expect(replayScreen(ID, mountedAt)).toBe('linha 1\r\nlinha 2\r\nlinha 3\r\n')
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
