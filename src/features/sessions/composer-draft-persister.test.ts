import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ComposerDraft, VersionedDraftInput } from '../../../shared/types/composer-draft'
import {
  composerDraftKey,
  createDraftPersister,
  flushAllDrafts,
  flushAllDraftsSync,
  type DraftApi,
  type DraftPersister,
} from './composer-draft-persister'

const KEY = composerDraftKey('pane-1', 'cc-1') as string

type Deferred = { resolve: () => void; reject: (err: Error) => void }

// DraftApi contadora: `save` fica em voo até o teste resolver, como o invoke.
function countingApi(saved: ComposerDraft | null = null) {
  const calls = {
    get: 0,
    getSync: 0,
    save: [] as VersionedDraftInput[],
    saveSync: [] as VersionedDraftInput[],
    writeThrough: [] as VersionedDraftInput[],
  }
  const inFlight: Deferred[] = []
  let releaseGet: () => void = () => {}
  const getGate = new Promise<void>((r) => (releaseGet = r))
  const api: DraftApi = {
    get: async () => {
      calls.get++
      await getGate
      return saved
    },
    getSync: () => {
      calls.getSync++
      return saved
    },
    save: (draft) => {
      calls.save.push(draft)
      return new Promise<void>((resolve, reject) => inFlight.push({ resolve, reject }))
    },
    saveSync: (draft) => {
      calls.saveSync.push(draft)
    },
    writeThrough: (draft) => {
      calls.writeThrough.push(draft)
    },
    clear: async () => {},
  }
  return { api, calls, inFlight, releaseGet }
}

const persisters: DraftPersister[] = []

function newPersister(api: DraftApi) {
  const p = createDraftPersister({ key: KEY, ccSessionId: 'cc-1', paneId: 'pane-1', api })
  persisters.push(p)
  return p
}

async function hydrated(h: ReturnType<typeof countingApi>) {
  const p = newPersister(h.api)
  h.releaseGet()
  await p.hydrate(() => {})
  return p
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  for (const p of persisters.splice(0)) p.dispose()
  vi.useRealTimers()
})

describe('flushAllDrafts (blur e troca de pane)', () => {
  it('grava pelo canal assíncrono, na hora, sem tocar o síncrono', async () => {
    const h = countingApi()
    const p = await hydrated(h)
    p.update({ text: 'digitado', attachments: [] })

    void flushAllDrafts()

    // O invoke sai na própria chamada: quem fecha a pane ou o app logo depois
    // já encontra a gravação na fila do IPC.
    expect(h.calls.save.map((d) => d.text)).toEqual(['digitado'])
    expect(h.calls.saveSync).toEqual([])
    expect(h.calls.getSync).toBe(0)
  })

  it('troca rápida de pane não repete a gravação nem cai no síncrono', async () => {
    const h = countingApi()
    const p = await hydrated(h)
    p.update({ text: 'digitado', attachments: [] })

    void flushAllDrafts()
    void flushAllDrafts()
    void flushAllDrafts()

    expect(h.calls.save).toHaveLength(1)
    expect(h.calls.saveSync).toEqual([])
  })

  it('digitou antes da leitura terminar: não grava nem lê síncrono; a hidratação entrega o juntado', async () => {
    const stored: ComposerDraft = {
      key: KEY,
      ccSessionId: 'cc-1',
      paneId: 'pane-1',
      text: 'salvo',
      attachments: [],
      updatedAt: 1,
    }
    const h = countingApi(stored)
    const p = newPersister(h.api)
    const reading = p.hydrate(() => {})
    p.update({ text: 'digitado', attachments: [] })

    await flushAllDrafts()
    // Sem saber o salvo, gravar o digitado o apagaria.
    expect(h.calls.save).toEqual([])
    expect(h.calls.saveSync).toEqual([])
    expect(h.calls.getSync).toBe(0)
    expect(h.calls.writeThrough).toEqual([])

    // Coberto pelo write-through que dispara quando a leitura resolve, e pelo
    // save durável do debounce logo depois.
    h.releaseGet()
    await reading
    expect(h.calls.writeThrough.map((d) => d.text)).toEqual(['salvo\n\ndigitado'])
    await vi.advanceTimersByTimeAsync(500)
    expect(h.calls.save.map((d) => d.text)).toEqual(['salvo\n\ndigitado'])
    expect(h.calls.saveSync).toEqual([])
    expect(h.calls.getSync).toBe(0)
  })

  it('falha de um persister não impede o flush dos outros', async () => {
    const broken = countingApi()
    const ok = countingApi()
    const a = await hydrated(broken)
    const b = await hydrated(ok)
    a.update({ text: 'a', attachments: [] })
    b.update({ text: 'b', attachments: [] })
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    const done = flushAllDrafts()
    broken.inFlight[0].reject(new Error('disco cheio'))
    ok.inFlight[0].resolve()
    await done

    expect(ok.calls.save.map((d) => d.text)).toEqual(['b'])
    // O que falhou continua sujo: o próximo flush tenta de novo.
    void flushAllDrafts()
    expect(broken.calls.save).toHaveLength(2)
    error.mockRestore()
  })
})

describe('flush assíncrono em voo', () => {
  it('quit: o flush síncrono regrava o que ainda não teve o commit confirmado', async () => {
    const h = countingApi()
    const p = await hydrated(h)
    p.update({ text: 'digitado', attachments: [] })
    void flushAllDrafts()
    expect(h.inFlight).toHaveLength(1)

    flushAllDraftsSync()

    expect(h.calls.saveSync.map((d) => d.text)).toEqual(['digitado'])
    expect(h.calls.saveSync[0].seq).toBe(h.calls.save[0].seq)
  })

  it('quit depois do commit confirmado não grava de novo', async () => {
    const h = countingApi()
    const p = await hydrated(h)
    p.update({ text: 'digitado', attachments: [] })
    const done = flushAllDrafts()
    h.inFlight[0].resolve()
    await done

    flushAllDraftsSync()

    expect(h.calls.saveSync).toEqual([])
  })

  it('fechar a pane logo depois do blur não usa o canal síncrono', async () => {
    const h = countingApi()
    const p = await hydrated(h)
    p.update({ text: 'digitado', attachments: [] })
    void p.flush()

    p.dispose()

    expect(h.calls.save.map((d) => d.text)).toEqual(['digitado'])
    expect(h.calls.saveSync).toEqual([])
    expect(h.calls.getSync).toBe(0)
  })

  it('fechar a pane com texto ainda não enviado ao save grava síncrono', async () => {
    const h = countingApi()
    const p = await hydrated(h)
    p.update({ text: 'antes', attachments: [] })
    void p.flush()
    p.update({ text: 'antes e depois', attachments: [] })

    p.dispose()

    expect(h.calls.saveSync.map((d) => d.text)).toEqual(['antes e depois'])
  })

  it('desmonte com a leitura pendente e texto digitado: lê o salvo síncrono, grava a junção e a devolve', () => {
    const h = countingApi({
      key: KEY,
      ccSessionId: 'cc-1',
      paneId: 'pane-1',
      text: 'salvo',
      attachments: [],
      updatedAt: 1,
    })
    const p = newPersister(h.api)
    void p.hydrate(() => {})
    p.update({ text: 'digitado', attachments: [] })

    expect(p.dispose()).toEqual({ text: 'salvo\n\ndigitado', attachments: [] })
    expect(h.calls.saveSync.map((d) => d.text)).toEqual(['salvo\n\ndigitado'])
  })

  it('desmonte de persister já hidratado não devolve nada: a memória do Composer já é a atual', async () => {
    const h = countingApi()
    const p = await hydrated(h)
    p.update({ text: 'digitado', attachments: [] })

    expect(p.dispose()).toBeNull()
  })

  it('desmonte com a leitura síncrona falhando não devolve nada nem grava: o salvo segue desconhecido', () => {
    const h = countingApi()
    const api: DraftApi = {
      ...h.api,
      getSync: () => {
        throw new Error('main fora do ar')
      },
    }
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const p = newPersister(api)
    void p.hydrate(() => {})
    p.update({ text: 'digitado', attachments: [] })

    expect(p.dispose()).toBeNull()
    expect(h.calls.saveSync).toEqual([])
    expect(h.calls.writeThrough).toEqual([])
    error.mockRestore()
  })

  it('duas gravações fora de ordem: a versão mais nova é a de maior seq e a falha da antiga regrava a atual', async () => {
    const h = countingApi()
    const p = await hydrated(h)
    p.update({ text: 'v1', attachments: [] })
    const first = p.flush()
    p.update({ text: 'v2', attachments: [] })
    const second = p.flush()
    expect(h.calls.save.map((d) => d.text)).toEqual(['v1', 'v2'])
    expect(h.calls.save[1].writer).toBe(h.calls.save[0].writer)
    expect(h.calls.save[1].seq).toBeGreaterThan(h.calls.save[0].seq)
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    // A mais nova confirma primeiro; a antiga falha depois.
    h.inFlight[1].resolve()
    await second
    h.inFlight[0].reject(new Error('timeout'))
    await first

    void p.flush()
    expect(h.calls.save.map((d) => d.text)).toEqual(['v1', 'v2', 'v2'])
    error.mockRestore()
  })
})
