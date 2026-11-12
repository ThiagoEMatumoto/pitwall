import { act, render } from '@testing-library/react'
import type { Locator } from 'playwright'
import { createElement } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { ChatMessage } from '../../shared/types/chat'

const { transcript } = vi.hoisted(() => ({
  transcript: { messages: [] as ChatMessage[], listeners: new Set<() => void>() },
}))

vi.mock('@/lib/ipc', () => {
  const inert = new Proxy(
    {},
    {
      get: (_t, key: string) =>
        key.startsWith('on') ? () => () => {} : () => Promise.resolve(null),
    },
  )
  return new Proxy({}, { get: () => inert })
})
// Como o hook real: transcript novo chega por estado do hook, não por re-render do pai.
vi.mock('../../src/features/sessions/chat/useChatTranscript', async () => {
  const { useEffect, useReducer } = await import('react')
  return {
    useChatTranscript: () => {
      const [, refresh] = useReducer((n: number) => n + 1, 0)
      useEffect(() => {
        transcript.listeners.add(refresh)
        return () => void transcript.listeners.delete(refresh)
      }, [])
      return {
        messages: transcript.messages,
        loading: false,
        transcriptExists: true,
        lastPlanFilePath: null,
      }
    },
    usePlanFile: () => null,
  }
})
vi.mock('electron', () => ({ app: { getPath: () => '/nonexistent', getVersion: () => '0' } }))

import { buildLongMotherLines } from '../../electron/main/services/__fixtures__/long-mother-jsonl'
import { parseChatMessages } from '../../electron/main/services/chat-transcript'
import { ChatView } from '../../src/features/sessions/chat/ChatView'
import { loadTurnsShown, ptyCharsSent, readChatLoad, typingLoadArrived } from './chat-load'
import { parsePerfLines } from './perf'

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver

// O transcript do cenário: turnos do gerador, lidos pelo parser real do chat.
const BASE_TURNS = 3
const turnsOnDisk = (turns: number): ChatMessage[] =>
  parseChatMessages(buildLongMotherLines(turns).join('\n'))

function diskNow(messages: ChatMessage[]) {
  act(() => {
    transcript.messages = messages
    transcript.listeners.forEach((refresh) => refresh())
  })
}

// locator.evaluate de mentira: roda a função "da página" neste jsdom, sobre o
// elemento do pane, e devolve o resultado serializado, como o Playwright faz.
const paneOf = (el: Element) =>
  ({
    evaluate: async (fn: (el: Element) => unknown) => JSON.parse(JSON.stringify(fn(el))),
  }) as unknown as Locator

describe('readChatLoad', () => {
  it('conta, pelo chat real, os turnos da carga que ele já mostrou', async () => {
    transcript.messages = turnsOnDisk(BASE_TURNS)
    const { container } = render(createElement(ChatView, { sessionId: 'carga' }))
    const pane = paneOf(container)

    const before = await readChatLoad(pane, 1000)
    expect(before.lastReply).toMatch(/^pronto 2\./)
    expect(loadTurnsShown(before.lastReply, BASE_TURNS)).toBe(0)

    diskNow(turnsOnDisk(BASE_TURNS + 4))
    const after = await readChatLoad(pane, 1000)
    expect(loadTurnsShown(after.lastReply, BASE_TURNS)).toBe(4)

    expect(after.domNodes).toBe(document.getElementsByTagName('*').length)
    expect(after.domNodes).toBeGreaterThan(before.domNodes)
  })

  it('sem chat montado no pane (modo terminal) não há resposta nem turno da carga', async () => {
    const pane = document.createElement('div')
    pane.innerHTML = '<div class="xterm"><div class="xterm-screen"></div></div>'
    document.body.append(pane)

    const read = await readChatLoad(paneOf(pane), 1000)

    expect(read.lastReply).toBeNull()
    expect(loadTurnsShown(read.lastReply, BASE_TURNS)).toBe(0)
    pane.remove()
  })
})

describe('loadTurnsShown', () => {
  it('só conta resposta final de turno da carga', () => {
    expect(loadTurnsShown('pronto 12. room tile', 10)).toBe(3)
    // Última resposta de um transcript real, ou turno anterior ao começo da carga.
    expect(loadTurnsShown('Os dois exportam a mesma função.', 0)).toBe(0)
    expect(loadTurnsShown('pronto 4. room tile', 10)).toBe(0)
  })
})

describe('typingLoadArrived', () => {
  // As duas linhas do main da fase terminal-typing na rodada baseline (gpu-on-8mb),
  // como o main as imprimiu, sem `cpu` e `renderer`.
  const MAIN_LOG = [
    '[perf] {"t":"2026-11-12T06:42:48.355Z","windowMs":236,"phase":"terminal-typing","lagMs":{"p50":0.21,"p99":1.04,"max":1.04},"ipcIn":{"sessions:write":{"n":8,"perSec":33.9,"peakPerSec":8,"totalMs":0.91,"maxMs":0.29}},"ipcOut":{"pty:data":13},"counters":{"pty:data.chars":463},"spans":{}}',
    '[perf] {"t":"2026-11-12T06:42:54.643Z","windowMs":6288,"phase":"terminal-typing","lagMs":{"p50":0.14,"p99":1.1,"max":48.92},"ipcIn":{"sessions:write":{"n":192,"perSec":30.53,"peakPerSec":34,"totalMs":12.82,"maxMs":0.15}},"ipcOut":{"pty:data":350,"session:activity":4,"session:activity:global":3,"session-graph:updated":3},"counters":{"pty:data.chars":14570,"broadcastGlobal.sessions":15},"spans":{"broadcastGlobal":{"n":3,"totalMs":30,"maxMs":10.9},"graph.rebuild":{"n":4,"totalMs":129.14,"maxMs":49.79}}}',
  ].join('\n')

  it('no terminal a carga é a saída dos PTYs além do eco do que foi digitado', () => {
    const ptyChars = ptyCharsSent(parsePerfLines(MAIN_LOG))
    expect(ptyChars).toBe(15033)
    const seen = { surface: 'terminal' as const, typedChars: 200, chatNewMessages: 0 }

    expect(typingLoadArrived({ ...seen, ptyChars })).toBe(true)
    expect(typingLoadArrived({ ...seen, ptyChars: 200 })).toBe(false)
    expect(ptyCharsSent([])).toBe(0)
  })

  it('no chat a carga é mensagem nova na tela antes da última tecla', () => {
    const seen = { surface: 'chat' as const, typedChars: 200, ptyChars: 15033 }

    expect(typingLoadArrived({ ...seen, chatNewMessages: 0 })).toBe(false)
    expect(typingLoadArrived({ ...seen, chatNewMessages: 1 })).toBe(true)
  })
})
