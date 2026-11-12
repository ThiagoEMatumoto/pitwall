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
// Timing só entrega os lentos (>= 16 ms): os que faltam ocupam os postos mais
// baixos (posto mais próximo) e o percentil que cai num deles sai `null`, não 0.
// Assim "abaixo do limiar" e "nada foi medido" não se confundem com "0 ms".
export function latencyStats(samples: number[], total: number): PerfLatencyStats {
  const sorted = [...samples].sort((a, b) => a - b)
  const measured = sorted.length
  const n = Math.max(total, measured)
  const unmeasured = n - measured
  const at = (p: number): number | null => {
    const index = Math.ceil(p * n) - 1
    return index < unmeasured ? null : roundMs(sorted[index - unmeasured])
  }
  if (n === 0) return { n: 0, measured: 0, p50Ms: null, p95Ms: null, maxMs: null }
  return {
    n,
    measured,
    p50Ms: at(0.5),
    p95Ms: at(0.95),
    maxMs: measured > 0 ? roundMs(sorted[measured - 1]) : null,
  }
}
