import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from 'playwright'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { collectPerf, installPerfProbe, markPerf, parsePerfLines, summarizePerf } from './perf'

interface Entry {
  name: string
  startTime: number
  duration: number
}
type ObserverCallback = (list: { getEntries(): Entry[] }) => void

// O jsdom não tem PerformanceObserver. Este entrega as entradas a todos os
// observers do tipo (a sonda do app e o coletor do driver observam os mesmos) e
// guarda em `pending` o que só sairia no takeRecords.
const observers: Array<{ type: string; callback: ObserverCallback }> = []
const pending: Record<string, Entry[]> = {}
class FakePerformanceObserver {
  private type = ''
  constructor(private callback: ObserverCallback) {}
  observe(init: { type: string }) {
    this.type = init.type
    observers.push({ type: init.type, callback: this.callback })
  }
  takeRecords(): Entry[] {
    return (pending[this.type] ?? []).splice(0)
  }
}
const emit = (type: string, entries: Entry[]) =>
  observers.filter((o) => o.type === type).forEach((o) => o.callback({ getEntries: () => entries }))

// page.evaluate de mentira: roda a função "da página" neste jsdom e devolve o
// resultado serializado, como o Playwright faz.
const page = {
  evaluate: async (fn: (arg: unknown) => unknown, arg?: unknown) => {
    const result = fn(arg)
    return result === undefined ? undefined : JSON.parse(JSON.stringify(result))
  },
} as unknown as Page

function dispatch(type: 'keydown' | 'input', timeStamp: number) {
  const event = new Event(type, { bubbles: true })
  Object.defineProperty(event, 'timeStamp', { value: timeStamp })
  document.body.dispatchEvent(event)
}

let now: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  vi.stubGlobal('PerformanceObserver', FakePerformanceObserver)
  observers.length = 0
  for (const key of Object.keys(pending)) delete pending[key]
  now = vi.spyOn(performance, 'now').mockReturnValue(0)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  delete (window as unknown as { __cmPerfDrive?: unknown }).__cmPerfDrive
  delete window.__cmPerf
})

// A sonda REAL do renderer, ligada: é ela que produz o window.__cmPerf lido pelo driver.
async function loadRendererProbe() {
  vi.resetModules()
  ;(window as unknown as { api: unknown }).api = { perf: { enabled: true, report: () => {} } }
  const probe = await import('../../src/lib/perf-probe')
  probe.startPerfProbe()
  return probe
}

describe('collectPerf + summarizePerf', () => {
  it('resume por fase a amostra bruta que o próprio coletor produziu', async () => {
    const probe = await loadRendererProbe()
    probe.perfCount('ChatView')
    await installPerfProbe(page)

    now.mockReturnValue(1000)
    await markPerf(page, 'chat')
    probe.perfCount('ChatView', 3)
    probe.perfCount('MarkdownViewer', 40)
    now.mockReturnValueOnce(1300)
    const replayStart = probe.perfStart()
    now.mockReturnValueOnce(1310)
    probe.perfEnd('replay', replayStart)
    // 20 teclas, 2 lentas; 20 inputs, 1 lento.
    for (let i = 0; i < 20; i++) {
      dispatch('keydown', 1100 + i * 30)
      dispatch('input', 1101 + i * 30)
    }
    emit('event', [
      { name: 'keydown', startTime: 1100, duration: 24 },
      { name: 'pointerdown', startTime: 1105, duration: 400 },
      { name: 'input', startTime: 1131, duration: 64 },
      { name: 'keydown', startTime: 1160, duration: 48 },
    ])
    emit('longtask', [
      { name: 'self', startTime: 1200, duration: 80 },
      { name: 'self', startTime: 1500, duration: 250 },
    ])

    now.mockReturnValue(5000)
    await markPerf(page, 'idle')
    // Ainda não entregue ao callback: só sai se o coletor esvaziar o observer.
    pending.longtask = [{ name: 'self', startTime: 5200, duration: 60 }]

    now.mockReturnValue(9000)
    const raw = await collectPerf(page)

    expect(raw.marks.map((m) => m.phase)).toEqual(['chat', 'idle'])
    expect(raw.marks[0].totals).toEqual({ counters: { ChatView: 1 }, spans: {} })
    expect(raw.inputs).toHaveLength(40)
    expect(raw.events).toHaveLength(3)

    expect(summarizePerf(raw)).toEqual([
      {
        phase: 'chat',
        durationMs: 4000,
        longTasks: { n: 2, totalMs: 330, maxMs: 250, tbtMs: 230 },
        keyToPaint: { n: 20, measured: 2, p50Ms: null, p95Ms: 24, maxMs: 48 },
        inputToPaint: { n: 20, measured: 1, p50Ms: null, p95Ms: null, maxMs: 64 },
        counters: { ChatView: 3, MarkdownViewer: 40 },
        spans: { replay: { n: 1, totalMs: 10 } },
      },
      {
        phase: 'idle',
        durationMs: 4000,
        longTasks: { n: 1, totalMs: 60, maxMs: 60, tbtMs: 10 },
        keyToPaint: { n: 0, measured: 0, p50Ms: null, p95Ms: null, maxMs: null },
        inputToPaint: { n: 0, measured: 0, p50Ms: null, p95Ms: null, maxMs: null },
        counters: {},
        spans: {},
      },
    ])
  })

  it('sem a sonda do app (CM_PERF desligado) as fases saem sem contadores', async () => {
    await installPerfProbe(page)
    now.mockReturnValue(100)
    await markPerf(page, 'open')
    now.mockReturnValue(600)
    const raw = await collectPerf(page)

    expect(raw.marks[0].totals).toBeNull()
    expect(summarizePerf(raw)).toEqual([
      {
        phase: 'open',
        durationMs: 500,
        longTasks: { n: 0, totalMs: 0, maxMs: 0, tbtMs: 0 },
        keyToPaint: { n: 0, measured: 0, p50Ms: null, p95Ms: null, maxMs: null },
        inputToPaint: { n: 0, measured: 0, p50Ms: null, p95Ms: null, maxMs: null },
        counters: {},
        spans: {},
      },
    ])
  })

  it('instalar duas vezes não duplica observers nem amostras', async () => {
    await installPerfProbe(page)
    await installPerfProbe(page)
    await markPerf(page, 'open')
    dispatch('keydown', 10)
    const raw = await collectPerf(page)
    expect(raw.inputs).toHaveLength(1)
  })
})

describe('parsePerfLines', () => {
  it('lê do log as linhas [perf] que a sonda real do main emite', async () => {
    const userData = mkdtempSync(join(tmpdir(), 'perf-driver-'))
    vi.useFakeTimers()
    vi.resetModules()
    vi.stubEnv('CM_PERF', '1')
    const main = await import('../../electron/main/services/perf-probe')
    const lines: string[] = []
    const stop = main.startPerfProbe({
      app: { getPath: () => userData, getAppMetrics: () => [] } as never,
      ipcMain: { on: () => undefined } as never,
      log: (line) => lines.push(line),
    })
    main.perfCount('pty:data.chars', 12)
    vi.advanceTimersByTime(20_000)
    stop()
    vi.useRealTimers()
    // O append do perf.jsonl é assíncrono: espera antes de remover o diretório.
    await new Promise((resolve) => setTimeout(resolve, 50))
    rmSync(userData, { recursive: true, force: true })

    const log = ['[launch] cópia sem gatilhos de spawn', ...lines, '[perf] {quebrada', ''].join(
      '\n',
    )
    const parsed = parsePerfLines(log)

    expect(parsed).toHaveLength(2)
    expect(parsed[0].windowMs).toBe(10_000)
    expect(parsed[0].counters).toEqual({ 'pty:data.chars': 12 })
    expect(parsed[1].counters).toEqual({})
  })
})
