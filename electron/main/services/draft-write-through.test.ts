/** @vitest-environment node */
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { VersionedDraftInput } from '../../../shared/types/composer-draft'

vi.mock('electron', () => ({ app: {} }))

const { openAppDb } = await import('./db')
const { getComposerDraft, saveComposerDraft } = await import('./composer-drafts')
const { createDraftWriteThrough } = await import('./draft-write-through')
const { createDraftPersister } =
  await import('../../../src/features/sessions/composer-draft-persister')

const KEY = 'pane:p-wt'
let dir: string
let dbPath: string
let db: Database.Database
// setImmediate controlado: o teste decide quando o "tick" do main acaba.
let ticks: Array<() => void>
const endTick = () => ticks.splice(0).forEach((fn) => fn())

function draft(text: string, seq: number, writer = 'w1'): VersionedDraftInput {
  return { key: KEY, ccSessionId: 'cc-wt', paneId: 'p-wt', text, attachments: [], writer, seq }
}

// Outra conexão: lê o que está commitado no arquivo, não o estado da conexão do main.
function committedText(): string | null {
  const other = new Database(dbPath, { readonly: true })
  try {
    return getComposerDraft(other, KEY)?.text ?? null
  } finally {
    other.close()
  }
}

function newMain() {
  return createDraftWriteThrough(
    () => db,
    (fn) => ticks.push(fn),
  )
}

beforeEach(() => {
  ticks = []
  dir = mkdtempSync(join(tmpdir(), 'cm-draft-wt-'))
  dbPath = join(dir, 'app.db')
  db = openAppDb(dbPath)
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('write-through do rascunho no main', () => {
  it('a primeira mudança do tick é commitada na hora, sem esperar o tick acabar', () => {
    const main = newMain()
    main.write(draft('a', 1))
    expect(committedText()).toBe('a')
    expect(db.pragma('synchronous', { simple: true })).toBe(1) // NORMAL
  })

  it('mudanças no mesmo tick viram um commit só, com a última versão', () => {
    const main = newMain()
    for (let i = 1; i <= 50; i++) main.write(draft(`v${i}`, i))
    expect(committedText()).toBe('v1')
    endTick()
    expect(committedText()).toBe('v50')
  })

  it('versão antiga do mesmo writer nunca sobrescreve a nova (commitada ou pendente)', () => {
    const main = newMain()
    main.write(draft('v5', 5))
    main.write(draft('v3', 3)) // mesmo tick: pendente
    endTick()
    expect(committedText()).toBe('v5')

    main.write(draft('v4', 4)) // tick novo: borda de subida, mas antiga
    endTick()
    expect(committedText()).toBe('v5')

    main.write(draft('v9', 9))
    main.write(draft('v7', 7))
    endTick()
    expect(committedText()).toBe('v9')
  })

  it('o save FULL drena o pendente e não grava versão mais antiga que a commitada', () => {
    const main = newMain()
    main.write(draft('v1', 1))
    main.write(draft('v2', 2)) // pendente no tick
    main.saveDurable(draft('v1', 1)) // debounce atrasado
    expect(committedText()).toBe('v2')
    main.saveDurable(draft('v2', 2)) // mesma versão: fsync da atual
    expect(committedText()).toBe('v2')
    main.saveDurable(draft('v3', 3))
    expect(committedText()).toBe('v3')
  })

  it('writer novo (remount da pane) vale a partir dele, mesmo com seq menor', () => {
    const main = newMain()
    main.write(draft('antigo 40', 40, 'w1'))
    endTick()
    main.write(draft('novo 1', 1, 'w2'))
    expect(committedText()).toBe('novo 1')
  })

  it('vazio remove, e a remoção também é uma versão', () => {
    const main = newMain()
    main.write(draft('algo', 1))
    endTick()
    main.write(draft('', 2))
    expect(committedText()).toBeNull()
  })

  it('N mudanças rápidas do persister real, intercaladas com debounce e flush, terminam na última', async () => {
    vi.useFakeTimers()
    try {
      const main = newMain()
      const p = createDraftPersister({
        key: KEY,
        ccSessionId: 'cc-wt',
        paneId: 'p-wt',
        delayMs: 5,
        api: {
          get: async (k) => getComposerDraft(db, k),
          getSync: (k) => getComposerDraft(db, k),
          save: async (d) => main.saveDurable(structuredClone(d)),
          saveSync: (d) => main.saveDurable(structuredClone(d)),
          writeThrough: (d) => main.write(structuredClone(d)),
          clear: async () => {},
        },
      })
      await p.hydrate(() => {})
      for (let i = 1; i <= 300; i++) {
        p.update({ text: `v${i}`, attachments: [{ name: 'a.png', path: `/x/${i}.png` }] })
        if (i % 7 === 0) endTick()
        if (i % 11 === 0) await vi.advanceTimersByTimeAsync(5) // debounce FULL no meio
        if (i % 37 === 0) p.flushSync()
      }
      endTick() // fim do tick: o coalescido vai junto
      expect(committedText()).toBe('v300')
      await vi.advanceTimersByTimeAsync(5)
      expect(getComposerDraft(db, KEY)).toMatchObject({
        text: 'v300',
        attachments: [{ name: 'a.png', path: '/x/300.png' }],
      })
      p.dispose()
    } finally {
      vi.useRealTimers()
    }
  })
})

// Custo por mudança: `DRAFT_BENCH_DIR=<dir em disco real> vitest run ...` (o /tmp
// costuma ser tmpfs, onde fsync é de graça e a comparação com FULL não vale).
const benchDir = process.env.DRAFT_BENCH_DIR
describe.runIf(!!benchDir)('bench do rascunho', () => {
  const pct = (xs: number[], p: number) =>
    [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))]
  const fmt = (xs: number[]) =>
    `p50=${pct(xs, 50).toFixed(3)}ms p95=${pct(xs, 95).toFixed(3)}ms max=${Math.max(...xs).toFixed(3)}ms`

  it('write-through (NORMAL) por tecla vs save FULL', async () => {
    const bdir = mkdtempSync(join(benchDir!, 'cm-draft-bench-'))
    const bdb = openAppDb(join(bdir, 'app.db'))
    try {
      const main = createDraftWriteThrough(() => bdb)
      const p = createDraftPersister({
        key: KEY,
        ccSessionId: 'cc-wt',
        paneId: 'p-wt',
        delayMs: 60_000,
        api: {
          get: async (k) => getComposerDraft(bdb, k),
          getSync: (k) => getComposerDraft(bdb, k),
          save: async () => {},
          saveSync: () => {},
          writeThrough: (d) => main.write(structuredClone(d)),
          clear: async () => {},
        },
      })
      await p.hydrate(() => {})
      const N = 500
      let text = 'x'.repeat(2000)
      const fast: number[] = []
      for (let i = 0; i < N; i++) {
        await new Promise((r) => setImmediate(r)) // uma tecla por tick
        text += 'a'
        const t0 = performance.now()
        p.update({ text, attachments: [] })
        fast.push(performance.now() - t0)
      }
      p.dispose()
      const full: number[] = []
      for (let i = 0; i < 200; i++) {
        text += 'b'
        const d = draft(text, i)
        const t0 = performance.now()
        saveComposerDraft(bdb, d)
        full.push(performance.now() - t0)
      }
      console.info(`[bench] write-through NORMAL (update→commit, ${N}x): ${fmt(fast)}`)
      console.info(`[bench] save FULL (fsync, 200x): ${fmt(full)}`)
    } finally {
      bdb.close()
      rmSync(bdir, { recursive: true, force: true })
    }
  }, 60_000)
})
