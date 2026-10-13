import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import xtermHeadless from '@xterm/headless'
import { describe, expect, it } from 'vitest'
import {
  deriveAttentionReason,
  handoffAsking,
  hasInputPrompt,
  inputBoxRows,
  isUnparsedWaiting,
  scanScreen,
  type ScreenScan,
} from './attention-reason'
import { isInputRule } from './input-rule'

const { Terminal } = xtermHeadless as unknown as {
  Terminal: typeof import('@xterm/headless').Terminal
}

// Capturas BRUTAS do claude 2.1.286 real (node-pty 80x24, ver o .json ao lado):
// o mesmo shape que o pty-manager guarda no backlog.
function fixture(name: string): string {
  return readFileSync(join(__dirname, '__fixtures__', name), 'utf8')
}

async function render(raw: string, cols = 80, rows = 24): Promise<(n: number) => string> {
  const term = new Terminal({ cols, rows, allowProposedApi: true })
  await new Promise<void>((resolve) => term.write(raw, resolve))
  return (n: number) => {
    const buf = term.buffer.active
    let text = ''
    for (let y = Math.max(0, buf.length - n); y < buf.length; y++) {
      text += (buf.getLine(y)?.translateToString(true) ?? '') + '\n'
    }
    return text
  }
}

async function scanFixture(name: string, cols?: number, rows?: number): Promise<ScreenScan> {
  const readTail = await render(fixture(name), cols, rows)
  return scanScreen(readTail, 1000)
}

describe('scanScreen — capturas reais do claude 2.1.286', () => {
  it('reconhece o menu de permissão de Bash com as 4 opções', async () => {
    const scan = await scanFixture('claude-2.1.286-permission-bash.ansi')
    expect(scan.menu?.kind).toBe('permission')
    expect(scan.menu?.question).toBe('Do you want to proceed?')
    expect(scan.menu?.options.map((o) => o.label)).toEqual([
      'Yes',
      expect.stringMatching(/^Yes, and always allow access to /),
      expect.stringMatching(/^Yes, and switch to auto mode/),
      'No',
    ])
    expect(scan.menu?.context).toContain('touch permissao-fixture.txt')
    expect(scan.inputPrompt).toBe(false)
  })

  it('2.1.295: caixa de input de sessão nomeada e sem nome', async () => {
    for (const name of ['claude-2.1.295-named-idle-45x50.ansi', 'claude-2.1.295-unnamed-idle-45x50.ansi']) {
      const scan = await scanFixture(name, 45, 50)
      expect(scan.menu, name).toBeNull()
      expect(scan.inputPrompt, name).toBe(true)
    }
  })

  it('reconhece a caixa de input ociosa como prompt, sem menu', async () => {
    const scan = await scanFixture('claude-2.1.286-idle-prompt.ansi')
    expect(scan.menu).toBeNull()
    expect(scan.inputPrompt).toBe(true)
  })

  // O trust do 2.1.286 perdeu a numeração ("❯ No, exit / Yes, I trust this
  // folder") — o parser, fail-closed, não reconhece. E a captura real registra que
  // o sessions/<pid>.json AINDA NÃO EXISTE nessa tela: sem arquivo não há 'waiting'
  // (a sessão é 'starting'), então nem o contador nem a fila enxergam o trust —
  // Confiar/Sair pelo popover não tem caminho no 2.1.286 (pendência conhecida).
  it('trust sem numeração: não parseia e, com o status real (starting), não conta', async () => {
    const scan = await scanFixture('claude-2.1.286-trust-unnumbered.ansi')
    expect(scan.menu).toBeNull()
    expect(scan.inputPrompt).toBe(false)
    expect(isUnparsedWaiting('starting', scan)).toBe(false)
  })
})

describe('hasInputPrompt', () => {
  const RULE = '─'.repeat(40)
  it('exige a linha ❯ entre as réguas da caixa de input', () => {
    expect(hasInputPrompt(`${RULE}\n❯ \n${RULE}\n  ? for shortcuts\n`)).toBe(true)
    expect(hasInputPrompt('❯ 1. Yes\n  2. No\n')).toBe(false)
    expect(hasInputPrompt('texto qualquer\n')).toBe(false)
  })

  // claude 2.1.295 com -n desenha o nome da sessão na régua de cima.
  it('aceita a régua de cima com o nome da sessão embutido', () => {
    const named = `${'─'.repeat(28)} kzprobe-b-7731 ─`
    expect(hasInputPrompt(`${named}\n❯ \n${RULE}\n`)).toBe(true)
    expect(inputBoxRows([named, '❯ oi', 'segunda', RULE])).toEqual({ start: 1, end: 3 })
  })
})

describe('isInputRule', () => {
  it('régua cheia e régua com rótulo', () => {
    expect(isInputRule('─'.repeat(10))).toBe(true)
    expect(isInputRule(`${'─'.repeat(28)} kzprobe-b-7731 ─`)).toBe(true)
    expect(isInputRule(`${'─'.repeat(9)} Pitwall ─`)).toBe(true)
  })

  it('rejeita o que não é a régua da caixa de input', () => {
    expect(isInputRule('─'.repeat(9))).toBe(false)
    expect(isInputRule('─── a ─')).toBe(false) // poucos traços no total
    expect(isInputRule(`texto do usuário ${'─'.repeat(20)}`)).toBe(false)
    expect(isInputRule(`${'─'.repeat(20)} texto solto`)).toBe(false)
    expect(isInputRule(`${'─'.repeat(10)}${'─'.repeat(10)}x`)).toBe(false)
    expect(isInputRule(`${'─'.repeat(10)}┼${'─'.repeat(10)}`)).toBe(false) // tabela markdown
    expect(isInputRule(`${'─'.repeat(10)} a │ b ${'─'.repeat(10)}`)).toBe(false)
    expect(isInputRule(`${'-'.repeat(20)} nome -`)).toBe(false)
    expect(isInputRule(`${'╌'.repeat(20)}`)).toBe(false)
  })
})

const PERMISSION_SCAN: ScreenScan = {
  menu: {
    kind: 'permission',
    question: 'Do you want to proceed?',
    options: [
      { index: 0, label: 'Yes' },
      { index: 1, label: 'No' },
    ],
    multiSelect: false,
    submitOnDigit: true,
  },
  inputPrompt: false,
  nonBlankLines: 8,
}
const PROMPT_SCAN: ScreenScan = { menu: null, inputPrompt: true, nonBlankLines: 6 }
const GARBAGE_SCAN: ScreenScan = { menu: null, inputPrompt: false, nonBlankLines: 12 }

describe('deriveAttentionReason', () => {
  it('waiting + menu de permissão → permission', () => {
    expect(
      deriveAttentionReason({ status: 'waiting', scan: PERMISSION_SCAN, handoffAsking: false }),
    ).toBe('permission')
  })

  it('waiting + caixa de input → turn-end', () => {
    expect(
      deriveAttentionReason({ status: 'waiting', scan: PROMPT_SCAN, handoffAsking: false }),
    ).toBe('turn-end')
  })

  it('limpa na borda working, mesmo com o menu ainda desenhado', () => {
    expect(
      deriveAttentionReason({ status: 'working', scan: PERMISSION_SCAN, handoffAsking: false }),
    ).toBeUndefined()
  })

  it('handoff-input tem precedência sobre o menu e sobre o status', () => {
    expect(
      deriveAttentionReason({ status: 'waiting', scan: PERMISSION_SCAN, handoffAsking: true }),
    ).toBe('handoff-input')
    expect(deriveAttentionReason({ status: 'working', scan: null, handoffAsking: true })).toBe(
      'handoff-input',
    )
  })

  it('sem PTY observada ou tela não reconhecida → sem motivo (fica como hoje)', () => {
    expect(
      deriveAttentionReason({ status: 'waiting', scan: null, handoffAsking: false }),
    ).toBeUndefined()
    expect(
      deriveAttentionReason({ status: 'waiting', scan: GARBAGE_SCAN, handoffAsking: false }),
    ).toBeUndefined()
  })
})

describe('isUnparsedWaiting', () => {
  it('só conta waiting com tela cheia e nada reconhecido', () => {
    expect(isUnparsedWaiting('waiting', GARBAGE_SCAN)).toBe(true)
    expect(isUnparsedWaiting('working', GARBAGE_SCAN)).toBe(false)
    expect(isUnparsedWaiting('waiting', PERMISSION_SCAN)).toBe(false)
    expect(isUnparsedWaiting('waiting', PROMPT_SCAN)).toBe(false)
    expect(isUnparsedWaiting('waiting', { ...GARBAGE_SCAN, nonBlankLines: 2 })).toBe(false)
  })
})

describe('handoffAsking', () => {
  it('needs_input sem progresso depois da pergunta', () => {
    expect(handoffAsking({ status: 'needs_input', questionAskedAt: 10, stepUpdatedAt: 5 })).toBe(
      true,
    )
    expect(handoffAsking({ status: 'needs_input', questionAskedAt: 10, stepUpdatedAt: 20 })).toBe(
      false,
    )
    expect(handoffAsking({ status: 'running', questionAskedAt: 10, stepUpdatedAt: null })).toBe(
      false,
    )
  })
})
