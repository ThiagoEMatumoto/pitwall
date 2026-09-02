import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkerRequest, WorkerResponse, WorkerTurn } from './diarizer-worker'
import {
  createDiarizer,
  fixtureTurns,
  loadDiarizeFixture,
  type DiarizerDeps,
  type DiarizerStore,
  type DiarizerWorkerHandle,
} from './speaker-diarizer'

vi.mock('electron', () => ({ utilityProcess: { fork: vi.fn() } }))

const DIM = 4
function emb(i: number): number[] {
  const v = new Array<number>(DIM).fill(0)
  v[i] = 1
  return v
}
function turn(startMs: number, endMs: number, spk: number): WorkerTurn {
  return { startMs, endMs, localSpeaker: spk, embedding: emb(spk) }
}
function pcm(seconds: number): Buffer {
  return Buffer.alloc(seconds * 16000 * 2)
}

// Worker fake: responde init como ready e cada diarize via `reply`, que o
// teste controla (sincrono, atrasado, nunca, crash).
interface FakeWorker extends DiarizerWorkerHandle {
  requests: WorkerRequest[]
  emit(msg: WorkerResponse): void
  exit(code: number): void
  killed: boolean
}

function makeWorker(
  reply: (id: number, pcm: Uint8Array, w: FakeWorker) => WorkerTurn[] | 'never' | 'error' = () => [],
  initStatus: 'ready' | 'unavailable' = 'ready',
): FakeWorker {
  let onMessage: (msg: WorkerResponse) => void = () => {}
  let onExit: (code: number) => void = () => {}
  const w: FakeWorker = {
    requests: [],
    killed: false,
    emit: (msg) => onMessage(msg),
    exit: (code) => onExit(code),
    onMessage: (cb) => {
      onMessage = cb
    },
    onExit: (cb) => {
      onExit = cb
    },
    kill: () => {
      w.killed = true
    },
    post: (msg) => {
      w.requests.push(msg)
      if (msg.type === 'init') {
        queueMicrotask(() =>
          onMessage({ type: 'status', status: initStatus, error: initStatus === 'unavailable' ? 'sem modelo' : null, dim: DIM }),
        )
      } else if (msg.type === 'diarize') {
        const r = reply(msg.id, msg.pcm, w)
        if (r === 'never') return
        queueMicrotask(() =>
          onMessage(r === 'error' ? { type: 'result', id: msg.id, error: 'boom' } : { type: 'result', id: msg.id, turns: r }),
        )
      }
    },
  }
  return w
}

function makeStore(): DiarizerStore & { speakers: Map<string, { meetingId: string; label: string; voiceId: string | null; turnCount: number }> } {
  const speakers = new Map<string, { meetingId: string; label: string; voiceId: string | null; turnCount: number }>()
  return {
    speakers,
    upsertSpeaker: vi.fn((s) => {
      speakers.set(s.id, { meetingId: s.meetingId, label: s.label, voiceId: s.voiceId, turnCount: s.turnCount })
    }),
    updateSpeaker: vi.fn((s) => {
      const cur = speakers.get(s.id)!
      speakers.set(s.id, { ...cur, turnCount: s.turnCount })
    }),
    listVoices: vi.fn(() => []),
  }
}

function baseDeps(overrides: Partial<DiarizerDeps> = {}): DiarizerDeps {
  return {
    fixture: null,
    addonAvailable: () => true,
    addonError: () => null,
    models: () => ({ segmentation: '/seg', embedding: '/emb' }),
    log: vi.fn(),
    env: {},
    ...overrides,
  }
}

const tmpDirs: string[] = []
afterEach(() => {
  vi.useRealTimers()
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('status', () => {
  it('off quando desabilitado; unavailable sem addon ou sem modelos', () => {
    expect(createDiarizer(baseDeps({ enabled: false })).status()).toBe('off')
    const noAddon = createDiarizer(baseDeps({ addonAvailable: () => false, addonError: () => 'sem .node' }))
    expect(noAddon.status()).toBe('unavailable')
    const noModel = createDiarizer(baseDeps({ models: () => ({ segmentation: '/seg', embedding: null }) }))
    expect(noModel.status()).toBe('unavailable')
  })

  it('loading antes do worker subir, on depois do warmup', async () => {
    const spawnWorker = vi.fn(() => makeWorker())
    const d = createDiarizer(baseDeps({ spawnWorker }))
    expect(d.status()).toBe('loading')
    expect(spawnWorker).not.toHaveBeenCalled()
    await d.warmup()
    expect(spawnWorker).toHaveBeenCalledTimes(1)
    expect(d.status()).toBe('on')
  })

  it('worker que responde unavailable no init derruba pra unavailable e chunks viram []', async () => {
    const d = createDiarizer(baseDeps({ spawnWorker: () => makeWorker(() => [], 'unavailable') }))
    expect(await d.process({ meetingId: 'm', chunkIndex: 0, pcm: pcm(1), startMs: 0 })).toEqual([])
    expect(d.status()).toBe('unavailable')
  })
})

describe('worker + clustering + persistência', () => {
  it('fork lazy no primeiro chunk; turnos viram speakers persistidos e reaproveitados entre chunks', async () => {
    const store = makeStore()
    const spawnWorker = vi.fn(() => makeWorker(() => [turn(0, 3000, 0), turn(3500, 6000, 1), turn(6200, 9000, 0)]))
    const d = createDiarizer(baseDeps({ spawnWorker, store }))

    const first = await d.process({ meetingId: 'm1', chunkIndex: 0, pcm: pcm(12), startMs: 0 })
    expect(spawnWorker).toHaveBeenCalledTimes(1)
    expect(first.map((t) => t.speakerLabel)).toEqual(['Participante 1', 'Participante 2', 'Participante 1'])
    expect(first[0].speakerId).toBe(first[2].speakerId)
    expect(first[0].speakerId).not.toBe(first[1].speakerId)
    expect(first[0]).toMatchObject({ startMs: 0, endMs: 3000 })
    expect(store.upsertSpeaker).toHaveBeenCalledTimes(2)
    expect(store.speakers.get(first[0].speakerId)).toMatchObject({ meetingId: 'm1', label: 'Participante 1', turnCount: 2 })

    const second = await d.process({ meetingId: 'm1', chunkIndex: 1, pcm: pcm(12), startMs: 12000 })
    expect(spawnWorker).toHaveBeenCalledTimes(1)
    expect(second[0].speakerId).toBe(first[0].speakerId)
    expect(store.upsertSpeaker).toHaveBeenCalledTimes(2)
    expect(store.updateSpeaker).toHaveBeenCalled()
    expect(store.speakers.get(first[0].speakerId)?.turnCount).toBe(4)
    expect(store.listVoices).toHaveBeenCalledTimes(1)
  })

  it('reset(meetingId) recomeça a numeração; reuniões diferentes não se misturam', async () => {
    const d = createDiarizer(baseDeps({ spawnWorker: () => makeWorker(() => [turn(0, 2000, 2)]) }))
    const a = await d.process({ meetingId: 'a', chunkIndex: 0, pcm: pcm(2), startMs: 0 })
    const b = await d.process({ meetingId: 'b', chunkIndex: 0, pcm: pcm(2), startMs: 0 })
    expect(a[0].speakerId).not.toBe(b[0].speakerId)
    d.reset('a')
    const a2 = await d.process({ meetingId: 'a', chunkIndex: 1, pcm: pcm(2), startMs: 0 })
    expect(a2[0].speakerId).not.toBe(a[0].speakerId)
    expect(a2[0].speakerLabel).toBe('Participante 1')
  })

  it('speaker novo que casa com voz conhecida nasce com o nome e voiceId', async () => {
    const store = makeStore()
    store.listVoices = vi.fn(() => [{ id: 'v-ana', name: 'Ana', embedding: Float32Array.from(emb(1)) }])
    const d = createDiarizer(baseDeps({ spawnWorker: () => makeWorker(() => [turn(0, 2000, 1), turn(2000, 4000, 0)]), store }))
    const turns = await d.process({ meetingId: 'm', chunkIndex: 0, pcm: pcm(4), startMs: 0 })
    expect(turns.map((t) => t.speakerLabel)).toEqual(['Ana', 'Participante 2'])
    expect(store.speakers.get(turns[0].speakerId)).toMatchObject({ label: 'Ana', voiceId: 'v-ana' })
  })

  it('turno curto sem cluster parecido herda o último speaker do chunk; no início é descartado', async () => {
    const d = createDiarizer(
      baseDeps({ spawnWorker: () => makeWorker(() => [turn(0, 400, 3), turn(500, 3000, 0), turn(3100, 3500, 1)]) }),
    )
    const turns = await d.process({ meetingId: 'm', chunkIndex: 0, pcm: pcm(4), startMs: 0 })
    expect(turns).toHaveLength(2)
    expect(turns[0].startMs).toBe(500)
    expect(turns[1].speakerId).toBe(turns[0].speakerId)
  })

  it('erro do store não derruba o chunk', async () => {
    const store = makeStore()
    store.upsertSpeaker = vi.fn(() => {
      throw new Error('db locked')
    })
    const log = vi.fn()
    const d = createDiarizer(baseDeps({ spawnWorker: () => makeWorker(() => [turn(0, 2000, 0)]), store, log }))
    const turns = await d.process({ meetingId: 'm', chunkIndex: 0, pcm: pcm(2), startMs: 0 })
    expect(turns).toHaveLength(1)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('db locked'))
  })
})

describe('fila, timeout e crash', () => {
  it('backpressure: com 3 pendentes o excedente resolve [] e loga uma vez', async () => {
    const log = vi.fn()
    let release: (() => void)[] = []
    const w = makeWorker((id) => {
      release.push(() => w.emit({ type: 'result', id, turns: [turn(0, 2000, 0)] }))
      return 'never'
    })
    const d = createDiarizer(baseDeps({ spawnWorker: () => w, log, maxPending: 3 }))
    const ps = [0, 1, 2, 3, 4].map((i) => d.process({ meetingId: 'm', chunkIndex: i, pcm: pcm(2), startMs: 0 }))
    expect(await ps[3]).toEqual([])
    expect(await ps[4]).toEqual([])
    expect(log).toHaveBeenCalledTimes(1)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('fila cheia'))
    // o worker é sequencial: só o primeiro diarize foi enviado
    await Promise.resolve()
    expect(w.requests.filter((r) => r.type === 'diarize')).toHaveLength(1)
    while (release.length) {
      release.shift()!()
      await new Promise((r) => setTimeout(r, 0))
    }
    for (const p of ps.slice(0, 3)) expect(await p).toHaveLength(1)
    expect(w.requests.filter((r) => r.type === 'diarize')).toHaveLength(3)
  })

  it('timeout por chunk resolve [], mata o worker e o próximo chunk respawna', async () => {
    vi.useFakeTimers()
    const log = vi.fn()
    const workers: FakeWorker[] = []
    const spawnWorker = vi.fn(() => {
      const w = makeWorker(() => (workers.length === 1 ? 'never' : [turn(0, 2000, 0)]))
      workers.push(w)
      return w
    })
    const d = createDiarizer(baseDeps({ spawnWorker, log, timeoutMs: 100 }))
    const p = d.process({ meetingId: 'm', chunkIndex: 0, pcm: pcm(2), startMs: 0 })
    await vi.advanceTimersByTimeAsync(150)
    expect(await p).toEqual([])
    expect(workers[0].killed).toBe(true)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('excedeu 100 ms'))

    const p2 = d.process({ meetingId: 'm', chunkIndex: 1, pcm: pcm(2), startMs: 0 })
    await vi.advanceTimersByTimeAsync(10)
    expect(await p2).toHaveLength(1)
    expect(spawnWorker).toHaveBeenCalledTimes(2)
    expect(d.status()).toBe('on')
  })

  it('crash do worker: chunk em voo resolve [], respawn 1×; 2º crash → unavailable', async () => {
    const workers: FakeWorker[] = []
    const spawnWorker = vi.fn(() => {
      const w = makeWorker(() => 'never')
      workers.push(w)
      return w
    })
    const d = createDiarizer(baseDeps({ spawnWorker, maxRestarts: 1 }))

    const p1 = d.process({ meetingId: 'm', chunkIndex: 0, pcm: pcm(2), startMs: 0 })
    await new Promise((r) => setTimeout(r, 0))
    workers[0].exit(139)
    expect(await p1).toEqual([])
    expect(d.status()).toBe('loading')

    const p2 = d.process({ meetingId: 'm', chunkIndex: 1, pcm: pcm(2), startMs: 0 })
    await new Promise((r) => setTimeout(r, 0))
    expect(spawnWorker).toHaveBeenCalledTimes(2)
    workers[1].exit(139)
    expect(await p2).toEqual([])
    expect(d.status()).toBe('unavailable')

    expect(await d.process({ meetingId: 'm', chunkIndex: 2, pcm: pcm(2), startMs: 0 })).toEqual([])
    expect(spawnWorker).toHaveBeenCalledTimes(2)
  })

  it('erro reportado pelo worker no chunk resolve [] e não reinicia', async () => {
    const spawnWorker = vi.fn(() => makeWorker(() => 'error'))
    const log = vi.fn()
    const d = createDiarizer(baseDeps({ spawnWorker, log }))
    expect(await d.process({ meetingId: 'm', chunkIndex: 0, pcm: pcm(2), startMs: 0 })).toEqual([])
    expect(log).toHaveBeenCalledWith(expect.stringContaining('boom'))
    expect(d.status()).toBe('on')
  })

  it('dispose mata o worker e resolve a fila com []', async () => {
    const w = makeWorker(() => 'never')
    const d = createDiarizer(baseDeps({ spawnWorker: () => w }))
    const p1 = d.process({ meetingId: 'm', chunkIndex: 0, pcm: pcm(2), startMs: 0 })
    const p2 = d.process({ meetingId: 'm', chunkIndex: 1, pcm: pcm(2), startMs: 0 })
    await new Promise((r) => setTimeout(r, 0))
    d.dispose()
    expect(w.killed).toBe(true)
    expect(await p2).toEqual([])
    w.exit(0)
    expect(await p1).toEqual([])
  })
})

describe('fixture CM_MEETING_DIARIZE_FIXTURE', () => {
  const fixture = { speakers: [{ label: 'A' }, { label: 'B' }], pattern: 'ABAB' }

  it('fixtureTurns alterna speakers por chunk com embeddings ortogonais', () => {
    const a = fixtureTurns(fixture, 0, 12000)[0]
    const b = fixtureTurns(fixture, 1, 12000)[0]
    const a2 = fixtureTurns(fixture, 2, 5000)[0]
    expect(a).toMatchObject({ startMs: 0, endMs: 12000, localSpeaker: 0 })
    expect(b.localSpeaker).toBe(1)
    expect(a2.endMs).toBe(5000)
    expect(a.embedding.reduce((s, x, i) => s + x * b.embedding[i], 0)).toBe(0)
    expect(a.embedding).toEqual(a2.embedding)
  })

  it('sem worker: produz 2 speakers persistidos e status on', async () => {
    const store = makeStore()
    const spawnWorker = vi.fn()
    const d = createDiarizer(baseDeps({ fixture, store, spawnWorker, addonAvailable: () => false }))
    expect(d.status()).toBe('on')
    const out: string[] = []
    for (let i = 0; i < 4; i++) {
      const t = await d.process({ meetingId: 'm', chunkIndex: i, pcm: pcm(12), startMs: i * 12000 })
      expect(t).toHaveLength(1)
      expect(t[0]).toMatchObject({ startMs: 0, endMs: 12000 })
      out.push(t[0].speakerLabel)
    }
    expect(out).toEqual(['Participante 1', 'Participante 2', 'Participante 1', 'Participante 2'])
    expect(spawnWorker).not.toHaveBeenCalled()
    expect(store.speakers.size).toBe(2)
    expect([...store.speakers.values()].map((s) => s.turnCount)).toEqual([2, 2])
  })

  it('carrega do env e valida o shape', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pw-diarize-'))
    tmpDirs.push(dir)
    const good = join(dir, 'ok.json')
    writeFileSync(good, JSON.stringify(fixture))
    expect(loadDiarizeFixture({ CM_MEETING_DIARIZE_FIXTURE: good })).toEqual(fixture)
    const bad = join(dir, 'bad.json')
    writeFileSync(bad, JSON.stringify({ speakers: [] }))
    expect(() => loadDiarizeFixture({ CM_MEETING_DIARIZE_FIXTURE: bad })).toThrow('speakers')
    expect(loadDiarizeFixture({})).toBeNull()
    const d = createDiarizer(baseDeps({ fixture: undefined, env: { CM_MEETING_DIARIZE_FIXTURE: good }, addonAvailable: () => false }))
    expect(d.status()).toBe('on')
  })
})
