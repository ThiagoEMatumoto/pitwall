import { describe, expect, it, vi } from 'vitest'
import { parseTuiMenu } from './tui-menu-parser'
import { parseWithGrowingWindow, TAIL_WINDOWS } from './tui-read-window'

// Menu de AskUserQuestion com preview por opção, no formato real (bloco
// ┌─…─┐ ao lado da opção destacada). `previewLines` controla a ALTURA total —
// é ela que decidia, silenciosamente, se o card aparecia no chat ou não.
function previewMenu(previewLines: number): string[] {
  const box = ['┌────────────────────────┐']
  for (let i = 0; i < previewLines; i++) box.push(`│ linha de preview ${i}      │`)
  box.push('└────────────────────────┘')
  const pad = ' '.repeat(31)
  return [
    'Contexto anterior da conversa que já rolou na tela.',
    '',
    'Qual layout você prefere?',
    '',
    `❯ 1. Layout A                    ${box[0]}`,
    ...box.slice(1).map((b) => `  ${pad}${b}`),
    '  2. Layout B',
    '  3. Type something.',
    '  4. Chat about this',
    '',
    'Enter to select · ↑/↓ to navigate · Esc to cancel',
  ]
}

// Simula o buffer do xterm: `readTail(n)` devolve as últimas n linhas, como
// readTailText faz sobre buffer.active.
function bufferReader(lines: string[]) {
  return (n: number) => lines.slice(Math.max(0, lines.length - n)).join('\n')
}

describe('parseWithGrowingWindow — regressão do tail fixo de 40 linhas', () => {
  it('menu de 51 linhas (preview de 40): falha em 40, resolve ao ampliar', () => {
    const lines = previewMenu(40)
    expect(lines.length).toBe(51)
    const readTail = bufferReader(lines)
    // O comportamento ANTIGO (janela única de 40) devolvia null — é o bug.
    expect(parseTuiMenu(readTail(40))).toBeNull()
    const menu = parseWithGrowingWindow(readTail, parseTuiMenu, lines.length)
    expect(menu).not.toBeNull()
    expect(menu!.kind).toBe('question')
    expect(menu!.options.map((o) => o.label)).toEqual([
      'Layout A',
      'Layout B',
      'Type something.',
      'Chat about this',
    ])
  })

  it('menu de 71 linhas (preview de 60): idem, resolve numa janela maior', () => {
    const lines = previewMenu(60)
    expect(lines.length).toBe(71)
    const readTail = bufferReader(lines)
    expect(parseTuiMenu(readTail(40))).toBeNull()
    const menu = parseWithGrowingWindow(readTail, parseTuiMenu, lines.length)
    expect(menu!.options).toHaveLength(4)
    expect(menu!.question).toBe('Qual layout você prefere?')
  })

  it('NÃO amplia quando 40 linhas já bastam — caminho idêntico ao de hoje', () => {
    const lines = previewMenu(3)
    const readTail = vi.fn(bufferReader(lines))
    const menu = parseWithGrowingWindow(readTail, parseTuiMenu, lines.length)
    expect(menu).not.toBeNull()
    expect(readTail).toHaveBeenCalledTimes(1)
    expect(readTail).toHaveBeenCalledWith(TAIL_WINDOWS[0])
  })

  it('para de ampliar quando a janela já cobre o buffer inteiro', () => {
    // Buffer curto e sem menu nenhum: uma tentativa, e não insiste nas maiores.
    const readTail = vi.fn(bufferReader(['só conversa', 'sem menu aqui']))
    expect(parseWithGrowingWindow(readTail, parseTuiMenu, 2)).toBeNull()
    expect(readTail).toHaveBeenCalledTimes(1)
  })

  it('esgota as janelas quando o buffer é maior que todas e nada parseia', () => {
    const readTail = vi.fn(bufferReader(Array(500).fill('linha de conversa')))
    expect(parseWithGrowingWindow(readTail, parseTuiMenu, 500)).toBeNull()
    expect(readTail).toHaveBeenCalledTimes(TAIL_WINDOWS.length)
  })
})

describe('parseWithGrowingWindow — a janela maior não ancora na tela ERRADA', () => {
  // Este é o único risco real de ampliar: puxar um menu ANTIGO do scrollback e
  // renderizá-lo como se fosse o momento pendente. Os parsers ancoram no FIM
  // (run contígua terminando na última linha numerada), então o menu antigo
  // fica de fora — provado aqui por teste, não por raciocínio.
  const MENU_ANTIGO = [
    'Qual banco de dados você usa?',
    '',
    '❯ 1. Postgres',
    '  2. MySQL',
    '  3. Type something.',
    '  4. Chat about this',
    '',
    'Enter to select · ↑/↓ to navigate · Esc to cancel',
  ]
  // A TUI sempre separa a conversa do desenho do menu por linha em branco.
  const CONVERSA = [...Array(12).fill('texto da conversa que veio depois da resposta anterior'), '']

  it('com menu antigo acima e menu alto novo abaixo, devolve o NOVO', () => {
    const lines = [...MENU_ANTIGO, ...CONVERSA, ...previewMenu(40)]
    const menu = parseWithGrowingWindow(bufferReader(lines), parseTuiMenu, lines.length)
    expect(menu).not.toBeNull()
    expect(menu!.question).toBe('Qual layout você prefere?')
    expect(menu!.options.map((o) => o.label)).toContain('Layout A')
    expect(menu!.options.map((o) => o.label)).not.toContain('Postgres')
  })

  it('menu antigo seguido só de conversa não vira card (nada pendente)', () => {
    const lines = [...MENU_ANTIGO, ...CONVERSA]
    expect(parseWithGrowingWindow(bufferReader(lines), parseTuiMenu, lines.length)).toBeNull()
  })
})
