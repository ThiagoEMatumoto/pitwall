/** @vitest-environment node */
import { describe, expect, it } from 'vitest'
import { latencyStats, spanStats } from './perf-stats'

describe('latencyStats', () => {
  it('sem evento nenhum: nada medido, percentis nulos', () => {
    expect(latencyStats([], 0)).toEqual({
      n: 0,
      measured: 0,
      p50Ms: null,
      p95Ms: null,
      maxMs: null,
    })
  })

  it('percentis por posto mais próximo, fora de ordem', () => {
    const samples = [90, 10, 50, 30, 70, 20, 100, 40, 80, 60]
    expect(latencyStats(samples, 10)).toEqual({
      n: 10,
      measured: 10,
      p50Ms: 50,
      p95Ms: 100,
      maxMs: 100,
    })
  })

  it('percentil que cai num evento não medido (abaixo do limiar) sai null, não 0', () => {
    // 20 teclas, só 2 passaram de 16 ms: a mediana não foi medida, o p95 cai na 19ª.
    expect(latencyStats([24, 40], 20)).toEqual({
      n: 20,
      measured: 2,
      p50Ms: null,
      p95Ms: 24,
      maxMs: 40,
    })
  })

  it('eventos sem nenhuma amostra medida não se confundem com fase rápida', () => {
    // Observer que não entregou nada: 20 teclas vistas, zero medidas.
    expect(latencyStats([], 20)).toEqual({
      n: 20,
      measured: 0,
      p50Ms: null,
      p95Ms: null,
      maxMs: null,
    })
  })

  it('uma amostra de 0 ms medida de fato continua sendo 0', () => {
    expect(latencyStats([0, 0], 2)).toEqual({ n: 2, measured: 2, p50Ms: 0, p95Ms: 0, maxMs: 0 })
  })

  it('mais amostras que o total informado: vale o número de amostras', () => {
    expect(latencyStats([16, 32, 48], 1)).toEqual({
      n: 3,
      measured: 3,
      p50Ms: 32,
      p95Ms: 48,
      maxMs: 48,
    })
  })
})

describe('spanStats', () => {
  it('soma, conta e guarda o máximo, arredondando a 2 casas', () => {
    expect(spanStats([60.004, 120.5])).toEqual({ n: 2, totalMs: 180.5, maxMs: 120.5 })
    expect(spanStats([])).toEqual({ n: 0, totalMs: 0, maxMs: 0 })
  })
})
