import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from 'playwright'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  collectPerf,
  installPerfProbe,
  markPerf,
  parsePerfLines,
  peekPerf,
  runPhase,
  summarizePerf,
  typeOpenLoop,
  withMainLines,
} from './perf'

interface Entry {
  name: string
  startTime: number
  duration: number
}
type ObserverCallback = (list: { getEntries(): Entry[] }) => void

// O jsdom não tem PerformanceObserver. Este entrega as entradas a todos os
// observers do tipo (a sonda do app e o coletor do driver observam os mesmos) e
// guarda em `pending` o que só sairia no takeRecords.
interface ObserverInit {
  type: string
  durationThreshold?: number
}
const observers: Array<{ init: ObserverInit; callback: ObserverCallback }> = []
const pending: Record<string, Entry[]> = {}
class FakePerformanceObserver {
  private type = ''
  constructor(private callback: ObserverCallback) {}
  observe(init: ObserverInit) {
    this.type = init.type
    observers.push({ init, callback: this.callback })
  }
  takeRecords(): Entry[] {
    return (pending[this.type] ?? []).splice(0)
  }
}
const emit = (type: string, entries: Entry[]) =>
  observers
    .filter((o) => o.init.type === type)
    .forEach((o) => o.callback({ getEntries: () => entries }))

// page.evaluate de mentira: roda a função "da página" neste jsdom e devolve o
// resultado serializado, como o Playwright faz.
const page = {
  evaluate: async (fn: (arg: unknown) => unknown, arg?: unknown) => {
    const result = await fn(arg)
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
  delete (window as unknown as { api?: unknown }).api
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
        // 20 teclas a cada 30 ms: 19 intervalos.
        keyIntervalMs: { n: 19, measured: 19, p50Ms: 30, p95Ms: 30, maxMs: 30 },
        counters: { ChatView: 3, MarkdownViewer: 40 },
        spans: { replay: { n: 1, totalMs: 10 } },
      },
      {
        phase: 'idle',
        durationMs: 4000,
        longTasks: { n: 1, totalMs: 60, maxMs: 60, tbtMs: 10 },
        keyToPaint: { n: 0, measured: 0, p50Ms: null, p95Ms: null, maxMs: null },
        inputToPaint: { n: 0, measured: 0, p50Ms: null, p95Ms: null, maxMs: null },
        keyIntervalMs: { n: 0, measured: 0, p50Ms: null, p95Ms: null, maxMs: null },
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
        keyIntervalMs: { n: 0, measured: 0, p50Ms: null, p95Ms: null, maxMs: null },
        counters: {},
        spans: {},
      },
    ])
  })

  // Sem durationThreshold o Chromium usa 104 ms: toda tecla de 16-104 ms sumiria
  // da medida e o p95 de keyToPaint cairia para "não medido" sem erro nenhum.
  it('o coletor observa event com limiar de 16 ms e longtask', async () => {
    await installPerfProbe(page)
    expect(observers.map((o) => o.init)).toEqual([
      { type: 'longtask' },
      { type: 'event', durationThreshold: 16 },
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

describe('peekPerf', () => {
  it('lê o coletor no meio do cenário sem fechar a janela do main', async () => {
    const drain = vi.fn(async () => undefined)
    ;(window as unknown as { api: unknown }).api = { perf: { drain } }
    await installPerfProbe(page)
    now.mockReturnValue(100)
    await markPerf(page, 'open')
    pending.longtask = [{ name: 'self', startTime: 200, duration: 13_000 }]

    now.mockReturnValue(14_000)
    const raw = await peekPerf(page)

    expect(drain.mock.calls).toEqual([['open']])
    expect(summarizePerf(raw)).toMatchObject([
      { phase: 'open', durationMs: 13_900, longTasks: { n: 1, maxMs: 13_000 } },
    ])
    await collectPerf(page)
    expect(drain.mock.calls).toEqual([['open'], ['end']])
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
      ipcMain: { on: () => undefined, handle: () => undefined } as never,
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

describe('linhas do main por fase', () => {
  it('cada marca fecha a janela da sonda real do main e a linha sai com a fase', async () => {
    const userData = mkdtempSync(join(tmpdir(), 'perf-driver-'))
    vi.useFakeTimers()
    vi.resetModules()
    vi.stubEnv('CM_PERF', '1')
    const main = await import('../../electron/main/services/perf-probe')
    const lines: string[] = []
    let drain: (phase: string) => unknown = () => undefined
    const stop = main.startPerfProbe({
      app: { getPath: () => userData, getAppMetrics: () => [] } as never,
      ipcMain: {
        on: () => undefined,
        handle: (channel: string, handler: (event: unknown, phase: string) => unknown) => {
          if (channel === 'perf:drain') drain = (phase) => handler({}, phase)
        },
      } as never,
      log: (line) => lines.push(line),
    })
    // A ponte do preload, ligada ao handler que o main registrou de verdade.
    ;(window as unknown as { api: unknown }).api = {
      perf: { drain: async (phase: string) => void drain(phase) },
    }
    await installPerfProbe(page)

    main.perfCount('boot')
    await markPerf(page, 'open')
    main.perfCount('pty:data.chars', 12)
    // Fase mais longa que a janela de 10 s do main: duas linhas na mesma fase.
    vi.advanceTimersByTime(10_000)
    main.perfCount('pty:data.chars', 5)
    await markPerf(page, 'idle')
    main.perfCount('graph.rebuild')
    const raw = await collectPerf(page)
    main.perfCount('depois do fim')
    vi.advanceTimersByTime(10_000)
    stop()
    vi.useRealTimers()
    await new Promise((resolve) => setTimeout(resolve, 50))
    rmSync(userData, { recursive: true, force: true })

    const parsed = parsePerfLines(lines.join('\n'))
    expect(parsed.map((line) => line.phase)).toEqual([undefined, 'open', 'open', 'idle', 'end'])
    const phases = withMainLines(summarizePerf(raw), parsed)
    expect(phases.map((p) => [p.phase, p.main.map((line) => line.counters)])).toEqual([
      ['open', [{ 'pty:data.chars': 12 }, { 'pty:data.chars': 5 }]],
      ['idle', [{ 'graph.rebuild': 1 }]],
    ])
  })
})

describe('typeOpenLoop', () => {
  it('manda cada tecla no horário sem esperar a confirmação da anterior', async () => {
    vi.useFakeTimers()
    const start = Date.now()
    const sent: Array<{ at: number; params: Record<string, unknown> }> = []
    const confirm: Array<() => void> = []
    const typing = typeOpenLoop(
      (_method, params) => {
        sent.push({ at: Date.now() - start, params })
        return new Promise<void>((resolve) => confirm.push(resolve))
      },
      'ab c',
      30,
    )
    let finished = false
    void typing.then(() => (finished = true))

    await vi.advanceTimersByTimeAsync(90)
    // Nenhuma tecla foi confirmada e as quatro já saíram, no ritmo.
    expect(
      sent.filter((s) => s.params.type === 'keyDown').map((s) => [s.at, s.params.text]),
    ).toEqual([
      [0, 'a'],
      [30, 'b'],
      [60, ' '],
      [90, 'c'],
    ])
    expect(sent.filter((s) => s.params.type === 'keyUp')).toHaveLength(4)
    expect(sent[0].params).toMatchObject({ key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 })
    expect(sent[4].params).toMatchObject({ key: ' ', code: 'Space', windowsVirtualKeyCode: 32 })

    // Só termina quando o renderer confirmou tudo: a fase não fecha com tecla na fila.
    await vi.advanceTimersByTimeAsync(5_000)
    expect(finished).toBe(false)
    confirm.forEach((resolve) => resolve())
    expect(await typing).toEqual({
      keys: 4,
      failed: 0,
      sendIntervalMs: { n: 3, measured: 3, p50Ms: 30, p95Ms: 30, maxMs: 30 },
    })
  })

  // 'Key.' com o código 46 seria a tecla Delete: fora de letras, dígitos e espaço
  // vale só o caractere.
  it('maiúsculas e dígitos saem com a tecla deles; pontuação e acento, só com o caractere', async () => {
    const sent: Array<Record<string, unknown>> = []
    await typeOpenLoop(
      (_method, params) => {
        if (params.type === 'keyDown') sent.push(params)
        return Promise.resolve()
      },
      'A7.ç',
      0,
    )
    expect(sent).toEqual([
      {
        type: 'keyDown',
        key: 'A',
        code: 'KeyA',
        windowsVirtualKeyCode: 65,
        text: 'A',
        unmodifiedText: 'A',
      },
      {
        type: 'keyDown',
        key: '7',
        code: 'Digit7',
        windowsVirtualKeyCode: 55,
        text: '7',
        unmodifiedText: '7',
      },
      { type: 'keyDown', key: '.', text: '.', unmodifiedText: '.' },
      { type: 'keyDown', key: 'ç', text: 'ç', unmodifiedText: 'ç' },
    ])
  })

  it('conta as teclas que o CDP recusou em vez de falhar no meio', async () => {
    vi.useFakeTimers()
    const typing = typeOpenLoop(
      (_method, params) =>
        params.type === 'keyDown' && params.text === 'b'
          ? Promise.reject(new Error('Target closed'))
          : Promise.resolve(),
      'abc',
      30,
    )
    await vi.advanceTimersByTimeAsync(60)
    expect(await typing).toMatchObject({ keys: 3, failed: 1 })
  })
})

describe('runPhase', () => {
  it('fase que fecha no prazo sai livre, com o que o coletor juntou', async () => {
    vi.useFakeTimers()
    const outcome = await runPhase(
      'open',
      1000,
      async () => void (await vi.advanceTimersByTimeAsync(400)),
      async () => ({ longTasks: 1 }),
    )
    expect(outcome).toEqual({
      phase: 'open',
      blocked: false,
      elapsedMs: 400,
      collected: { longTasks: 1 },
    })
  })

  it('interação que falha vira fase bloqueada, com o motivo em uma linha e os números do coletor', async () => {
    const outcome = await runPhase(
      'chat-focus',
      1000,
      async () => {
        throw new Error(
          'locator.click: Timeout 30000ms exceeded.\nCall log:\n  \u001b[2m- waiting for element to be stable\u001b[22m\n',
        )
      },
      async () => ({ longTasks: 3, renders: { MarkdownViewer: 18_588 } }),
    )
    expect(outcome).toMatchObject({
      phase: 'chat-focus',
      blocked: true,
      reason:
        'locator.click: Timeout 30000ms exceeded. Call log: - waiting for element to be stable',
      collected: { longTasks: 3, renders: { MarkdownViewer: 18_588 } },
    })
  })

  it('motivo longo fica com o começo (o que falhou) e o fim (o que a ação esperava por último)', async () => {
    const retries = ' - retrying click action - waiting 500ms'.repeat(40)
    const outcome = await runPhase(
      'chat-focus',
      1000,
      async () => {
        throw new Error(
          `locator.click: Timeout 60000ms exceeded.\nCall log:${retries}\n  - <div class="overlay"> intercepts pointer events`,
        )
      },
      async () => null,
    )
    expect(outcome.reason).toMatch(/^locator\.click: Timeout 60000ms exceeded\. Call log: /)
    expect(outcome.reason).toMatch(/ … .*<div class="overlay"> intercepts pointer events$/)
    expect(outcome.reason!.length).toBeLessThanOrEqual(703)
  })

  it('interação que não fecha no prazo vira fase bloqueada, e o coletor é lido depois da espera', async () => {
    vi.useFakeTimers()
    const start = Date.now()
    const longTasks: number[] = []
    const running = runPhase(
      'chat-typing',
      1000,
      () => {
        // O renderer travado: long tasks se acumulam e a interação nunca responde.
        setTimeout(() => longTasks.push(13_000), 900)
        return new Promise<void>(() => {})
      },
      async () => ({ longTasks: [...longTasks], readAt: Date.now() - start }),
    )
    await vi.advanceTimersByTimeAsync(999)
    let settled = false
    void running.then(() => (settled = true))
    await vi.advanceTimersByTimeAsync(0)
    expect(settled).toBe(false)

    await vi.advanceTimersByTimeAsync(10_000)
    const outcome = await running
    expect(outcome.blocked).toBe(true)
    expect(outcome.reason).toBe('a interação não fechou no prazo de 1000 ms da fase')
    expect(outcome.collected.longTasks).toEqual([13_000])
    expect(outcome.collected.readAt).toBeGreaterThanOrEqual(1000)
    expect(outcome.elapsedMs).toBe(outcome.collected.readAt)
  })

  it('dá à interação o que falta do prazo, para o timeout de cada ação', async () => {
    vi.useFakeTimers()
    const left: number[] = []
    await runPhase(
      'to-terminal',
      1000,
      async (remaining) => {
        left.push(remaining())
        await vi.advanceTimersByTimeAsync(300)
        left.push(remaining())
        await vi.advanceTimersByTimeAsync(800)
        // Prazo vencido: nunca 0, que no Playwright quer dizer "sem timeout".
        left.push(remaining())
      },
      async () => null,
    )
    expect(left).toEqual([1000, 700, 1])
  })

  it('a interação abandonada pode falhar depois do prazo sem derrubar o processo', async () => {
    vi.useFakeTimers()
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    const running = runPhase(
      'tab-switch',
      1000,
      () => new Promise<void>((_, reject) => setTimeout(() => reject(new Error('tarde')), 60_000)),
      async () => null,
    )
    await vi.advanceTimersByTimeAsync(10_000)
    expect((await running).blocked).toBe(true)
    await vi.advanceTimersByTimeAsync(60_000)
    vi.useRealTimers()
    await new Promise((resolve) => setTimeout(resolve, 20))
    process.off('unhandledRejection', unhandled)
    expect(unhandled).not.toHaveBeenCalled()
  })
})
