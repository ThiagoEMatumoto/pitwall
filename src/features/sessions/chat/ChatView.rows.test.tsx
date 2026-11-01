import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ChatMessage } from '../../../../shared/types/chat'

const { transcript } = vi.hoisted(() => ({ transcript: { messages: [] as ChatMessage[] } }))

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
vi.mock('./useChatTranscript', () => ({
  useChatTranscript: () => ({
    messages: transcript.messages,
    loading: false,
    transcriptExists: true,
    lastPlanFilePath: null,
  }),
  usePlanFile: () => null,
}))
vi.mock('electron', () => ({ app: { getPath: () => '/nonexistent', getVersion: () => '0' } }))

import { ChatView } from './ChatView'
import { parseChatMessages } from '../../../../electron/main/services/chat-transcript'

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver

// Transcript no formato que a CLI grava, passado pelo parser real.
const L = (o: unknown) => JSON.stringify(o)
const USER = L({ type: 'user', message: { role: 'user', content: 'lê os dois arquivos' } })
const TOOLS = L({
  type: 'assistant',
  message: {
    id: 'm1',
    role: 'assistant',
    content: [
      { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/r/a.ts' } },
      { type: 'tool_use', id: 't2', name: 'Read', input: { file_path: '/r/b.ts' } },
    ],
  },
})
const RESULTS = L({
  type: 'user',
  message: {
    role: 'user',
    content: [
      { type: 'tool_result', tool_use_id: 't1', content: 'conteúdo a' },
      { type: 'tool_result', tool_use_id: 't2', content: 'conteúdo b' },
    ],
  },
})
const ANSWER = L({
  type: 'assistant',
  message: { id: 'm2', role: 'assistant', content: [{ type: 'text', text: 'Os dois exportam a mesma função.' }] },
})

function scroller(): HTMLElement {
  const el = document.querySelector('.overflow-y-auto') as HTMLElement
  el.scrollTo = vi.fn()
  return el
}

describe('ChatView — linhas agrupadas', () => {
  it('chamadas seguidas viram um resumo e nenhum resultado fica solto', () => {
    transcript.messages = parseChatMessages([USER, TOOLS, RESULTS, ANSWER].join('\n'))
    render(<ChatView sessionId="s1" />)
    expect(screen.getByRole('button', { name: /Leu 2 arquivos/ })).toBeInTheDocument()
    expect(screen.queryByText('Resultado')).not.toBeInTheDocument()
    expect(screen.queryByText('conteúdo a')).not.toBeInTheDocument()
    expect(screen.getByText('Os dois exportam a mesma função.')).toBeInTheDocument()
  })

  it('ao subir pra reler, oferece voltar ao fim e avisa de conteúdo novo', () => {
    transcript.messages = parseChatMessages([USER, TOOLS, RESULTS].join('\n'))
    const { rerender } = render(<ChatView sessionId="s2" />)
    const el = scroller()
    Object.defineProperty(el, 'scrollHeight', { configurable: true, value: 2000 })
    Object.defineProperty(el, 'clientHeight', { configurable: true, value: 400 })
    el.scrollTop = 100
    fireEvent.scroll(el)
    expect(screen.getByRole('button', { name: /Ir para o fim/ })).toBeInTheDocument()

    transcript.messages = parseChatMessages([USER, TOOLS, RESULTS, ANSWER].join('\n'))
    rerender(<ChatView sessionId="s2" />)
    const jump = screen.getByRole('button', { name: /Novas mensagens/ })
    act(() => fireEvent.click(jump))
    expect(el.scrollTo).toHaveBeenCalledWith(expect.objectContaining({ top: 2000 }))
    expect(screen.queryByRole('button', { name: /Novas mensagens|Ir para o fim/ })).not.toBeInTheDocument()
  })

  it('turno em andamento logo após o envio mostra "Pensando…"', () => {
    transcript.messages = parseChatMessages(USER)
    render(<ChatView sessionId="s3" status="working" />)
    expect(screen.getByRole('status')).toHaveTextContent('Pensando…')
  })
})
