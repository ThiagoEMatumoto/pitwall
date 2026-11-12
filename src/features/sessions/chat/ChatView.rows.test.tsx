import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ChatMessage } from '../../../../shared/types/chat'

const { transcript } = vi.hoisted(() => {
  // A sonda lê a flag uma vez, na carga do módulo: liga antes dos imports.
  ;(window as unknown as { api: unknown }).api = { perf: { enabled: true, report: () => {} } }
  return { transcript: { messages: [] as ChatMessage[], listeners: new Set<() => void>() } }
})

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
// Como o hook real: transcript novo chega por estado do hook, não por re-render do
// pai (o ChatView é memo e ignoraria um re-render com as mesmas props).
vi.mock('./useChatTranscript', async () => {
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

import { ChatView } from './ChatView'
import { MessageBubble } from './MessageBubble'
import { ToolGroup } from './ToolCard'
import { buildChatRows, type ToolEntry } from './chat-rows'
import { startPerfProbe } from '@/lib/perf-probe'
import { parseChatMessages } from '../../../../electron/main/services/chat-transcript'

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver
// O jsdom não tem PerformanceObserver; a sonda só precisa dele para long tasks e teclas.
globalThis.PerformanceObserver ??= class {
  observe() {}
} as unknown as typeof PerformanceObserver

// O disco mudou: o hook avisa o ChatView montado, por estado, como o hook real.
function diskNow(messages: ChatMessage[]) {
  act(() => {
    transcript.messages = messages
    transcript.listeners.forEach((refresh) => refresh())
  })
}

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

const FOLLOW_UP = L({ type: 'user', message: { role: 'user', content: 'e qual delas é usada?' } })
const SECOND_ANSWER = L({
  type: 'assistant',
  message: { id: 'm3', role: 'assistant', content: [{ type: 'text', text: 'A de a.ts.' }] },
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
    render(<ChatView sessionId="s2" />)
    const el = scroller()
    Object.defineProperty(el, 'scrollHeight', { configurable: true, value: 2000 })
    Object.defineProperty(el, 'clientHeight', { configurable: true, value: 400 })
    el.scrollTop = 100
    fireEvent.scroll(el)
    expect(screen.getByRole('button', { name: /Ir para o fim/ })).toBeInTheDocument()

    diskNow(parseChatMessages([USER, TOOLS, RESULTS, ANSWER].join('\n')))
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

  it('salto suave: scroll intermediário não desengata e o conteúdo novo continua colado', () => {
    transcript.messages = parseChatMessages([USER, TOOLS, RESULTS].join('\n'))
    render(<ChatView sessionId="s4" />)
    const el = scroller()
    Object.defineProperty(el, 'scrollHeight', { configurable: true, value: 2000 })
    Object.defineProperty(el, 'clientHeight', { configurable: true, value: 400 })
    el.scrollTop = 100
    fireEvent.scroll(el)
    act(() => fireEvent.click(screen.getByRole('button', { name: /Ir para o fim/ })))

    // Primeiro quadro do smooth scroll: ainda longe do fim.
    el.scrollTop = 900
    fireEvent.scroll(el)
    expect(screen.queryByRole('button', { name: /Ir para o fim|Novas mensagens/ })).not.toBeInTheDocument()

    diskNow(parseChatMessages([USER, TOOLS, RESULTS, ANSWER].join('\n')))
    expect(el.scrollTop).toBe(2000)
  })
})

describe('ChatView — troca de sessão na mesma instância', () => {
  const many = () =>
    parseChatMessages(
      Array.from({ length: 8 }, (_, i) =>
        L({ type: 'user', message: { role: 'user', content: `pergunta ${i}` } }),
      ).join('\n'),
    )

  it('o render com o transcript antigo vira loading e a conversa nova entra sem cascata', () => {
    const first = parseChatMessages(USER)
    transcript.messages = first
    const { rerender } = render(<ChatView sessionId="a" />)
    expect(screen.getByText('lê os dois arquivos')).toBeInTheDocument()

    // O hook ainda devolve o MESMO array da sessão anterior.
    rerender(<ChatView sessionId="b" />)
    expect(screen.getByTestId('chat-loading')).toBeInTheDocument()

    diskNow(many())
    expect(screen.getByText('pergunta 7')).toBeInTheDocument()
    expect(document.querySelectorAll('.chat-row-in')).toHaveLength(0)
  })

  it('na mesma sessão, o que chega depois da 1ª pintura entra animado', () => {
    transcript.messages = parseChatMessages(USER)
    render(<ChatView sessionId="c" />)
    diskNow(parseChatMessages([USER, ANSWER].join('\n')))
    expect(document.querySelectorAll('.chat-row-in').length).toBeGreaterThan(0)
  })
})

describe('folhas do chat memoizadas (contadores da sonda)', () => {
  startPerfProbe()
  const renders = (name: string) => window.__cmPerf?.counters[name] ?? 0
  const toolGroup = (messages: ChatMessage[]): ToolEntry[] => {
    const row = buildChatRows(messages).find((r) => r.type === 'tools')
    if (row?.type !== 'tools') throw new Error('esperava grupo')
    return row.entries
  }

  it('mensagens novas só parseiam o markdown delas', () => {
    transcript.messages = parseChatMessages([USER, TOOLS, RESULTS, ANSWER].join('\n'))
    const { rerender } = render(<ChatView sessionId="memo" />)
    const before = renders('MarkdownViewer')
    expect(before).toBeGreaterThanOrEqual(2)

    transcript.messages = parseChatMessages(
      [USER, TOOLS, RESULTS, ANSWER, FOLLOW_UP, SECOND_ANSWER].join('\n'),
    )
    rerender(<ChatView sessionId="memo" />)
    expect(screen.getByText('A de a.ts.')).toBeInTheDocument()
    expect(renders('MarkdownViewer') - before).toBe(2)
  })

  it('bolha com as mesmas props não renderiza de novo; texto novo renderiza', () => {
    const [answer] = parseChatMessages(ANSWER)
    if (answer.kind !== 'assistant') throw new Error('esperava resposta')
    const unmounted = renders('MessageBubble')
    const { rerender } = render(<MessageBubble role="assistant" text={answer.text} />)
    const before = renders('MessageBubble')
    expect(before).toBe(unmounted + 1)

    rerender(<MessageBubble role="assistant" text={answer.text} />)
    expect(renders('MessageBubble')).toBe(before)

    rerender(<MessageBubble role="assistant" text={`${answer.text} E mais.`} />)
    expect(renders('MessageBubble')).toBe(before + 1)
    expect(screen.getByText(/E mais\./)).toBeInTheDocument()
  })

  it('grupo refeito sobre as mesmas mensagens não renderiza; resultado novo renderiza', () => {
    const pending = parseChatMessages([USER, TOOLS].join('\n'))
    const unmounted = renders('ToolGroup')
    const { rerender } = render(<ToolGroup entries={toolGroup(pending)} running />)
    const before = renders('ToolGroup')
    expect(before).toBe(unmounted + 1)
    expect(screen.getAllByLabelText('rodando').length).toBeGreaterThan(0)

    rerender(<ToolGroup entries={toolGroup(pending)} running />)
    expect(renders('ToolGroup')).toBe(before)

    const answered = [...pending, ...parseChatMessages(RESULTS)]
    rerender(<ToolGroup entries={toolGroup(answered)} running />)
    expect(renders('ToolGroup')).toBe(before + 1)
    expect(screen.queryByLabelText('rodando')).not.toBeInTheDocument()

    rerender(<ToolGroup entries={toolGroup(answered)} />)
    expect(renders('ToolGroup')).toBe(before + 2)
  })
})
