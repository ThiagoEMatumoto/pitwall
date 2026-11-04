import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { parseTuiMenu, type TuiMenu } from '../../../../shared/tui/tui-menu-parser'

vi.mock('@/lib/ipc', () => {
  const inert = new Proxy(
    {},
    { get: (_t, key: string) => (key.startsWith('on') ? () => () => {} : () => Promise.resolve(null)) },
  )
  return new Proxy({}, { get: () => inert })
})
vi.mock('./useChatTranscript', () => ({
  useChatTranscript: () => ({ messages: [], loading: false, transcriptExists: true, lastPlanFilePath: null }),
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

  it('Other com texto já digitado no terminal: mostra o texto, sem campo', () => {
    renderMenu('2.1.317-question-multi-other-typed')
    expect(screen.getByTestId('question-other-typed').textContent).toContain('verde agua')
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
