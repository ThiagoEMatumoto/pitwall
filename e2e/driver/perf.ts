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
// lido em cada marca. Cada marca também pede ao main que feche a janela dele
// (window.api.perf.drain), então as linhas `[perf]` saem etiquetadas pela fase.
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
  // Ausente nos testes sem a ponte do preload; `drain` é no-op sem CM_PERF.
  api?: { perf?: { drain?: (phase: string) => Promise<void> } }
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

async function markInPage(phase: string): Promise<void> {
  const w = window as unknown as DriveWindow
  // Antes da marca: a janela que o main fecha aqui ainda é a da fase anterior.
  await w.api?.perf?.drain?.(phase)
  // Cópia: a sonda continua somando no mesmo objeto depois da marca.
  const totals = w.__cmPerf ? (JSON.parse(JSON.stringify(w.__cmPerf)) as PerfRendererTotals) : null
  w.__cmPerfDrive!.data.marks.push({ phase, t: performance.now(), totals })
}

async function collectInPage(endPhase: string): Promise<PerfRaw> {
  const w = window as unknown as DriveWindow
  const drive = w.__cmPerfDrive!
  // Fecha no main a janela da última fase, que não tem marca seguinte.
  await w.api?.perf?.drain?.(endPhase)
  drive.flush()
  return { ...drive.data, end: { t: performance.now(), totals: w.__cmPerf ?? null } }
}

// O tsx compila com keepNames do esbuild: cada função nomeada dentro das funções
// acima vira __name(fn, 'nome'), um helper do módulo que a página não tem. O
// vitest não liga keepNames, então só o cenário real esbarra nisso.
function shimNameHelperInPage(): void {
  const g = globalThis as { __name?: (fn: unknown) => unknown }
  g.__name ??= (fn) => fn
}

const EVENT_THRESHOLD_MS = 16
// Etiqueta das linhas do main emitidas depois do collectPerf: fora de qualquer fase.
const END_PHASE = 'end'
// Acima disto uma long task bloqueia a entrada (definição do Total Blocking Time).
const BLOCKING_MS = 50

export async function installPerfProbe(page: Page): Promise<void> {
  await page.evaluate(shimNameHelperInPage)
  await page.evaluate(installInPage, EVENT_THRESHOLD_MS)
}

/** Abre uma fase: ela vai até a próxima marca, ou até o collectPerf. */
export async function markPerf(page: Page, phase: string): Promise<void> {
  await page.evaluate(markInPage, phase)
}

export async function collectPerf(page: Page): Promise<PerfRaw> {
  return page.evaluate(collectInPage, END_PHASE)
}

export interface PerfPhaseSummary {
  phase: string
  durationMs: number
  /** `tbtMs`: soma do que cada long task passou de 50 ms. */
  longTasks: PerfSpanStats & { tbtMs: number }
  keyToPaint: PerfLatencyStats
  inputToPaint: PerfLatencyStats
  /**
   * Intervalo entre keydowns consecutivos (event.timeStamp). Em laço aberto fica
   * no ritmo pedido; se esticar, a carga sofreu contrapressão e a latência das
   * teclas está subestimada.
   */
  keyIntervalMs: PerfLatencyStats
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
    const keyTimes = raw.inputs.filter((i) => i.name === 'keydown' && within(i.t)).map((i) => i.t)
    const keyIntervals = keyTimes.slice(1).map((t, i) => t - keyTimes[i])
    return {
      phase: mark.phase,
      durationMs: roundMs(next.t - mark.t),
      longTasks: {
        ...spanStats(tasks),
        tbtMs: roundMs(tasks.reduce((sum, ms) => sum + Math.max(0, ms - BLOCKING_MS), 0)),
      },
      keyToPaint: latency('keydown'),
      inputToPaint: latency('input'),
      keyIntervalMs: latencyStats(keyIntervals, keyIntervals.length),
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

/** Junta a cada fase as linhas do main que o drain do markPerf etiquetou com ela. */
export function withMainLines<T extends { phase: string }>(
  phases: T[],
  lines: PerfLine[],
): Array<T & { main: PerfLine[] }> {
  return phases.map((phase) => ({
    ...phase,
    main: lines.filter((line) => line.phase === phase.phase),
  }))
}

type DispatchKey = (
  method: 'Input.dispatchKeyEvent',
  params: Record<string, unknown>,
) => Promise<unknown>

export interface OpenLoopTyping {
  keys: number
  /** Teclas que o CDP recusou. */
  failed: number
  /** Intervalo entre os envios, do lado do driver: mostra se o timer manteve o ritmo. */
  sendIntervalMs: PerfLatencyStats
}

// Só o que os cenários digitam: letras minúsculas e espaço.
function keyParams(char: string): Record<string, unknown> {
  if (char === ' ') return { key: ' ', code: 'Space', windowsVirtualKeyCode: 32 }
  const upper = char.toUpperCase()
  return { key: char, code: `Key${upper}`, windowsVirtualKeyCode: upper.charCodeAt(0) }
}

/**
 * Digitação em laço ABERTO: cada tecla sai no horário (início + i * everyMs), sem
 * esperar o renderer confirmar a anterior. O page.keyboard.type espera a
 * confirmação, então uma long task segura as teclas seguintes e só uma amostra
 * sai lenta; aqui elas se enfileiram, como as de quem está digitando. `send` é o
 * `send` de uma sessão CDP da página. Resolve quando todas foram confirmadas.
 */
export async function typeOpenLoop(
  send: DispatchKey,
  text: string,
  everyMs: number,
): Promise<OpenLoopTyping> {
  // O desfecho é capturado no envio: uma recusa do CDP no meio da digitação
  // ficaria sem handler até o fim e derrubaria o processo do cenário.
  const keyDowns: Array<Promise<boolean>> = []
  const keyUps: Array<Promise<unknown>> = []
  const settle = (ack: Promise<unknown>): Promise<boolean> =>
    ack.then(
      () => true,
      () => false,
    )
  const sentAt: number[] = []
  const start = Date.now()
  await new Promise<void>((resolve) => {
    const dispatch = (index: number): void => {
      const char = text[index]
      const key = keyParams(char)
      sentAt.push(Date.now())
      keyDowns.push(
        settle(
          send('Input.dispatchKeyEvent', {
            type: 'keyDown',
            ...key,
            text: char,
            unmodifiedText: char,
          }),
        ),
      )
      keyUps.push(settle(send('Input.dispatchKeyEvent', { type: 'keyUp', ...key })))
      if (index + 1 === text.length) return resolve()
      // Pelo horário absoluto: o atraso de um timer não empurra as teclas seguintes.
      setTimeout(() => dispatch(index + 1), Math.max(0, start + (index + 1) * everyMs - Date.now()))
    }
    dispatch(0)
  })
  const [accepted] = await Promise.all([Promise.all(keyDowns), Promise.all(keyUps)])
  const intervals = sentAt.slice(1).map((t, i) => t - sentAt[i])
  return {
    keys: text.length,
    failed: accepted.filter((ok) => !ok).length,
    sendIntervalMs: latencyStats(intervals, intervals.length),
  }
}
