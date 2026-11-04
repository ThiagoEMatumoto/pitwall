import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { parseTuiMenu, type TuiMenu } from '../../../../shared/tui/tui-menu-parser'
import type { InputBoxState } from '../../../../shared/tui/input-draft'
import { parseTuiPicker, type TuiPicker } from '../tui-picker-parser'

vi.mock('@/lib/ipc', () => {
  const inert = new Proxy(
    {},
    {
      get: (_t, key: string) =>
        key.startsWith('on') ? () => () => {} : () => Promise.resolve(null),
    },
  )
  return new Proxy({ chatApi: inert }, { get: () => inert })
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

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver

// Telas reais do claude 2.1.318 (sondas history-* e rewind-*; ver os testes de parser).
const raw = (name: string) =>
  readFileSync(
    join(__dirname, `../../../../shared/tui/__fixtures__/claude-2.1.318-${name}.txt`),
    'utf8',
  )
const menuOf = (name: string): TuiMenu => parseTuiMenu(raw(name))!
const pickerOf = (name: string): TuiPicker => parseTuiPicker(raw(name))!
const UP = '\x1b[A'
const DOWN = '\x1b[B'
const ESC = '\x1b'
const EMPTY_INPUT: InputBoxState = { prompt: true, draft: null }

// As 10 mensagens da sessão das capturas do rewind, na ordem.
const REWIND_SESSION = [
  'Responda só: ok zero.',
  'Crie o arquivo notas.txt contendo só a linha: um. Não faça mais nada.',
  'Responda só: ok dois.',
  "Acrescente a linha 'tres' ao final de notas.txt. Não faça mais nada.",
  'Crie o arquivo extra.txt contendo só a linha: quatro. Não faça mais nada.',
  'Responda só: ok cinco.',
  "Acrescente a linha 'seis' ao final de notas.txt. Não faça mais nada.",
  'Responda só: ok sete.',
  "Acrescente a linha 'oito' ao final de extra.txt. Não faça mais nada.",
  'Responda só: ok nove.',
]

function renderPicker(name: string) {
  transcript.messages = []
  const onRespond = vi.fn()
  render(
    <ChatView
      sessionId="s-h"
      status="idle"
      tuiPicker={pickerOf(name)}
      reparsePicker={() => pickerOf(name)}
      onRespond={onRespond}
    />,
  )
  return onRespond
}

describe('ChatView — Ctrl+R (2.1.318)', () => {
  it('sem fullscreen: mostra o match e diz que aceitar ENVIA', () => {
    const onRespond = renderPicker('history-query')
    expect(screen.getByTestId('history-match').textContent).toContain('diga lima')
    expect(screen.getByTestId('history-accept').textContent).toBe('Enviar este prompt (Enter)')
    expect(screen.getByTestId('history-effect').textContent).toMatch(
      /manda o prompt ao Claude na hora/,
    )
    fireEvent.change(screen.getByTestId('history-query'), { target: { value: 'diga g' } })
    expect(onRespond).toHaveBeenLastCalledWith([' g'])
    fireEvent.click(screen.getByTestId('history-older'))
    expect(onRespond).toHaveBeenLastCalledWith(['\x12'])
    fireEvent.click(screen.getByTestId('history-accept'))
    expect(onRespond).toHaveBeenLastCalledWith(['\r'])
  })

  it('sem fullscreen: só preencher é Tab', () => {
    const onRespond = renderPicker('history-query')
    fireEvent.click(screen.getByTestId('history-fill'))
    expect(onRespond).toHaveBeenLastCalledWith(['\t'])
  })

  it('fullscreen: lista clicável, aceitar só PREENCHE, escopo', () => {
    const onRespond = renderPicker('fullscreen-history-modal-query')
    expect(screen.getByTestId('history-accept').textContent).toBe('Usar este prompt (Enter)')
    expect(screen.getByTestId('history-effect').textContent).toMatch(/nada é enviado/)
    expect(screen.queryByTestId('history-fill')).toBeNull()
    fireEvent.click(screen.getByTestId('history-result-5'))
    expect(onRespond).toHaveBeenLastCalledWith([UP, UP])
    fireEvent.click(screen.getByTestId('history-scope'))
    expect(onRespond).toHaveBeenLastCalledWith(['\x13'])
    fireEvent.click(screen.getByTestId('history-cancel'))
    expect(onRespond).toHaveBeenLastCalledWith([ESC])
  })

  it('sem match: aceitar desabilitado', () => {
    renderPicker('history-no-match')
    expect((screen.getByTestId('history-accept') as HTMLButtonElement).disabled).toBe(true)
  })
})

// O seletor muda de tela conforme as teclas que o card manda.
function rewindTerminal(after: { open: string; nav: string }) {
  let screenMenu: TuiMenu | null = null
  const onRespond = vi.fn(async (keys: string[]) => {
    if (keys[0] === ESC && keys[1] === ESC) screenMenu = menuOf(after.open)
    else if (keys[0] === UP) screenMenu = menuOf(after.nav)
    else if (keys[0] === '\r') screenMenu = menuOf('rewind-submenu-code')
    return true
  })
  return { onRespond, reparseMenu: () => screenMenu }
}

function renderRewind(
  t: ReturnType<typeof rewindTerminal>,
  status: 'idle' | 'working' = 'idle',
  input = EMPTY_INPUT,
) {
  transcript.messages = REWIND_SESSION.map((text) => ({ kind: 'user' as const, text }))
  return render(
    <ChatView
      sessionId="s-r"
      status={status}
      onRespond={t.onRespond}
      reparseMenu={t.reparseMenu}
      readCliInput={() => input}
    />,
  )
}

describe('ChatView — Voltar a este ponto (2.1.318)', () => {
  it('Esc-Esc, setas até a 5ª mensagem, confere a tela e Enter abre o submenu', async () => {
    const t = rewindTerminal({ open: 'rewind-picker-populated', nav: 'rewind-picker-code' })
    renderRewind(t)
    const buttons = screen.getAllByTestId('rewind-here')
    expect(buttons).toHaveLength(10)
    fireEvent.click(buttons[4])
    await waitFor(() => expect(t.onRespond).toHaveBeenCalledTimes(3))
    expect(t.onRespond.mock.calls[0]).toEqual([[ESC, ESC], 200])
    expect(t.onRespond.mock.calls[1]).toEqual([Array(6).fill(UP), 60])
    expect(t.onRespond.mock.calls[2][0]).toEqual(['\r'])
  })

  it('fullscreen (lista rolada): mesmas setas pela contagem "↑ N more"', async () => {
    const t = rewindTerminal({
      open: 'fullscreen-rewind-picker-populated',
      nav: 'fullscreen-rewind-picker-code',
    })
    renderRewind(t)
    fireEvent.click(screen.getAllByTestId('rewind-here')[4])
    await waitFor(() => expect(t.onRespond).toHaveBeenCalledTimes(3))
    expect(t.onRespond.mock.calls[1][0]).toEqual(Array(6).fill(UP))
  })

  it('a tela não confirma a mensagem: nada de Enter, o seletor fica para o usuário', async () => {
    // Depois das setas o cursor segue em (current): a captura não bate com o alvo.
    const t = rewindTerminal({ open: 'rewind-picker-populated', nav: 'rewind-picker-populated' })
    renderRewind(t)
    fireEvent.click(screen.getAllByTestId('rewind-here')[4])
    await waitFor(
      () =>
        expect(screen.getByTestId('rewind-notice').textContent).toMatch(/Não achei essa mensagem/),
      {
        timeout: 4000,
      },
    )
    expect(t.onRespond.mock.calls.some((c) => c[0][0] === '\r')).toBe(false)
  })

  it('com o Claude trabalhando ou texto na caixa do terminal: não manda Esc', () => {
    const t = rewindTerminal({ open: 'rewind-picker-populated', nav: 'rewind-picker-code' })
    const { unmount } = renderRewind(t, 'working')
    expect((screen.getAllByTestId('rewind-here')[4] as HTMLButtonElement).disabled).toBe(true)
    unmount()
    renderRewind(t, 'idle', { prompt: true, draft: 'rascunho' })
    fireEvent.click(screen.getAllByTestId('rewind-here')[4])
    expect(t.onRespond).not.toHaveBeenCalled()
    expect(screen.getByTestId('rewind-notice').textContent).toMatch(/caixa do terminal tem texto/)
  })
})

describe('ChatView — submenu do /rewind e caixa do terminal (2.1.318)', () => {
  function renderSubmenu() {
    transcript.messages = []
    const onRespond = vi.fn()
    render(
      <ChatView
        sessionId="s-s"
        status="waiting"
        tuiMenu={menuOf('rewind-submenu-code')}
        reparseMenu={() => menuOf('rewind-submenu-code')}
        onRespond={onRespond}
      />,
    )
    return onRespond
  }

  it('opções reais com o aviso; Summarize com contexto vai por setas + texto + Enter', () => {
    const onRespond = renderSubmenu()
    expect(screen.getByTestId('generic-warning').textContent).toMatch(
      /Restored files go back whole/,
    )
    fireEvent.change(screen.getByTestId('generic-input-3'), { target: { value: 'foco nas notas' } })
    fireEvent.click(screen.getByTestId('generic-input-send-3'))
    expect(onRespond).toHaveBeenLastCalledWith([DOWN, DOWN, DOWN, 'foco nas notas', '\r'], 150)
  })

  it('Restore conversation é o dígito da opção e avisa que o chat só muda na próxima mensagem', () => {
    const onRespond = renderSubmenu()
    fireEvent.click(screen.getByTestId('generic-option-1'))
    expect(onRespond).toHaveBeenLastCalledWith(['2'])
    expect(screen.getByTestId('rewind-notice').textContent).toMatch(/A conversa voltou no terminal/)
  })

  it('"mostrar mais" anda o cursor até o Never mind aparecer', () => {
    const onRespond = renderSubmenu()
    fireEvent.click(screen.getByTestId('generic-scroll-down'))
    expect(onRespond).toHaveBeenLastCalledWith(Array(5).fill(DOWN))
  })

  it('texto na caixa do terminal: aviso com Enviar e Limpar, só com o mesmo texto lá', () => {
    transcript.messages = []
    const onRespond = vi.fn()
    let input: InputBoxState = { prompt: true, draft: 'diga india' }
    render(
      <ChatView
        sessionId="s-d"
        status="idle"
        cliDraft="diga india"
        readCliInput={() => input}
        onRespond={onRespond}
      />,
    )
    expect(screen.getByTestId('cli-draft').textContent).toContain('diga india')
    fireEvent.click(screen.getByTestId('cli-draft-send'))
    expect(onRespond).toHaveBeenLastCalledWith(['\r'])
    fireEvent.click(screen.getByTestId('cli-draft-clear'))
    expect(onRespond).toHaveBeenLastCalledWith([ESC, ESC], 200)
    // A caixa já esvaziou: Esc-Esc abriria o rewind.
    input = EMPTY_INPUT
    onRespond.mockClear()
    fireEvent.click(screen.getByTestId('cli-draft-clear'))
    expect(onRespond).not.toHaveBeenCalled()
  })
})
