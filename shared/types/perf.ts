import { z } from 'zod'

// Contrato da sonda de desempenho (CM_PERF=1). O main emite uma PerfLine a cada
// janela (10 s, ou antes quando um cenário pede o drain), no log (`[perf] {json}`) e em <userData>/perf.jsonl; o renderer manda o
// próprio resumo pelo canal `perf:renderer` (window.api.perf.report) e ele entra
// na linha seguinte. Importe só os TIPOS no renderer: o schema puxa o zod.

/** Durações em ms acumuladas numa janela. */
export interface PerfSpanStats {
  n: number
  totalMs: number
  maxMs: number
}

/**
 * Distribuição de uma latência em ms numa janela. Nem todo evento é medido: o
 * Event Timing só entrega os que passam do limiar (16 ms). `null` num percentil
 * quer dizer "caiu num evento não medido" (abaixo do limiar, ou não houve
 * evento), nunca "0 ms": com `measured` 0 e `n` > 0 nada foi medido na janela.
 */
export interface PerfLatencyStats {
  /** Eventos da janela, medidos ou não. */
  n: number
  /** Quantos tiveram a duração medida (passaram do limiar do observer). */
  measured: number
  p50Ms: number | null
  p95Ms: number | null
  /** Maior duração medida; `null` sem nenhuma amostra medida. */
  maxMs: number | null
}

/**
 * Resumo que o renderer envia ao main por `window.api.perf.report`, um por
 * janela de medição (o renderer zera os acumuladores a cada envio). A cadência
 * sugerida é a do main, 10 s; resumos que chegam na mesma janela do main saem
 * todos na linha, em ordem de chegada. Campo fora deste contrato faz o main
 * descartar o resumo com aviso: mude o tipo e o schema juntos.
 */
export interface PerfRendererSummary {
  /** Duração da janela que o resumo cobre, em ms. */
  windowMs: number
  /** Long tasks da thread principal (PerformanceObserver `longtask`, >= 50 ms). */
  longTasks: PerfSpanStats
  /**
   * Tecla até o próximo paint (Event Timing de `keydown`). O observer só entrega
   * eventos >= 16 ms: `n` é o total de teclas da janela, `measured` as que
   * passaram do limiar, e percentil que cai abaixo dele sai `null`.
   */
  keyToPaint: PerfLatencyStats
  /** Tecla no terminal até a chamada de `sessions.write` (atraso antes do IPC). */
  keyToWrite: PerfLatencyStats
  /** Contadores livres, ex.: renders por componente (`ChatView`, `Composer`). */
  counters: Record<string, number>
  /** Trechos cronometrados, ex.: `tui-parse`, `replay`. Nomes fixos, sem id de sessão. */
  spans: Record<string, PerfSpanStats>
}

/**
 * Acumulado do renderer desde o início da sonda, exposto em `window.__cmPerf`.
 * Não zera a cada janela: o driver e2e lê no começo e no fim de cada fase do
 * cenário e trabalha com a diferença.
 */
export interface PerfRendererTotals {
  counters: Record<string, number>
  spans: Record<string, PerfSpanStats>
}

const spanStatsSchema = z.strictObject({
  n: z.number(),
  totalMs: z.number(),
  maxMs: z.number(),
})

const latencyStatsSchema = z.strictObject({
  n: z.number(),
  measured: z.number(),
  p50Ms: z.number().nullable(),
  p95Ms: z.number().nullable(),
  maxMs: z.number().nullable(),
})

export const perfRendererSummarySchema: z.ZodType<PerfRendererSummary> = z.strictObject({
  windowMs: z.number(),
  longTasks: spanStatsSchema,
  keyToPaint: latencyStatsSchema,
  keyToWrite: latencyStatsSchema,
  counters: z.record(z.string(), z.number()),
  spans: z.record(z.string(), spanStatsSchema),
})

/** Resumo do renderer mais a janela (webContents) que o enviou. */
export interface PerfRendererReport extends PerfRendererSummary {
  webContentsId: number
}

/**
 * Canal de entrada (renderer -> main). `n` conta as chegadas na janela;
 * `totalMs`/`maxMs`, as chamadas que terminaram nela (um invoke assíncrono
 * termina quando a promise resolve).
 */
export interface PerfIpcInStats extends PerfSpanStats {
  /** Média da janela. */
  perSec: number
  /** Maior contagem dentro de um mesmo segundo: digitação é rajada, a média esconde. */
  peakPerSec: number
}

/** Uma janela de medição do main. Chaves de `ipcIn`/`ipcOut` são nomes de canal. */
export interface PerfLine {
  /** Fim da janela, ISO 8601. */
  t: string
  windowMs: number
  /**
   * Fase do cenário e2e que a janela cobre (`window.api.perf.drain`). Ausente
   * fora de cenário e antes da primeira marca.
   */
  phase?: string
  /** Atraso do event loop do main, já descontada a resolução do amostrador. */
  lagMs: { p50: number; p99: number; max: number }
  /** ipcMain.handle / ipcMain.on. */
  ipcIn: Record<string, PerfIpcInStats>
  /** Envios do broadcast() do main (um por chamada, não por janela aberta). */
  ipcOut: Record<string, number>
  /** Ex.: `pty:data.chars`, `broadcastGlobal.sessions`. */
  counters: Record<string, number>
  /** Ex.: `broadcastGlobal`, `graph.rebuild`. */
  spans: Record<string, PerfSpanStats>
  /** app.getAppMetrics() somado por tipo de processo (`Browser`, `Tab`, `GPU`...). */
  cpu: Record<string, { n: number; percent: number }>
  renderer: PerfRendererReport[]
}
