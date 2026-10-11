/** @vitest-environment node */
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import * as pty from 'node-pty'
import { describe, it, vi } from 'vitest'
import type { VersionedDraftInput } from '../../../shared/types/composer-draft'

vi.mock('electron', () => ({ app: {} }))

const { openAppDb } = await import('./db')
const { parseVersionedDraftInput } = await import('./composer-drafts')
const { createDraftWriteThrough, DRAFT_COALESCE_MS } = await import('./draft-write-through')

// Custo do write-through na thread do main: `DRAFT_BENCH_DIR=<dir em disco real>
// npx vitest run electron/main/services/draft-write-through.bench.test.ts`. O
// /tmp costuma ser tmpfs, onde fsync (inclusive o do checkpoint do WAL) é de graça.
const benchDir = process.env.DRAFT_BENCH_DIR

const KEYS = 500
const SIZES = [
  ['2KB', 2_000],
  ['1MB', 1_000_000],
] as const
const PTY_BYTES = 64_000_000

const pct = (xs: number[], p: number) =>
  [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))]
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0)
const fmt = (xs: number[]) =>
  `p50=${pct(xs, 50).toFixed(3)}ms p95=${pct(xs, 95).toFixed(3)}ms max=${Math.max(...xs).toFixed(3)}ms`
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const nextTick = () => new Promise((r) => setImmediate(r))

// Simula o main: o raw chega desserializado (structuredClone = o clone do IPC,
// fora do handler) e o handler faz parse + write, como `sessions:write-draft`.
function typist(dir: string, size: number) {
  const db = openAppDb(join(dir, `app-${size}-${Math.random().toString(36).slice(2)}.db`))
  let commits = 0
  // Commits que saem quando a janela fecha: rodam no main, fora do handler.
  const windowClose: number[] = []
  const main = createDraftWriteThrough(
    () => {
      commits++
      return db
    },
    (fn) =>
      setTimeout(() => {
        const t0 = performance.now()
        fn()
        windowClose.push(performance.now() - t0)
      }, DRAFT_COALESCE_MS),
  )
  let text = 'x'.repeat(size)
  let seq = 0
  const handler: number[] = []
  return {
    key() {
      text += 'a'
      const raw: VersionedDraftInput = structuredClone({
        key: 'pane:bench',
        ccSessionId: 'cc-bench',
        paneId: 'bench',
        text,
        attachments: [],
        writer: 'w-bench',
        seq: ++seq,
      })
      const t0 = performance.now()
      main.write(parseVersionedDraftInput(raw))
      handler.push(performance.now() - t0)
    },
    stats: () => ({ handler, commits, windowClose }),
    close() {
      main.drain()
      db.close()
    },
  }
}

async function typeKeys(t: ReturnType<typeof typist>, cadence: 'tick' | number): Promise<void> {
  for (let i = 0; i < KEYS; i++) {
    if (cadence === 'tick') await nextTick()
    else await sleep(cadence)
    t.key()
  }
  await sleep(200) // deixa o coalescido sair antes de contar os commits
}

// PTY real despejando PTY_BYTES; o onData faz o que o main faz no caminho quente
// (conta e repassa o chunk). Devolve bytes/s.
function pumpPty(onTick?: () => void, everyMs = 50): Promise<{ bps: number; maxGap: number }> {
  return new Promise((resolve) => {
    const p = pty.spawn('sh', ['-c', `yes | head -c ${PTY_BYTES}`], { cols: 200, rows: 50 })
    const sink: string[] = []
    let bytes = 0
    const t0 = performance.now()
    let last = t0
    let maxGap = 0
    const timer = onTick ? setInterval(onTick, everyMs) : null
    p.onData((d) => {
      const now = performance.now()
      maxGap = Math.max(maxGap, now - last)
      last = now
      bytes += d.length
      sink[0] = d
    })
    p.onExit(() => {
      if (timer) clearInterval(timer)
      resolve({ bps: bytes / ((performance.now() - t0) / 1000), maxGap })
    })
  })
}

const pump = (r: { bps: number; maxGap: number }) =>
  `${(r.bps / 1e6).toFixed(1)} MB/s (maior pausa entre chunks ${r.maxGap.toFixed(1)}ms)`

describe.runIf(!!benchDir)('bench do write-through no main', () => {
  it('latência do handler por tecla e throughput de PTY', async () => {
    const dir = mkdtempSync(join(benchDir!, 'cm-draft-wt-bench-'))
    try {
      for (const [label, size] of SIZES) {
        for (const cadence of ['tick', 30, 50] as const) {
          const t = typist(dir, size)
          await typeKeys(t, cadence)
          const { handler, commits, windowClose } = t.stats()
          t.close()
          const rate = cadence === 'tick' ? '1/tick' : `${Math.round(1000 / cadence)}/s`
          console.info(
            `[bench] ${label} ${rate} handler (${KEYS}x): ${fmt(handler)} commits=${commits} ` +
              `main total=${(sum(handler) + sum(windowClose)).toFixed(0)}ms`,
          )
        }
      }

      for (let i = 0; i < 2; i++)
        console.info(`[bench] PTY sem digitação: ${pump(await pumpPty())}`)
      for (const [label, size] of SIZES) {
        const t = typist(dir, size)
        const typing = await pumpPty(() => t.key(), 50)
        const { handler, commits } = t.stats()
        t.close()
        console.info(
          `[bench] PTY com digitação ${label} 20/s: ${pump(typing)} handler ${fmt(handler)} commits=${commits}/${handler.length}`,
        )
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 300_000)
})
