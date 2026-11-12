import type { PerfLatencyStats, PerfSpanStats } from './types/perf'

// Contas da sonda de desempenho usadas dos dois lados: o renderer resume a
// própria janela e o driver e2e resume cada fase do cenário.

export const roundMs = (value: number): number => Math.round(value * 100) / 100

export function spanStats(durations: number[]): PerfSpanStats {
  let totalMs = 0
  let maxMs = 0
  for (const ms of durations) {
    totalMs += ms
    if (ms > maxMs) maxMs = ms
  }
  return { n: durations.length, totalMs: roundMs(totalMs), maxMs: roundMs(maxMs) }
}

// `total` é quantos eventos aconteceram; `samples`, os que foram medidos. O Event
// Timing só entrega os lentos (>= 16 ms), então os que faltam entram como 0 nos
// percentis (posto mais próximo) em vez de sumirem e inflarem a mediana.
export function latencyStats(samples: number[], total: number): PerfLatencyStats {
  const sorted = [...samples].sort((a, b) => a - b)
  const n = Math.max(total, sorted.length)
  const zeros = n - sorted.length
  const at = (p: number): number => {
    const index = Math.ceil(p * n) - 1
    return index < zeros ? 0 : roundMs(sorted[index - zeros])
  }
  if (n === 0) return { n: 0, p50Ms: 0, p95Ms: 0, maxMs: 0 }
  return { n, p50Ms: at(0.5), p95Ms: at(0.95), maxMs: roundMs(sorted.at(-1) ?? 0) }
}
