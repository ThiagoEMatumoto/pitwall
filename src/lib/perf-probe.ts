// Sonda de desempenho do renderer, atrás de CM_PERF=1 (window.api.perf.enabled).
// Conta renders, cronometra trechos e observa long tasks e latência de tecla; a
// cada janela manda um resumo ao main, que o publica na linha `[perf]` dele.
import { latencyStats, roundMs, spanStats } from '../../shared/perf-stats'
import type {
  PerfRendererSummary,
  PerfRendererTotals,
  PerfSpanStats,
} from '../../shared/types/perf'

declare global {
  interface Window {
    __cmPerf?: PerfRendererTotals
  }
}

// Lida uma vez: perfCount fica no corpo de componentes e, com a flag desligada,
// custa só este booleano. O `?.` cobre os testes de componente, sem window.api.
const enabled = window.api?.perf?.enabled === true

const WINDOW_MS = 10_000
// Mínimo que o Event Timing aceita; o padrão do Chromium (104 ms) esconderia
// quase toda tecla lenta.
const EVENT_THRESHOLD_MS = 16

let counters: Record<string, number> = {}
let spans: Record<string, PerfSpanStats> = {}
let longTasks: number[] = []
let keydowns = 0
let keyToPaint: number[] = []
let keyToWrite: number[] = []
let pendingKeyAt: number | null = null
const totals: PerfRendererTotals = { counters: {}, spans: {} }

export function perfCount(name: string, by = 1): void {
  if (!enabled) return
  counters[name] = (counters[name] ?? 0) + by
  totals.counters[name] = (totals.counters[name] ?? 0) + by
}

/** Início de um trecho que termina em outro lugar (callback); 0 com a flag desligada. */
export function perfStart(): number {
  return enabled ? performance.now() : 0
}

export function perfEnd(name: string, startedAt: number): void {
  if (!enabled) return
  const ms = performance.now() - startedAt
  addDuration(spans, name, ms)
  addDuration(totals.spans, name, ms)
}

export function perfTime<T>(name: string, fn: () => T): T {
  if (!enabled) return fn()
  const startedAt = performance.now()
  try {
    return fn()
  } finally {
    perfEnd(name, startedAt)
  }
}

/** Chamado onde a tecla do terminal vira `sessions.write`: fecha a medida tecla→write. */
export function perfKeyWrite(): void {
  if (!enabled || pendingKeyAt == null) return
  keyToWrite.push(performance.now() - pendingKeyAt)
  pendingKeyAt = null
}

function addDuration(into: Record<string, PerfSpanStats>, name: string, ms: number): void {
  const span = (into[name] ??= { n: 0, totalMs: 0, maxMs: 0 })
  span.n += 1
  span.totalMs += ms
  if (ms > span.maxMs) span.maxMs = ms
}

function drain(windowMs: number): PerfRendererSummary {
  const summary: PerfRendererSummary = {
    windowMs,
    longTasks: spanStats(longTasks),
    keyToPaint: latencyStats(keyToPaint, keydowns),
    keyToWrite: latencyStats(keyToWrite, keyToWrite.length),
    counters,
    spans: Object.fromEntries(
      Object.entries(spans).map(([name, s]): [string, PerfSpanStats] => [
        name,
        { n: s.n, totalMs: roundMs(s.totalMs), maxMs: roundMs(s.maxMs) },
      ]),
    ),
  }
  counters = {}
  spans = {}
  longTasks = []
  keydowns = 0
  keyToPaint = []
  keyToWrite = []
  return summary
}

function observe(init: PerformanceObserverInit, onEntry: (entry: PerformanceEntry) => void): void {
  new PerformanceObserver((list) => list.getEntries().forEach(onEntry)).observe(init)
}

export function startPerfProbe(): void {
  if (!enabled) return
  window.__cmPerf = totals

  observe({ type: 'longtask' }, (entry) => longTasks.push(entry.duration))
  observe(
    // durationThreshold ainda não está no lib.dom do TypeScript.
    { type: 'event', durationThreshold: EVENT_THRESHOLD_MS } as PerformanceObserverInit,
    (entry) => {
      if (entry.name === 'keydown') keyToPaint.push(entry.duration)
    },
  )

  window.addEventListener(
    'keydown',
    (event) => {
      keydowns += 1
      // timeStamp é a hora do evento, não a do handler: o que a thread ocupada
      // atrasou antes de chegar aqui entra na medida.
      if ((event.target as Element | null)?.closest?.('.xterm')) pendingKeyAt = event.timeStamp
    },
    true,
  )
  // Tecla que não gerou write (atalho do app) não pode casar com um onData
  // posterior que não veio do teclado, como a resposta do xterm a uma query.
  window.addEventListener('keyup', () => (pendingKeyAt = null), true)

  let windowStart = Date.now()
  setInterval(() => {
    const now = Date.now()
    window.api.perf.report(drain(now - windowStart))
    windowStart = now
  }, WINDOW_MS)
}
