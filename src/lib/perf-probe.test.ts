import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { perfRendererSummarySchema, type PerfRendererSummary } from '../../shared/types/perf'

type ObserverCallback = (list: { getEntries(): unknown[] }) => void

// O jsdom não tem PerformanceObserver: este registra quem observa o quê e deixa
// o teste entregar as entradas.
const observers = new Map<string, { callback: ObserverCallback; init: Record<string, unknown> }>()
class FakePerformanceObserver {
  constructor(private callback: ObserverCallback) {}
  observe(init: Record<string, unknown>) {
    observers.set(String(init.type), { callback: this.callback, init })
  }
}
const emit = (type: string, entries: Array<{ name: string; duration: number }>) =>
  observers.get(type)!.callback({ getEntries: () => entries })

const report = vi.fn<(summary: PerfRendererSummary) => void>()

// A flag é lida uma vez na carga do módulo: cada teste recarrega com a que quer.
async function loadProbe(enabled: boolean) {
  vi.resetModules()
  ;(window as unknown as { api: unknown }).api = { perf: { enabled, report } }
  return import('./perf-probe')
}

function keydown(target: EventTarget, timeStamp: number) {
  const event = new KeyboardEvent('keydown', { key: 'a', bubbles: true })
  Object.defineProperty(event, 'timeStamp', { value: timeStamp })
  target.dispatchEvent(event)
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('PerformanceObserver', FakePerformanceObserver)
  observers.clear()
  report.mockClear()
  delete window.__cmPerf
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

describe('flag desligada', () => {
  it('não registra, não observa, não envia e não lança', async () => {
    const listen = vi.spyOn(window, 'addEventListener')
    const probe = await loadProbe(false)

    probe.startPerfProbe()
    probe.perfCount('ChatView')
    probe.perfKeyWrite()
    probe.perfEnd('replay', probe.perfStart())
    expect(probe.perfStart()).toBe(0)
    vi.advanceTimersByTime(60_000)

    expect(report).not.toHaveBeenCalled()
    expect(observers.size).toBe(0)
    expect(listen.mock.calls.filter(([type]) => type === 'keydown')).toEqual([])
    expect(window.__cmPerf).toBeUndefined()
  })

  it('sem window.api (testes de componente) os contadores seguem inertes', async () => {
    vi.resetModules()
    delete (window as unknown as { api?: unknown }).api
    const probe = await import('./perf-probe')
    expect(() => probe.perfCount('Composer')).not.toThrow()
    expect(probe.perfStart()).toBe(0)
  })
})

describe('flag ligada', () => {
  it('envia um resumo por janela, no contrato que o main valida, e zera', async () => {
    const now = vi.spyOn(performance, 'now').mockReturnValue(0)
    const probe = await loadProbe(true)
    probe.startPerfProbe()

    expect(observers.get('longtask')).toBeDefined()
    expect(observers.get('event')!.init.durationThreshold).toBe(16)

    probe.perfCount('ChatView')
    probe.perfCount('ChatView')
    probe.perfCount('MarkdownViewer', 3)

    now.mockReturnValueOnce(100)
    const parseStart = probe.perfStart()
    now.mockReturnValueOnce(107.5)
    probe.perfEnd('tui-parse:s1', parseStart)
    now.mockReturnValueOnce(200)
    const replayStart = probe.perfStart()
    now.mockReturnValueOnce(260)
    probe.perfEnd('replay', replayStart)

    emit('longtask', [
      { name: 'self', duration: 60 },
      { name: 'self', duration: 120 },
    ])

    // 4 teclas; o observer só entrega as 2 que passaram de 16 ms.
    const composer = document.body.appendChild(document.createElement('textarea'))
    for (let i = 0; i < 3; i++) keydown(composer, 1000 + i)
    emit('event', [
      { name: 'keydown', duration: 24 },
      { name: 'pointerdown', duration: 300 },
      { name: 'keydown', duration: 40 },
    ])

    // Tecla no xterm: 12 ms entre o evento e o write.
    const xterm = document.body.appendChild(document.createElement('div'))
    xterm.className = 'xterm'
    const helper = xterm.appendChild(document.createElement('textarea'))
    keydown(helper, 2000)
    now.mockReturnValueOnce(2012)
    probe.perfKeyWrite()
    // Sem tecla pendente (resposta do xterm a uma query): não vira amostra.
    probe.perfKeyWrite()

    vi.advanceTimersByTime(10_000)

    expect(report).toHaveBeenCalledTimes(1)
    const summary = report.mock.calls[0][0]
    expect(summary).toEqual({
      windowMs: 10_000,
      longTasks: { n: 2, totalMs: 180, maxMs: 120 },
      keyToPaint: { n: 4, measured: 2, p50Ms: null, p95Ms: 40, maxMs: 40 },
      keyToWrite: { n: 1, measured: 1, p50Ms: 12, p95Ms: 12, maxMs: 12 },
      counters: { ChatView: 2, MarkdownViewer: 3 },
      spans: {
        'tui-parse:s1': { n: 1, totalMs: 7.5, maxMs: 7.5 },
        replay: { n: 1, totalMs: 60, maxMs: 60 },
      },
    } satisfies PerfRendererSummary)
    // O consumidor real: fora deste schema o main descarta o resumo.
    expect(perfRendererSummarySchema.safeParse(summary).success).toBe(true)

    probe.perfCount('Composer')
    vi.advanceTimersByTime(10_000)
    expect(report).toHaveBeenCalledTimes(2)
    expect(report.mock.calls[1][0]).toEqual({
      windowMs: 10_000,
      longTasks: { n: 0, totalMs: 0, maxMs: 0 },
      keyToPaint: { n: 0, measured: 0, p50Ms: null, p95Ms: null, maxMs: null },
      keyToWrite: { n: 0, measured: 0, p50Ms: null, p95Ms: null, maxMs: null },
      counters: { Composer: 1 },
      spans: {},
    })
  })

  it('window.__cmPerf acumula desde o início, sem zerar a cada janela', async () => {
    vi.spyOn(performance, 'now').mockReturnValue(0)
    const probe = await loadProbe(true)
    probe.startPerfProbe()

    probe.perfCount('ChatView')
    probe.perfEnd('tui-parse:s1', probe.perfStart())
    vi.advanceTimersByTime(10_000)
    probe.perfCount('ChatView')
    probe.perfEnd('tui-parse:s1', probe.perfStart())

    expect(window.__cmPerf).toEqual({
      counters: { ChatView: 2 },
      spans: { 'tui-parse:s1': { n: 2, totalMs: 0, maxMs: 0 } },
    })
  })

  it('tecla fora do xterm não conta como tecla→write', async () => {
    vi.spyOn(performance, 'now').mockReturnValue(5000)
    const probe = await loadProbe(true)
    probe.startPerfProbe()

    const composer = document.body.appendChild(document.createElement('textarea'))
    keydown(composer, 1000)
    probe.perfKeyWrite()
    vi.advanceTimersByTime(10_000)

    expect(report.mock.calls[0][0].keyToWrite.n).toBe(0)
  })

  it('tecla do xterm já solta sem write (atalho do app) não casa com um onData posterior', async () => {
    vi.spyOn(performance, 'now').mockReturnValue(9000)
    const probe = await loadProbe(true)
    probe.startPerfProbe()

    const xterm = document.body.appendChild(document.createElement('div'))
    xterm.className = 'xterm'
    keydown(xterm, 1000)
    xterm.dispatchEvent(new KeyboardEvent('keyup', { key: 'a', bubbles: true }))
    probe.perfKeyWrite()
    vi.advanceTimersByTime(10_000)

    expect(report.mock.calls[0][0].keyToWrite.n).toBe(0)
  })
})
