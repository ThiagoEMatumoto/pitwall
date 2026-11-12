/** @vitest-environment node */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { latencyStats } from '../../../shared/perf-stats'
import type { PerfLine, PerfRendererSummary } from '../../../shared/types/perf'

// A flag é lida uma vez na carga do módulo: cada teste recarrega com o env que quer.
async function loadProbe(flag: string) {
  vi.resetModules()
  vi.stubEnv('CM_PERF', flag)
  return import('./perf-probe')
}

type Listener = (...args: unknown[]) => unknown

function fakeIpcMain() {
  const handlers = new Map<string, Listener>()
  const listeners = new Map<string, Listener>()
  const ipc = {
    handle(channel: string, fn: Listener) {
      handlers.set(channel, fn)
    },
    on(channel: string, fn: Listener) {
      listeners.set(channel, fn)
      return ipc
    },
  }
  return {
    ipc: ipc as never,
    invoke: (channel: string, ...args: unknown[]) => handlers.get(channel)!({}, ...args),
    send: (channel: string, senderId: number, ...args: unknown[]) =>
      listeners.get(channel)!({ sender: { id: senderId } }, ...args),
  }
}

function fakeApp(userData: string) {
  const metric = (type: string, percentCPUUsage: number) => ({ type, cpu: { percentCPUUsage } })
  return {
    getPath: () => userData,
    getAppMetrics: () => [
      metric('Browser', 4.5),
      metric('Tab', 93),
      metric('Tab', 27.5),
      metric('GPU', 90),
    ],
  } as never
}

function parseLine(line: string): PerfLine {
  expect(line.startsWith('[perf] ')).toBe(true)
  return JSON.parse(line.slice('[perf] '.length)) as PerfLine
}

const EMPTY_WINDOW = { ipcIn: {}, ipcOut: {}, counters: {}, spans: {} }

// O append é assíncrono: sem esperar, ele termina (ou falha, com o diretório já
// removido) dentro do teste seguinte.
async function writtenLines(dir: string, count: number): Promise<string[]> {
  vi.useRealTimers()
  const read = () => readFileSync(join(dir, 'perf.jsonl'), 'utf8').split('\n').filter(Boolean)
  await vi.waitFor(() => expect(read()).toHaveLength(count))
  return read()
}

describe('perf-probe', () => {
  let dir = ''
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cm-perf-probe-'))
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    rmSync(dir, { recursive: true, force: true })
  })

  it('só liga com CM_PERF=1', async () => {
    const { isPerfEnabled } = await loadProbe('')
    expect(isPerfEnabled({ CM_PERF: '1' })).toBe(true)
    expect(isPerfEnabled({ CM_PERF: '0' })).toBe(false)
    expect(isPerfEnabled({ CM_PERF: 'true' })).toBe(false)
    expect(isPerfEnabled({})).toBe(false)
  })

  it('desligada: não conta, não cronometra e não retém nada', async () => {
    const probe = await loadProbe('')
    probe.perfCount('broadcastGlobal.sessions', 5)
    probe.perfOut('pty:data')
    expect(probe.perfTime('graph.rebuild', () => 42)).toBe(42)
    expect(probe.drainPerfWindow(10_000)).toEqual(EMPTY_WINDOW)
  })

  it('ligada: conta, soma e zera ao drenar a janela', async () => {
    const probe = await loadProbe('1')
    probe.perfCount('broadcastGlobal.sessions', 5)
    probe.perfCount('broadcastGlobal.sessions', 3)
    probe.perfOut('pty:data')
    probe.perfOut('pty:data')
    const window = probe.drainPerfWindow(10_000)
    expect(window.counters).toEqual({ 'broadcastGlobal.sessions': 8 })
    expect(window.ipcOut).toEqual({ 'pty:data': 2 })
    expect(probe.drainPerfWindow(10_000)).toEqual(EMPTY_WINDOW)
  })

  it('perfTime mede trecho síncrono e assíncrono e devolve o resultado', async () => {
    const probe = await loadProbe('1')
    const busy = () => {
      const end = performance.now() + 5
      while (performance.now() < end);
      return 'ok'
    }
    expect(probe.perfTime('graph.rebuild', busy)).toBe('ok')
    await expect(probe.perfTime('broadcastGlobal', async () => 'batch')).resolves.toBe('batch')
    const { spans } = probe.drainPerfWindow(10_000)
    expect(spans['graph.rebuild'].n).toBe(1)
    expect(spans['graph.rebuild'].maxMs).toBeGreaterThanOrEqual(4)
    expect(spans['graph.rebuild'].totalMs).toBeGreaterThanOrEqual(spans['graph.rebuild'].maxMs)
    expect(spans.broadcastGlobal.n).toBe(1)
  })

  it('perfTime registra o trecho mesmo quando ele falha, e repassa o erro', async () => {
    const probe = await loadProbe('1')
    expect(() =>
      probe.perfTime('sync', () => {
        throw new Error('boom')
      }),
    ).toThrow('boom')
    await expect(
      probe.perfTime('async', async () => {
        throw new Error('bam')
      }),
    ).rejects.toThrow('bam')
    const { spans } = probe.drainPerfWindow(10_000)
    expect(spans.sync.n).toBe(1)
    expect(spans.async.n).toBe(1)
  })

  it('instrumentIpcMain conta e cronometra handle e on sem mudar o resultado', async () => {
    const probe = await loadProbe('1')
    const { ipc, invoke, send } = fakeIpcMain()
    probe.instrumentIpcMain(ipc)
    const received: unknown[] = []
    const fake = ipc as unknown as {
      handle: (c: string, fn: Listener) => void
      on: (c: string, fn: Listener) => unknown
    }
    fake.handle('sessions:write', (_e, sessionId, data) => `${sessionId}:${data}`)
    fake.handle('sessions:get-backlog', async () => 'backlog')
    expect(fake.on('sessions:write-draft', (_e, draft) => received.push(draft))).toBe(ipc)

    expect(invoke('sessions:write', 's1', 'a')).toBe('s1:a')
    await expect(invoke('sessions:get-backlog')).resolves.toBe('backlog')
    send('sessions:write-draft', 1, { text: 'oi' })

    expect(received).toEqual([{ text: 'oi' }])
    const { ipcIn } = probe.drainPerfWindow(10_000)
    expect(ipcIn['sessions:write'].n).toBe(1)
    expect(ipcIn['sessions:get-backlog'].n).toBe(1)
    expect(ipcIn['sessions:write-draft'].n).toBe(1)
  })

  it('in:sessions:write traz média e pico por segundo', async () => {
    vi.useFakeTimers()
    const probe = await loadProbe('1')
    const { ipc, invoke } = fakeIpcMain()
    probe.instrumentIpcMain(ipc)
    ;(ipc as unknown as { handle: (c: string, fn: Listener) => void }).handle(
      'sessions:write',
      () => undefined,
    )
    for (let i = 0; i < 25; i++) invoke('sessions:write', 's1', 'a')
    await vi.advanceTimersByTimeAsync(1000)
    for (let i = 0; i < 5; i++) invoke('sessions:write', 's1', 'a')
    const { ipcIn } = probe.drainPerfWindow(10_000)
    expect(ipcIn['sessions:write']).toMatchObject({ n: 30, perSec: 3, peakPerSec: 25 })
  })

  it('emite uma linha [perf] por janela, grava em perf.jsonl e zera', async () => {
    vi.useFakeTimers()
    const probe = await loadProbe('1')
    const lines: string[] = []
    const { ipc, invoke } = fakeIpcMain()
    const stop = probe.startPerfProbe({
      app: fakeApp(dir),
      ipcMain: ipc,
      log: (line) => lines.push(line),
    })
    probe.instrumentIpcMain(ipc)
    ;(ipc as unknown as { handle: (c: string, fn: Listener) => void }).handle(
      'sessions:write',
      () => undefined,
    )
    for (let i = 0; i < 30; i++) invoke('sessions:write', 's1', 'a')
    probe.perfOut('pty:data')
    probe.perfCount('broadcastGlobal.sessions', 5)
    probe.perfTime('graph.rebuild', () => 1)

    await vi.advanceTimersByTimeAsync(9_999)
    expect(lines).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(lines).toHaveLength(1)
    const first = parseLine(lines[0])
    expect(first.windowMs).toBe(10_000)
    expect(first.ipcIn['sessions:write']).toMatchObject({ n: 30, perSec: 3, peakPerSec: 30 })
    expect(first.ipcOut).toEqual({ 'pty:data': 1 })
    expect(first.counters).toEqual({ 'broadcastGlobal.sessions': 5 })
    expect(first.spans['graph.rebuild'].n).toBe(1)
    expect(first.cpu).toEqual({
      Browser: { n: 1, percent: 4.5 },
      Tab: { n: 2, percent: 120.5 },
      GPU: { n: 1, percent: 90 },
    })
    for (const value of Object.values(first.lagMs)) expect(value).toBeGreaterThanOrEqual(0)
    expect(first.renderer).toEqual([])

    await vi.advanceTimersByTimeAsync(10_000)
    expect(lines).toHaveLength(2)
    const second = parseLine(lines[1])
    expect(second).toMatchObject({ ...EMPTY_WINDOW, renderer: [] })

    stop()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(lines).toHaveLength(2)

    expect(await writtenLines(dir, 2)).toEqual(lines.map((l) => l.slice('[perf] '.length)))
  })

  it('o resumo do renderer entra na linha seguinte, por janela de origem', async () => {
    vi.useFakeTimers()
    const probe = await loadProbe('1')
    const lines: string[] = []
    const { ipc, send } = fakeIpcMain()
    const stop = probe.startPerfProbe({
      app: fakeApp(dir),
      ipcMain: ipc,
      log: (line) => lines.push(line),
    })
    const summary: PerfRendererSummary = {
      windowMs: 10_000,
      longTasks: { n: 3, totalMs: 420, maxMs: 210 },
      // Do produtor real: 200 teclas, só 3 acima do limiar (percentil não medido = null).
      keyToPaint: latencyStats([24, 64, 180], 200),
      keyToWrite: latencyStats([2, 31, 90], 3),
      counters: { ChatView: 12 },
      spans: { 'tui-parse:s1': { n: 4, totalMs: 80, maxMs: 35 } },
    }
    send('perf:renderer', 7, summary)

    await vi.advanceTimersByTimeAsync(10_000)
    expect(parseLine(lines[0]).renderer).toEqual([{ webContentsId: 7, ...summary }])
    await vi.advanceTimersByTimeAsync(10_000)
    expect(parseLine(lines[1]).renderer).toEqual([])
    stop()
    await writtenLines(dir, 2)
  })

  it('resumo do renderer fora do contrato é descartado com aviso', async () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const probe = await loadProbe('1')
    const lines: string[] = []
    const { ipc, send } = fakeIpcMain()
    const stop = probe.startPerfProbe({
      app: fakeApp(dir),
      ipcMain: ipc,
      log: (line) => lines.push(line),
    })
    send('perf:renderer', 7, { windowMs: 10_000, longTasks: 3 })

    await vi.advanceTimersByTimeAsync(10_000)
    expect(parseLine(lines[0]).renderer).toEqual([])
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toContain('fora do contrato')
    stop()
    await writtenLines(dir, 1)
  })
})
