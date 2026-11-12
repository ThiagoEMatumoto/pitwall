import type { Page } from 'playwright'
import { latencyStats, roundMs, spanStats } from '../../shared/perf-stats'
import type {
  PerfLatencyStats,
  PerfLine,
  PerfRendererTotals,
  PerfSpanStats,
} from '../../shared/types/perf'

// Medição do renderer por FASE de um cenário drive-app. A sonda do app (CM_PERF=1)
// resume em janelas fixas de 10 s; aqui o coletor guarda as entradas brutas com
// timestamp e o cenário marca o começo de cada fase, então o resumo sai recortado
// pela fase. Os contadores de render vêm do acumulado da sonda (window.__cmPerf),
// lido em cada marca.
//
// No terminal o eco da tecla volta por pty:data, fora do evento: `keyToPaint` ali
// cobre o handler e o paint seguinte, não o caractere na tela.

/** O que o coletor instalado na página guarda. Tempos em ms de performance.now(). */
export interface PerfRaw {
  marks: Array<{ phase: string; t: number; totals: PerfRendererTotals | null }>
  longTasks: Array<{ start: number; duration: number }>
  /** Event Timing de keydown/input; só os que passaram do limiar de 16 ms. */
  events: Array<{ name: string; start: number; duration: number }>
  /** Todo keydown/input visto (capture), para contar os que ficaram abaixo do limiar. */
  inputs: Array<{ name: string; t: number }>
  end: { t: number; totals: PerfRendererTotals | null }
}

type Collected = Omit<PerfRaw, 'end'>
interface DriveWindow {
  __cmPerf?: PerfRendererTotals
  __cmPerfDrive?: { data: Collected; flush: () => void }
}

// As três funções abaixo rodam DENTRO da página (page.evaluate serializa o corpo):
// não podem usar nada do escopo deste módulo.

function installInPage(thresholdMs: number): void {
  const w = window as unknown as DriveWindow
  if (w.__cmPerfDrive) return
  const data: Collected = { marks: [], longTasks: [], events: [], inputs: [] }
  const onLongTask = (entry: PerformanceEntry): void => {
    data.longTasks.push({ start: entry.startTime, duration: entry.duration })
  }
  const onEvent = (entry: PerformanceEntry): void => {
    if (entry.name !== 'keydown' && entry.name !== 'input') return
    data.events.push({ name: entry.name, start: entry.startTime, duration: entry.duration })
  }
  const longTasks = new PerformanceObserver((list) => list.getEntries().forEach(onLongTask))
  longTasks.observe({ type: 'longtask' })
  const events = new PerformanceObserver((list) => list.getEntries().forEach(onEvent))
  events.observe({ type: 'event', durationThreshold: thresholdMs } as PerformanceObserverInit)
  for (const name of ['keydown', 'input']) {
    window.addEventListener(name, (event) => data.inputs.push({ name, t: event.timeStamp }), true)
  }
  w.__cmPerfDrive = {
    data,
    flush: () => {
      longTasks.takeRecords().forEach(onLongTask)
      events.takeRecords().forEach(onEvent)
    },
  }
}

function markInPage(phase: string): void {
  const w = window as unknown as DriveWindow
  // Cópia: a sonda continua somando no mesmo objeto depois da marca.
  const totals = w.__cmPerf ? (JSON.parse(JSON.stringify(w.__cmPerf)) as PerfRendererTotals) : null
  w.__cmPerfDrive!.data.marks.push({ phase, t: performance.now(), totals })
}

function collectInPage(): PerfRaw {
  const w = window as unknown as DriveWindow
  const drive = w.__cmPerfDrive!
  drive.flush()
  return { ...drive.data, end: { t: performance.now(), totals: w.__cmPerf ?? null } }
}

const EVENT_THRESHOLD_MS = 16
// Acima disto uma long task bloqueia a entrada (definição do Total Blocking Time).
const BLOCKING_MS = 50

export async function installPerfProbe(page: Page): Promise<void> {
  await page.evaluate(installInPage, EVENT_THRESHOLD_MS)
}

/** Abre uma fase: ela vai até a próxima marca, ou até o collectPerf. */
export async function markPerf(page: Page, phase: string): Promise<void> {
  await page.evaluate(markInPage, phase)
}

export async function collectPerf(page: Page): Promise<PerfRaw> {
  return page.evaluate(collectInPage)
}

export interface PerfPhaseSummary {
  phase: string
  durationMs: number
  /** `tbtMs`: soma do que cada long task passou de 50 ms. */
  longTasks: PerfSpanStats & { tbtMs: number }
  keyToPaint: PerfLatencyStats
  inputToPaint: PerfLatencyStats
  /** Diferença do acumulado da sonda do app na fase; só o que mudou. */
  counters: Record<string, number>
  spans: Record<string, { n: number; totalMs: number }>
}

export function summarizePerf(raw: PerfRaw): PerfPhaseSummary[] {
  return raw.marks.map((mark, index) => {
    const next = raw.marks[index + 1] ?? raw.end
    const within = (t: number): boolean => t >= mark.t && t < next.t
    const tasks = raw.longTasks.filter((task) => within(task.start)).map((task) => task.duration)
    const latency = (name: string): PerfLatencyStats =>
      latencyStats(
        raw.events.filter((e) => e.name === name && within(e.start)).map((e) => e.duration),
        raw.inputs.filter((i) => i.name === name && within(i.t)).length,
      )
    return {
      phase: mark.phase,
      durationMs: roundMs(next.t - mark.t),
      longTasks: {
        ...spanStats(tasks),
        tbtMs: roundMs(tasks.reduce((sum, ms) => sum + Math.max(0, ms - BLOCKING_MS), 0)),
      },
      keyToPaint: latency('keydown'),
      inputToPaint: latency('input'),
      ...totalsDelta(mark.totals, next.totals),
    }
  })
}

function totalsDelta(
  from: PerfRendererTotals | null,
  to: PerfRendererTotals | null,
): Pick<PerfPhaseSummary, 'counters' | 'spans'> {
  const counters: PerfPhaseSummary['counters'] = {}
  const spans: PerfPhaseSummary['spans'] = {}
  for (const [name, value] of Object.entries(to?.counters ?? {})) {
    const delta = value - (from?.counters[name] ?? 0)
    if (delta > 0) counters[name] = delta
  }
  for (const [name, span] of Object.entries(to?.spans ?? {})) {
    const before = from?.spans[name]
    const n = span.n - (before?.n ?? 0)
    if (n > 0) spans[name] = { n, totalMs: roundMs(span.totalMs - (before?.totalMs ?? 0)) }
  }
  return { counters, spans }
}

/** Linhas `[perf] {json}` do main no log capturado (mainOutput() do launchApp). */
export function parsePerfLines(log: string): PerfLine[] {
  const lines: PerfLine[] = []
  for (const line of log.split('\n')) {
    const at = line.indexOf('[perf] {')
    if (at < 0) continue
    try {
      lines.push(JSON.parse(line.slice(at + '[perf] '.length)) as PerfLine)
    } catch {
      // linha cortada no meio pelo fim do processo
    }
  }
  return lines
}
