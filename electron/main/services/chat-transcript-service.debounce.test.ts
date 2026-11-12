// @vitest-environment node
// Em jsdom o mock de node:fs/promises não chega ao serviço, e as leituras não são contadas.
import { EventEmitter } from 'node:events'
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WebContents } from 'electron'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatMessage, ChatTranscriptUpdate } from '../../../shared/types/chat'

vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }))

let transcriptPath: string | null = null
vi.mock('./session-activity', () => ({
  findTranscriptPath: () => transcriptPath,
}))

// Só a ORIGEM dos eventos é trocada: o teste dita quando o change chega. Serviço,
// arquivo, leitura por offset e parser são os reais.
const watchers: EventEmitter[] = []
vi.mock('chokidar', () => ({
  default: {
    watch: () => {
      const w = Object.assign(new EventEmitter(), { close: async () => {} })
      watchers.push(w)
      return w
    },
  },
}))

// Cada leitura do watch completo abre o arquivo uma vez: contar os open é contar as
// leituras. `gate` segura a abertura para simular uma leitura lenta.
const io = vi.hoisted(() => ({
  opens: 0,
  inFlight: 0,
  maxInFlight: 0,
  gate: Promise.resolve(),
}))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  const open: typeof actual.open = async (...args) => {
    io.opens += 1
    io.inFlight += 1
    io.maxInFlight = Math.max(io.maxInFlight, io.inFlight)
    try {
      await io.gate
      const fh = await actual.open(...args)
      const close = fh.close.bind(fh)
      fh.close = async () => {
        io.inFlight -= 1
        return close()
      }
      return fh
    } catch (err) {
      io.inFlight -= 1
      throw err
    }
  }
  return { ...actual, open }
})

import { parseChatMessages } from './chat-transcript'
import { applyTranscriptUpdate } from '../../../src/features/sessions/chat/chat-logic'
import { chatTranscriptService } from './chat-transcript-service'
import { realShapeAssistantLine } from './__fixtures__/long-mother-jsonl'

let dir: string
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'chat-debounce-'))
})
afterAll(() => {
  chatTranscriptService.closeAll()
  rmSync(dir, { recursive: true, force: true })
})

const line = (n: number) =>
  realShapeAssistantLine(n, `msg_burst_${n}`, [{ type: 'text', text: `linha ${n}` }]) + '\n'

let seq = 0
// Sessão observada, com a 1ª leitura já feita, e o watcher falso que o serviço recebeu.
async function watched() {
  const n = seq++
  const cc = `cc-debounce-${n}`
  const sessionId = `s-debounce-${n}`
  const path = join(dir, `${cc}.jsonl`)
  writeFileSync(path, line(0))
  transcriptPath = path
  const updates: ChatTranscriptUpdate[] = []
  const sender = Object.assign(new EventEmitter(), {
    id: 500 + n,
    isDestroyed: () => false,
    send: (channel: string, payload: ChatTranscriptUpdate) => {
      if (channel === 'chat:transcript-update') updates.push(payload)
    },
  }) as unknown as WebContents
  chatTranscriptService.watch(sessionId, cc, sender)
  const watcher = watchers.at(-1)!
  // Espera as leituras enfileiradas sem pedir outra (refresh pediria).
  const settle = () => chatTranscriptService.snapshot(sessionId, cc)
  await settle()
  let next = 1
  return {
    sessionId,
    sender,
    updates,
    settle,
    // Um append de uma linha e o change que o chokidar daria por ele.
    appendAndChange: () => {
      appendFileSync(path, line(next++))
      watcher.emit('change', path)
    },
    full: () => parseChatMessages(readFileSync(path, 'utf8')),
    // A lista que o renderer teria: update fora de ordem ou repetido falha aqui.
    view: (): ChatMessage[] => {
      let rev = -1
      let messages: ChatMessage[] = []
      updates.forEach((u, i) => {
        const merged = applyTranscriptUpdate(messages, rev, u)
        if (merged.kind !== 'applied') throw new Error(`update ${i} (rev ${u.rev}): ${merged.kind}`)
        rev = u.rev
        messages = merged.messages
      })
      return messages
    },
  }
}

describe('watch — rajada contínua de appends', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    io.gate = Promise.resolve()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('appends a cada 100 ms por 2 s: o chat lê a cada ~300 ms, não só quando a rajada para', async () => {
    const w = await watched()
    expect(w.updates).toHaveLength(1)
    const opensBefore = io.opens
    const deltasAt: number[] = []

    for (let t = 0; t < 2000; t += 100) {
      w.appendAndChange()
      await vi.advanceTimersByTimeAsync(100)
      await w.settle()
      deltasAt.push(w.updates.length - 1)
    }

    // Uma leitura por teto de espera (t = 300, 600, …, 1800): 300 ms depois do 1º
    // change da rajada a 1ª já saiu.
    expect(deltasAt).toEqual(Array.from({ length: 20 }, (_, i) => Math.floor((i + 1) / 3)))
    expect(io.opens - opensBefore).toBe(6)

    // A cauda de 150 ms fecha a rajada com uma leitura só.
    await vi.advanceTimersByTimeAsync(150)
    await w.settle()
    expect(w.updates.length - 1).toBe(7)
    expect(io.opens - opensBefore).toBe(7)
    expect(w.view()).toEqual(w.full())

    // Nenhum timer sobra armado para ler de novo o que já foi lido.
    await vi.advanceTimersByTimeAsync(1000)
    await w.settle()
    expect(io.opens - opensBefore).toBe(7)
    expect(vi.getTimerCount()).toBe(0)
    chatTranscriptService.unwatch(w.sessionId, w.sender.id)
  })

  it('um change isolado continua lido 150 ms depois, uma vez só', async () => {
    const w = await watched()
    const opensBefore = io.opens

    w.appendAndChange()
    await vi.advanceTimersByTimeAsync(149)
    await w.settle()
    expect(io.opens - opensBefore).toBe(0)

    await vi.advanceTimersByTimeAsync(1)
    await w.settle()
    expect(io.opens - opensBefore).toBe(1)
    expect(w.updates).toHaveLength(2)

    await vi.advanceTimersByTimeAsync(1000)
    await w.settle()
    expect(io.opens - opensBefore).toBe(1)
    expect(vi.getTimerCount()).toBe(0)
    chatTranscriptService.unwatch(w.sessionId, w.sender.id)
  })

  it('leitura lenta durante a rajada: os tetos seguintes não empilham leituras', async () => {
    const w = await watched()
    const opensBefore = io.opens
    io.maxInFlight = 0
    let release = () => {}
    io.gate = new Promise<void>((r) => {
      release = r
    })

    // t = 0 → 1800: o teto dispara em 300 (essa leitura fica presa no open) e de novo
    // em 600, 900, 1200, 1500 e 1800.
    for (let t = 0; t < 1800; t += 100) {
      w.appendAndChange()
      await vi.advanceTimersByTimeAsync(100)
    }
    release()
    await w.settle()

    // A presa + uma na fila, que já enxerga tudo o que foi escrito até ela começar.
    expect(io.opens - opensBefore).toBe(2)
    expect(io.maxInFlight).toBe(1)
    expect(w.view()).toEqual(w.full())
    chatTranscriptService.unwatch(w.sessionId, w.sender.id)
  })

  it('unwatch no meio da rajada desarma a cauda e o teto', async () => {
    const w = await watched()
    const opensBefore = io.opens

    w.appendAndChange()
    await vi.advanceTimersByTimeAsync(100)
    chatTranscriptService.unwatch(w.sessionId, w.sender.id)

    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(1000)
    expect(io.opens - opensBefore).toBe(0)
  })
})
