import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
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
import {
  createChatParser,
  parseChatMessages,
  parseTranscriptLines,
} from '../../../../electron/main/services/chat-transcript'
import { buildLongMotherLines } from '../../../../electron/main/services/__fixtures__/long-mother-jsonl'
import { applyTranscriptUpdate, CHAT_WINDOW_ROWS } from './chat-logic'

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
    render(<ChatView sessionId="memo" />)
    const before = renders('MarkdownViewer')
    expect(before).toBeGreaterThanOrEqual(2)

    diskNow(
      parseChatMessages([USER, TOOLS, RESULTS, ANSWER, FOLLOW_UP, SECOND_ANSWER].join('\n')),
    )
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

describe('janela de linhas (contadores da sonda)', () => {
  const renders = (name: string) => window.__cmPerf?.counters[name] ?? 0
  const rowsEl = () => screen.getByTestId('chat-rows')
  const earlier = () => screen.queryByRole('button', { name: 'Mostrar mensagens anteriores' })
  // Cada turno do gerador são 5 linhas de JSONL e 4 linhas do chat: pedido, texto,
  // grupo de ferramentas e texto final.
  const turns = (n: number) => buildLongMotherLines(n, 64)

  // O transcript como o renderer o recebe: parser incremental do main, cada delta
  // emendado pelo merge do hook (os objetos antigos seguem os mesmos).
  function liveTranscript() {
    const parser = createChatParser()
    let current: ChatMessage[] = []
    let rev = 0
    return (lines: string[]): ChatMessage[] => {
      parser.feed(parseTranscriptLines(lines.join('\n')))
      const base = parser.takeDirty()
      const update = { base, rev: rev + 1, messages: parser.messages.slice(base) }
      const merged = applyTranscriptUpdate(current, rev, update)
      if (merged.kind !== 'applied') throw new Error(merged.kind)
      rev = update.rev
      current = merged.messages
      return current
    }
  }

  afterEach(() => vi.restoreAllMocks())

  // Rolagem medida: o jsdom não faz layout, então a altura e a posição de cada linha
  // seguem as linhas montadas. Acima delas fica o botão de mensagens anteriores.
  function measured(rowPx = 40) {
    const el = scroller()
    vi.spyOn(HTMLElement.prototype, 'offsetTop', 'get').mockImplementation(function (
      this: HTMLElement,
    ) {
      const rows = this.parentElement
      return rows ? 30 + Array.prototype.indexOf.call(rows.children, this) * rowPx : 0
    })
    Object.defineProperty(el, 'scrollHeight', {
      configurable: true,
      get: () => rowsEl().children.length * rowPx,
    })
    Object.defineProperty(el, 'clientHeight', { configurable: true, value: 400 })
    return el
  }

  it('abrir 30.980 mensagens monta só a janela do fim', () => {
    transcript.messages = parseChatMessages(turns(6196).join('\n'))
    expect(transcript.messages).toHaveLength(30_980)
    const markdown = renders('MarkdownViewer')
    const groups = renders('ToolGroup')

    render(<ChatView sessionId="w1" />)

    expect(rowsEl().children).toHaveLength(CHAT_WINDOW_ROWS)
    expect(screen.getByText(/^pronto 6195\./)).toBeInTheDocument()
    expect(screen.queryByText(/^pedido 0:/)).not.toBeInTheDocument()
    expect(renders('MarkdownViewer') - markdown).toBeLessThanOrEqual(CHAT_WINDOW_ROWS)
    expect(renders('ToolGroup') - groups).toBeLessThanOrEqual(CHAT_WINDOW_ROWS)
  }, 120_000)

  it('conversa que cabe na janela monta tudo e não oferece mensagens anteriores', () => {
    transcript.messages = parseChatMessages(turns(10).join('\n'))
    render(<ChatView sessionId="w2" />)
    expect(rowsEl().children).toHaveLength(40)
    expect(earlier()).not.toBeInTheDocument()
  })

  it('mensagem nova no fim não renderiza de novo as linhas antigas', () => {
    const all = turns(301)
    const disk = liveTranscript()
    transcript.messages = disk(all.slice(0, -5))
    render(<ChatView sessionId="w3" />)
    const markdown = renders('MarkdownViewer')
    const groups = renders('ToolGroup')
    const bubbles = renders('MessageBubble')

    diskNow(disk(all.slice(-5)))

    expect(screen.getByText(/^pronto 300\./)).toBeInTheDocument()
    expect(rowsEl().children).toHaveLength(CHAT_WINDOW_ROWS + 4)
    expect(renders('MarkdownViewer') - markdown).toBe(3)
    expect(renders('MessageBubble') - bubbles).toBe(3)
    expect(renders('ToolGroup') - groups).toBe(1)
  })

  it('colado no fim, o streaming apara a janela em vez de crescer sem limite', () => {
    const all = turns(78)
    const disk = liveTranscript()
    transcript.messages = disk(all.slice(0, 40 * 5))
    render(<ChatView sessionId="w4" />)
    expect(rowsEl().children).toHaveLength(CHAT_WINDOW_ROWS)

    diskNow(disk(all.slice(40 * 5, 77 * 5)))
    expect(rowsEl().children).toHaveLength(CHAT_WINDOW_ROWS + 37 * 4)

    diskNow(disk(all.slice(77 * 5)))
    expect(rowsEl().children).toHaveLength(CHAT_WINDOW_ROWS)
    expect(screen.getByText(/^pronto 77\./)).toBeInTheDocument()
  })

  it('perto do topo, a janela anterior entra sem mover o que está na tela e sem animar', () => {
    const all = turns(100)
    const disk = liveTranscript()
    transcript.messages = disk(all.slice(0, 5))
    render(<ChatView sessionId="w5" />)
    // Tudo que chega depois da 1ª pintura entra animado; colado no fim, a janela apara.
    diskNow(disk(all.slice(5)))
    expect(rowsEl().children).toHaveLength(CHAT_WINDOW_ROWS)
    const el = measured()
    const groups = renders('ToolGroup')

    el.scrollTop = 100
    fireEvent.scroll(el)

    expect(rowsEl().children).toHaveLength(2 * CHAT_WINDOW_ROWS)
    expect(el.scrollTop).toBe(100 + CHAT_WINDOW_ROWS * 40)
    expect(screen.getByText(/^pronto 99\./)).toBeInTheDocument()
    expect(rowsEl().querySelectorAll(':scope > .chat-row-in')).toHaveLength(0)
    // Só os grupos da janela que entrou renderizam; os que já estavam, não.
    expect(renders('ToolGroup') - groups).toBeLessThanOrEqual(CHAT_WINDOW_ROWS / 4 + 1)
  })

  it('janela anterior e mensagem nova no mesmo commit: só o que entrou por cima desloca a rolagem', () => {
    const all = turns(101)
    const disk = liveTranscript()
    transcript.messages = disk(all.slice(0, -5))
    render(<ChatView sessionId="w10" />)
    const el = measured()

    // Streaming: o disco muda entre o scroll e o commit da janela anterior.
    act(() => {
      el.scrollTop = 100
      fireEvent.scroll(el)
      transcript.messages = disk(all.slice(-5))
      transcript.listeners.forEach((refresh) => refresh())
    })

    expect(rowsEl().children).toHaveLength(2 * CHAT_WINDOW_ROWS + 4)
    expect(el.scrollTop).toBe(100 + CHAT_WINDOW_ROWS * 40)
  })

  it('"Ir para o fim" com mais de duas janelas montadas apara e volta a colar', () => {
    const all = turns(101)
    const disk = liveTranscript()
    transcript.messages = disk(all.slice(0, -5))
    render(<ChatView sessionId="w11" />)
    const el = measured()
    el.scrollTop = 100
    fireEvent.scroll(el)
    el.scrollTop = 100
    fireEvent.scroll(el)
    expect(rowsEl().children).toHaveLength(400)

    act(() => fireEvent.click(screen.getByRole('button', { name: /Ir para o fim/ })))
    expect(rowsEl().children).toHaveLength(CHAT_WINDOW_ROWS)
    expect(screen.getByText(/^pronto 99\./)).toBeInTheDocument()

    // A conversa encolheu: a rolagem cai perto do topo no meio do salto e nada volta a entrar.
    el.scrollTop = 100
    fireEvent.scroll(el)
    expect(rowsEl().children).toHaveLength(CHAT_WINDOW_ROWS)

    diskNow(disk(all.slice(-5)))
    expect(el.scrollTop).toBe(el.scrollHeight)
    expect(
      screen.queryByRole('button', { name: /Ir para o fim|Novas mensagens/ }),
    ).not.toBeInTheDocument()
  })

  it('rewind desmonta a linha de referência no mesmo commit: a rolagem fica como está', () => {
    transcript.messages = parseChatMessages(turns(100).join('\n'))
    render(<ChatView sessionId="w12" />)
    const el = measured()

    act(() => {
      el.scrollTop = 100
      fireEvent.scroll(el)
      transcript.messages = parseChatMessages(turns(50).join('\n'))
      transcript.listeners.forEach((refresh) => refresh())
    })

    expect(rowsEl().children).toHaveLength(CHAT_WINDOW_ROWS)
    expect(el.scrollTop).toBe(100)
  })

  it('lendo lá em cima, o que chega no fim não desmonta nada', () => {
    const all = turns(101)
    const disk = liveTranscript()
    transcript.messages = disk(all.slice(0, -5))
    render(<ChatView sessionId="w6" />)
    const el = measured()
    el.scrollTop = 100
    fireEvent.scroll(el)
    el.scrollTop = 100
    fireEvent.scroll(el)
    expect(rowsEl().children).toHaveLength(400)
    expect(earlier()).not.toBeInTheDocument()

    diskNow(disk(all.slice(-5)))
    expect(rowsEl().children).toHaveLength(404)
    expect(screen.getByText(/^pedido 0:/)).toBeInTheDocument()
  })

  it('"Mostrar mensagens anteriores" traz uma janela por clique e some no início', () => {
    transcript.messages = parseChatMessages(turns(100).join('\n'))
    render(<ChatView sessionId="w7" />)
    const el = measured()
    // Lendo no meio: nem colado no fim, nem perto do topo.
    el.scrollTop = 2000
    fireEvent.scroll(el)
    expect(rowsEl().children).toHaveLength(CHAT_WINDOW_ROWS)

    act(() => fireEvent.click(earlier()!))
    expect(rowsEl().children).toHaveLength(2 * CHAT_WINDOW_ROWS)
    expect(el.scrollTop).toBe(2000 + CHAT_WINDOW_ROWS * 40)

    act(() => fireEvent.click(earlier()!))
    expect(rowsEl().children).toHaveLength(400)
    expect(screen.getByText(/^pedido 0:/)).toBeInTheDocument()
    expect(earlier()).not.toBeInTheDocument()
  })

  it('o grupo em andamento segue marcado com a janela deslocada', () => {
    const all = turns(100)
    // O último turno ainda sem o resultado da ferramenta nem o texto final.
    transcript.messages = parseChatMessages(all.slice(0, -2).join('\n'))
    render(<ChatView sessionId="w8" status="working" />)
    expect(rowsEl().children).toHaveLength(CHAT_WINDOW_ROWS)
    const last = rowsEl().lastElementChild as HTMLElement
    expect(last.querySelectorAll('[aria-label="rodando"]').length).toBeGreaterThan(0)
    expect(screen.getAllByLabelText('rodando')).toHaveLength(
      last.querySelectorAll('[aria-label="rodando"]').length,
    )
  })

  it('troca de sessão: a janela volta pro fim da conversa nova', () => {
    transcript.messages = parseChatMessages(turns(100).join('\n'))
    const { rerender } = render(<ChatView sessionId="w9a" />)
    const el = measured()
    el.scrollTop = 100
    fireEvent.scroll(el)
    expect(rowsEl().children).toHaveLength(2 * CHAT_WINDOW_ROWS)

    rerender(<ChatView sessionId="w9b" />)
    expect(screen.getByTestId('chat-loading')).toBeInTheDocument()
    diskNow(parseChatMessages(turns(90).join('\n')))
    expect(rowsEl().children).toHaveLength(CHAT_WINDOW_ROWS)
    expect(screen.getByText(/^pronto 89\./)).toBeInTheDocument()
  })
})
