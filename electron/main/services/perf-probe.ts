// Sonda de desempenho do main, atrás de CM_PERF=1. Existe para dar número
// antes/depois a cada otimização: lag do event loop, IPC por canal, trechos
// cronometrados e CPU por tipo de processo, uma linha por janela.
import { appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import type { App, IpcMain, ProcessMetric } from 'electron'
import {
  perfRendererSummarySchema,
  type PerfIpcInStats,
  type PerfLine,
  type PerfRendererReport,
  type PerfSpanStats,
} from '../../../shared/types/perf'

type Env = Record<string, string | undefined>

export function isPerfEnabled(env: Env = process.env): boolean {
  return env.CM_PERF === '1'
}

// Lida uma vez: perfCount/perfOut/perfTime ficam no caminho quente (broadcast de
// pty:data) e, com a flag desligada, custam só este booleano.
const enabled = isPerfEnabled()

interface InStat extends PerfSpanStats {
  second: number
  inSecond: number
  peak: number
}

let counters = new Map<string, number>()
let ipcOut = new Map<string, number>()
let spans = new Map<string, PerfSpanStats>()
let ipcIn = new Map<string, InStat>()

const round = (value: number): number => Math.round(value * 100) / 100

export function perfCount(name: string, by = 1): void {
  if (!enabled) return
  counters.set(name, (counters.get(name) ?? 0) + by)
}

export function perfOut(channel: string): void {
  if (!enabled) return
  ipcOut.set(channel, (ipcOut.get(channel) ?? 0) + 1)
}

export function perfTime<T>(name: string, fn: () => T): T {
  if (!enabled) return fn()
  return timed(fn, (ms) => {
    const span = spanOf(name)
    span.n += 1
    addDuration(span, ms)
  })
}

function timed<T>(fn: () => T, done: (ms: number) => void): T {
  const start = performance.now()
  const finish = (): void => done(performance.now() - start)
  let result: T
  try {
    result = fn()
  } catch (err) {
    finish()
    throw err
  }
  if (result instanceof Promise) return result.finally(finish) as T
  finish()
  return result
}

function spanOf(name: string): PerfSpanStats {
  let span = spans.get(name)
  if (!span) {
    span = { n: 0, totalMs: 0, maxMs: 0 }
    spans.set(name, span)
  }
  return span
}

function addDuration(stat: PerfSpanStats, ms: number): void {
  stat.totalMs += ms
  if (ms > stat.maxMs) stat.maxMs = ms
}

function inStatOf(channel: string): InStat {
  let stat = ipcIn.get(channel)
  if (!stat) {
    stat = { n: 0, totalMs: 0, maxMs: 0, second: 0, inSecond: 0, peak: 0 }
    ipcIn.set(channel, stat)
  }
  return stat
}

function arrive(channel: string): void {
  const stat = inStatOf(channel)
  const second = Math.floor(Date.now() / 1000)
  if (second !== stat.second) {
    stat.second = second
    stat.inSecond = 0
  }
  stat.n += 1
  stat.inSecond += 1
  if (stat.inSecond > stat.peak) stat.peak = stat.inSecond
}

type IpcListener = (event: never, ...args: never[]) => unknown

function measured(channel: string, listener: IpcListener): IpcListener {
  return (event, ...args) => {
    arrive(channel)
    // inStatOf de novo no fim: a chamada pode terminar numa janela posterior.
    return timed(
      () => listener(event, ...args),
      (ms) => addDuration(inStatOf(channel), ms),
    )
  }
}

// Só mede o que for registrado DEPOIS da chamada.
export function instrumentIpcMain(ipc: Pick<IpcMain, 'handle' | 'on'>): void {
  const handle = ipc.handle.bind(ipc) as (channel: string, listener: IpcListener) => void
  const on = ipc.on.bind(ipc) as (channel: string, listener: IpcListener) => unknown
  const target = ipc as unknown as {
    handle: (channel: string, listener: IpcListener) => void
    on: (channel: string, listener: IpcListener) => unknown
  }
  target.handle = (channel, listener) => handle(channel, measured(channel, listener))
  target.on = (channel, listener) => {
    on(channel, measured(channel, listener))
    return ipc
  }
}

export function drainPerfWindow(
  windowMs: number,
): Pick<PerfLine, 'ipcIn' | 'ipcOut' | 'counters' | 'spans'> {
  const seconds = windowMs / 1000
  const window = {
    ipcIn: Object.fromEntries(
      [...ipcIn].map(([channel, s]): [string, PerfIpcInStats] => [
        channel,
        {
          n: s.n,
          perSec: round(s.n / seconds),
          peakPerSec: s.peak,
          totalMs: round(s.totalMs),
          maxMs: round(s.maxMs),
        },
      ]),
    ),
    ipcOut: Object.fromEntries(ipcOut),
    counters: Object.fromEntries(counters),
    spans: Object.fromEntries(
      [...spans].map(([name, s]): [string, PerfSpanStats] => [
        name,
        { n: s.n, totalMs: round(s.totalMs), maxMs: round(s.maxMs) },
      ]),
    ),
  }
  counters = new Map()
  ipcOut = new Map()
  spans = new Map()
  ipcIn = new Map()
  return window
}

function cpuByType(metrics: ProcessMetric[]): PerfLine['cpu'] {
  const byType: PerfLine['cpu'] = {}
  for (const metric of metrics) {
    const current = byType[metric.type] ?? { n: 0, percent: 0 }
    byType[metric.type] = {
      n: current.n + 1,
      percent: round(current.percent + metric.cpu.percentCPUUsage),
    }
  }
  return byType
}

const LAG_RESOLUTION_MS = 10
const WINDOW_MS = 10_000

interface PerfProbeDeps {
  app: Pick<App, 'getPath' | 'getAppMetrics'>
  ipcMain: Pick<IpcMain, 'on'>
  log?: (line: string) => void
}

export function startPerfProbe({ app, ipcMain, log = console.log }: PerfProbeDeps): () => void {
  const file = join(app.getPath('userData'), 'perf.jsonl')
  const lag = monitorEventLoopDelay({ resolution: LAG_RESOLUTION_MS })
  lag.enable()
  // O histograma guarda o intervalo entre disparos do timer (resolução + atraso):
  // ocioso ele marca ~10 ms, então o atraso é o que passa da resolução.
  const lagMs = (nanos: number): number => round(Math.max(0, nanos / 1e6 - LAG_RESOLUTION_MS))
  // percentCPUUsage é relativo à chamada anterior: esta abre a primeira janela.
  app.getAppMetrics()

  let reports: PerfRendererReport[] = []
  ipcMain.on('perf:renderer', (event, raw: unknown) => {
    const parsed = perfRendererSummarySchema.safeParse(raw)
    if (!parsed.success) {
      console.warn('[perf] resumo do renderer fora do contrato:', parsed.error.message)
      return
    }
    reports.push({ webContentsId: event.sender.id, ...parsed.data })
  })

  let writes = Promise.resolve()
  let windowStart = Date.now()
  const timer = setInterval(() => {
    const now = Date.now()
    const windowMs = now - windowStart
    windowStart = now
    const line: PerfLine = {
      t: new Date(now).toISOString(),
      windowMs,
      lagMs: {
        p50: lagMs(lag.percentile(50)),
        p99: lagMs(lag.percentile(99)),
        max: lagMs(lag.max),
      },
      ...drainPerfWindow(windowMs),
      cpu: cpuByType(app.getAppMetrics()),
      renderer: reports,
    }
    lag.reset()
    reports = []
    const json = JSON.stringify(line)
    log(`[perf] ${json}`)
    // Encadeado: dois appendFile soltos não garantem a ordem das linhas.
    writes = writes
      .then(() => appendFile(file, `${json}\n`))
      .catch((err) => console.warn('[perf] falha ao gravar perf.jsonl:', String(err)))
  }, WINDOW_MS)
  timer.unref()

  return () => {
    clearInterval(timer)
    lag.disable()
  }
}
