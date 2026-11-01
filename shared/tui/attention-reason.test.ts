import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import xtermHeadless from '@xterm/headless'
import { describe, expect, it } from 'vitest'
import {
  deriveAttentionReason,
  handoffAsking,
  hasInputPrompt,
  isUnparsedWaiting,
  scanScreen,
  type ScreenScan,
} from './attention-reason'

const { Terminal } = xtermHeadless as unknown as {
  Terminal: typeof import('@xterm/headless').Terminal
}

// Capturas BRUTAS do claude 2.1.286 real (node-pty 80x24, ver o .json ao lado):
// o mesmo shape que o pty-manager guarda no backlog.
function fixture(name: string): string {
  return readFileSync(join(__dirname, '__fixtures__', name), 'utf8')
}

async function render(raw: string): Promise<(n: number) => string> {
  const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true })
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

async function scanFixture(name: string): Promise<ScreenScan> {
  const readTail = await render(fixture(name))
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

  it('reconhece a caixa de input ociosa como prompt, sem menu', async () => {
    const scan = await scanFixture('claude-2.1.286-idle-prompt.ansi')
    expect(scan.menu).toBeNull()
    expect(scan.inputPrompt).toBe(true)
  })

  // O trust do 2.1.286+ perdeu a numeração ("❯ No, exit / Yes, I trust this
  // folder") e a captura real registra que o sessions/<pid>.json AINDA NÃO EXISTE
  // nessa tela: a sessão é 'starting'. Antes o parser não reconhecia e a filha
  // parada aqui não entrava na fila; agora o trust vira motivo de atenção.
  it('trust sem numeração: reconhecido como trust e, com o status real (starting), pede atenção', async () => {
    const scan = await scanFixture('claude-2.1.286-trust-unnumbered.ansi')
    expect(scan.menu?.kind).toBe('trust')
    expect(scan.menu?.options).toEqual([])
    expect(scan.menu?.question).toMatch(/^Quick safety check: Is this a project/)
    expect(scan.menu?.context).toContain('cwd-1790802817529')
    expect(scan.inputPrompt).toBe(false)
    expect(deriveAttentionReason({ status: 'starting', scan, handoffAsking: false })).toBe('trust')
  })
})

describe('hasInputPrompt', () => {
  const RULE = '─'.repeat(40)
  it('exige a linha ❯ entre as réguas da caixa de input', () => {
    expect(hasInputPrompt(`${RULE}\n❯ \n${RULE}\n  ? for shortcuts\n`)).toBe(true)
    expect(hasInputPrompt('❯ 1. Yes\n  2. No\n')).toBe(false)
    expect(hasInputPrompt('texto qualquer\n')).toBe(false)
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
