import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { parseTuiMenu, type TuiMenu } from '../../../../shared/tui/tui-menu-parser'

vi.mock('@/lib/ipc', () => {
  const inert = new Proxy(
    {},
    { get: (_t, key: string) => (key.startsWith('on') ? () => () => {} : () => Promise.resolve(null)) },
  )
  return new Proxy({}, { get: () => inert })
})
const transcript = vi.hoisted(() => ({ messages: [] as { kind: 'user'; text: string }[] }))
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
import { QUESTION_KEY_DELAY_MS } from './respond-keys'

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver

const UP = '\x1b[A'
const DOWN = '\x1b[B'
const menuOf = (name: string): TuiMenu =>
  parseTuiMenu(
    readFileSync(join(__dirname, `../../../../shared/tui/__fixtures__/claude-${name}.txt`), 'utf8'),
  )!

function renderMenu(name: string, status: 'waiting' | 'idle' = 'waiting') {
  const onRespond = vi.fn()
  const utils = render(
    <ChatView
      sessionId="s-q"
      status={status}
      tuiMenu={menuOf(name)}
      reparseMenu={() => menuOf(name)}
      onRespond={onRespond}
      onToggleMode={vi.fn()}
    />,
  )
  return { ...utils, onRespond }
}

// Telas reais do claude 2.1.317/318 e as teclas que a TUI aceitou nas sondas.
describe('ChatView — multi-select com Other (2.1.317)', () => {
  it('sem banner de terminal: checkbox, campo Outra, Enviar e Conversar', () => {
    renderMenu('2.1.317-question-multi-other')
    expect(screen.queryByText('Ir pro Terminal')).toBeNull()
    expect(screen.getByText('Azul')).toBeTruthy()
    expect(screen.getByTestId('question-other-input')).toBeTruthy()
    expect(screen.getByTestId('question-submit-multi')).toBeTruthy()
    expect(screen.getByTestId('question-chat')).toBeTruthy()
  })

  it('marcar uma opção manda o dígito dela', () => {
    const { onRespond } = renderMenu('2.1.317-question-multi-other')
    fireEvent.click(screen.getByText('Verde'))
    expect(onRespond).toHaveBeenCalledWith(['2'])
  })

  it('Other: setas até o campo, texto e ↓, com respiro; o card segue interativo', () => {
    const { onRespond } = renderMenu('2.1.317-question-multi-other')
    fireEvent.change(screen.getByTestId('question-other-input'), { target: { value: 'roxo' } })
    fireEvent.click(screen.getByText('Marcar'))
    expect(onRespond).toHaveBeenCalledWith([DOWN, DOWN, DOWN, 'roxo', DOWN], QUESTION_KEY_DELAY_MS)
    expect(screen.getByTestId('question-submit-multi')).toBeTruthy()
  })

  it('Enviar respostas: ↓ até a linha Submit e Enter (abre a revisão)', () => {
    const { onRespond } = renderMenu('2.1.317-question-multi-other')
    fireEvent.click(screen.getByTestId('question-submit-multi'))
    expect(onRespond).toHaveBeenCalledWith([DOWN, DOWN, DOWN, DOWN, '\r'], QUESTION_KEY_DELAY_MS)
  })

  it('Other em andamento trava o card: Enviar e marcar não intercalam teclas', async () => {
    vi.useFakeTimers()
    try {
      let finish: (ok: boolean) => void = () => {}
      const onRespond = vi.fn(() => new Promise<boolean>((r) => (finish = r)))
      const menu = menuOf('2.1.317-question-multi-other')
      render(
        <ChatView
          sessionId="s-q"
          status="waiting"
          tuiMenu={menu}
          reparseMenu={() => menu}
          onRespond={onRespond}
          onToggleMode={vi.fn()}
        />,
      )
      fireEvent.change(screen.getByTestId('question-other-input'), { target: { value: 'roxo' } })
      fireEvent.click(screen.getByText('Marcar'))
      fireEvent.click(screen.getByTestId('question-submit-multi'))
      fireEvent.click(screen.getByText('Verde'))
      expect(onRespond).toHaveBeenCalledTimes(1)
      // A última tecla saiu, mas a TUI ainda redesenha: segue travado pelo respiro.
      await act(async () => finish(true))
      fireEvent.click(screen.getByTestId('question-submit-multi'))
      expect(onRespond).toHaveBeenCalledTimes(1)
      await act(async () => vi.advanceTimersByTime(QUESTION_KEY_DELAY_MS))
      fireEvent.click(screen.getByText('Verde'))
      expect(onRespond).toHaveBeenCalledTimes(2)
      expect(onRespond).toHaveBeenLastCalledWith(['2'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('Terminal recusou (outra resposta tocando): o card volta a aceitar', async () => {
    const onRespond = vi.fn(() => Promise.resolve(false))
    const menu = menuOf('2.1.317-question-multi-other')
    render(
      <ChatView
        sessionId="s-q"
        status="waiting"
        tuiMenu={menu}
        reparseMenu={() => menu}
        onRespond={onRespond}
        onToggleMode={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByTestId('question-submit-multi'))
    await act(async () => {})
    fireEvent.click(screen.getByTestId('question-submit-multi'))
    expect(onRespond).toHaveBeenCalledTimes(2)
  })

  it('aba com o cursor no campo do Other: sai dele antes da seta', () => {
    const { onRespond } = renderMenu('2.1.317-question-multi-other-typing')
    fireEvent.click(screen.getByLabelText('Próxima aba'))
    expect(onRespond).toHaveBeenCalledWith([UP, '\x1b[C'])
  })

  it('Other com texto já no campo: mostra o texto, sem campo', () => {
    renderMenu('2.1.317-question-multi-other-typed')
    const typed = screen.getByTestId('question-other-typed').textContent
    expect(typed).toContain('verde agua')
    // A tela não diz de onde o texto veio: pode ter sido o próprio card.
    expect(typed).not.toContain('terminal')
    expect(screen.queryByTestId('question-other-input')).toBeNull()
  })

  it('marcar com o cursor no campo do Other sai dele antes do dígito', () => {
    const { onRespond } = renderMenu('2.1.317-question-multi-other-typing')
    fireEvent.click(screen.getByText('Azul'))
    expect(onRespond).toHaveBeenCalledWith([UP, '1'])
  })

  it('revisão: Enviar = 1, Recusar = 2', () => {
    const { onRespond } = renderMenu('2.1.318-question-multi-review-no-other')
    fireEvent.click(screen.getByText('Recusar responder'))
    expect(onRespond).toHaveBeenCalledWith(['2'])
  })
})

describe('ChatView — sentinela "Chat about this" (2.1.317)', () => {
  it('single-select: Conversar sobre isso manda o dígito da sentinela', () => {
    const { onRespond } = renderMenu('2.1.317-question-chat-sentinel')
    fireEvent.click(screen.getByTestId('question-chat'))
    expect(onRespond).toHaveBeenCalledWith(['5'])
    expect(screen.getByText('Resposta enviada…')).toBeTruthy()
  })

  it('cursor no campo do Other: sai dele antes', () => {
    const { onRespond } = renderMenu('2.1.318-question-single-digit-other')
    fireEvent.click(screen.getByTestId('question-chat'))
    expect(onRespond).toHaveBeenCalledWith([UP, '5'])
  })
})

describe('ChatView — menus da CLI pelo card genérico (2.1.317)', () => {
  it('/hooks: card com a opção e Esc; nada de banner de terminal', () => {
    const { onRespond } = renderMenu('2.1.317-unknown-hooks')
    expect(screen.getByTestId('generic-menu').getAttribute('data-kind')).toBe('menu')
    expect(screen.queryByTestId('chat-wait-unrecognized')).toBeNull()
    fireEvent.click(screen.getByTestId('generic-esc'))
    expect(onRespond).toHaveBeenCalledWith(['\x1b'])
  })

  it('/hooks: a opção sem número vai por Enter (cursor já nela)', () => {
    const { onRespond } = renderMenu('2.1.317-unknown-hooks')
    fireEvent.click(screen.getByTestId('generic-option-0'))
    expect(onRespond).toHaveBeenCalledWith(['\r'])
  })

  it('/permissions: abas por →/← e a opção por ↓ + Enter (foco na busca)', async () => {
    const { onRespond } = renderMenu('2.1.317-unknown-permissions')
    fireEvent.click(screen.getByTestId('generic-tab-next'))
    expect(onRespond).toHaveBeenLastCalledWith(['\x1b[C'])
    // Uma resposta por vez: o clique seguinte vem depois que a seta saiu.
    await act(async () => {})
    fireEvent.click(screen.getByTestId('generic-option-0'))
    expect(onRespond).toHaveBeenLastCalledWith([DOWN, '\r'])
  })

  it('/hooks populado (2.1.318): evento como cabeçalho, hook por setas, aviso de mais itens', () => {
    const { onRespond } = renderMenu('2.1.318-populated-hooks-down3')
    expect(screen.queryByTestId('chat-wait-unrecognized')).toBeNull()
    expect(screen.getByText('PostToolUse — after tool execution')).toBeTruthy()
    expect(screen.getByText('mais itens abaixo (role pelo terminal)')).toBeTruthy()
    fireEvent.click(screen.getByTestId('generic-option-5'))
    expect(onRespond).toHaveBeenCalledWith([DOWN, DOWN, '\r'])
  })

  it('/hooks: detalhe do hook só volta com Esc', () => {
    const { onRespond } = renderMenu('2.1.318-populated-hooks-detail')
    expect(screen.getByText('Command hook')).toBeTruthy()
    fireEvent.click(screen.getByText('Voltar (Esc)'))
    expect(onRespond).toHaveBeenCalledWith(['\x1b'])
  })

  it('/permissions com texto na busca: regras sem clique, Esc limpa a busca', () => {
    const { onRespond } = renderMenu('2.1.318-populated-permissions-search')
    expect(screen.getByTestId('generic-search').textContent).toContain('g')
    expect((screen.getByTestId('generic-option-0') as HTMLButtonElement).disabled).toBe(true)
    expect(screen.queryByTestId('generic-tab-next')).toBeNull()
    fireEvent.click(screen.getByText('Limpar busca (Esc)'))
    expect(onRespond).toHaveBeenCalledWith(['\x1b'])
  })

  it('/permissions populado com foco nas abas: regra por ↓ + setas + Enter', () => {
    const { onRespond } = renderMenu('2.1.318-populated-permissions')
    fireEvent.click(screen.getByText('Bash(echo:*)'))
    expect(onRespond).toHaveBeenCalledWith([DOWN, DOWN, DOWN, '\r'])
  })

  it('nudge do auto mode em idle: card pequeno com as 3 opções', () => {
    const { onRespond } = renderMenu('2.1.317-auto-mode-env-nudge', 'idle')
    expect(screen.getByTestId('generic-menu').getAttribute('data-kind')).toBe('nudge')
    expect(screen.getByText('Not now')).toBeTruthy()
    fireEvent.click(screen.getByText("Don't show again"))
    expect(onRespond).toHaveBeenCalledWith(['3'])
  })

  it('submenu do /rewind: nunca vira pergunta; opção com campo vai por setas', () => {
    const { onRespond } = renderMenu('2.1.317-rewind-restore-menu')
    expect(screen.queryByText('Claude perguntou')).toBeNull()
    fireEvent.click(screen.getByText('Summarize from here'))
    expect(onRespond).toHaveBeenCalledWith([DOWN, '\r'])
  })

  it('seletor do /rewind: setas do cursor até a mensagem + Enter', () => {
    const { onRespond } = renderMenu('2.1.317-rewind-picker')
    fireEvent.click(screen.getByText('diga b'))
    expect(onRespond).toHaveBeenCalledWith([UP, UP, '\r'])
  })

  it('waiting sem nada lido: só o aviso com link discreto ao terminal', () => {
    transcript.messages = [{ kind: 'user', text: 'oi' }]
    render(<ChatView sessionId="s-q" status="waiting" tuiMenu={null} onToggleMode={vi.fn()} />)
    expect(screen.getByTestId('chat-wait-unrecognized')).toBeTruthy()
    expect(screen.getByTestId('chat-wait-open-terminal').textContent).toContain('Abrir terminal')
  })
})
