import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import xtermHeadless from '@xterm/headless'
import { describe, expect, it } from 'vitest'
import { scanScreen } from './attention-reason'
import {
  classifyChoice,
  permissionSummary,
  sanitizeSummary,
  stripUnsafeDisplay,
} from './permission-request'
import { parseTuiMenu, type TuiMenu } from './tui-menu-parser'

const { Terminal } = xtermHeadless as unknown as {
  Terminal: typeof import('@xterm/headless').Terminal
}

// Captura BRUTA do claude 2.1.286 (a mesma do attention-reason.test.ts),
// renderizada no xterm headless como o tui-menu-watch faz no main.
async function realPermissionMenu(): Promise<TuiMenu> {
  const raw = readFileSync(join(__dirname, '__fixtures__', 'claude-2.1.286-permission-bash.ansi'), 'utf8')
  const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true })
  await new Promise<void>((resolve) => term.write(raw, resolve))
  const scan = scanScreen((n) => {
    const buf = term.buffer.active
    let text = ''
    for (let y = Math.max(0, buf.length - n); y < buf.length; y++) {
      text += (buf.getLine(y)?.translateToString(true) ?? '') + '\n'
    }
    return text
  }, 1000)
  if (!scan.menu) throw new Error('captura real não parseou')
  return scan.menu
}

describe('pedido de permissão estruturado — captura real 2.1.286', () => {
  it('extrai tool e comando entre as réguas ╌, sem a descrição nem o Tip', async () => {
    const menu = await realPermissionMenu()
    expect(menu.request).toEqual({ tool: 'Bash', command: 'touch permissao-fixture.txt' })
    expect(permissionSummary(menu)).toBe('Bash: touch permissao-fixture.txt')
  })

  it('classifica as opções reais do menu', async () => {
    const menu = await realPermissionMenu()
    const choice = (i: number) => classifyChoice(menu, { kind: 'select', optionIndex: i })
    expect([0, 1, 2, 3].map(choice)).toEqual(['approve', 'always', 'always', 'deny'])
  })
})

describe('pedido de permissão — formatos sem régua ╌', () => {
  it('Edit: alvo vem da pergunta, tool do cabeçalho', () => {
    const menu = parseTuiMenu(`╭──────────────────────────────╮
│ Edit file                    │
│ src/foo.ts                   │
╰──────────────────────────────╯
Do you want to make this edit to src/foo.ts?

❯ 1. Yes
  2. Yes, allow all edits during this session
  3. No, and tell Claude what to do differently (esc)

Esc to cancel
`)
    expect(menu?.request).toEqual({ tool: 'Edit', command: 'src/foo.ts' })
  })

  it('sem nada reconhecível: sem request, resumo cai na pergunta', () => {
    const menu = parseTuiMenu(`Allow tool use?

❯ 1. Yes
  2. Yes, and don't ask again for this command
  3. No, and tell Claude what to do differently (esc)

Esc to cancel
`)
    expect(menu?.request).toBeUndefined()
    expect(permissionSummary(menu!)).toBe('Allow tool use?')
  })
})

describe('sanitizeSummary', () => {
  it('tira ANSI/controle, achata e trunca com reticências', () => {
    expect(sanitizeSummary('rm \x1b[31m-rf\x1b[0m\n  ./dist\x07')).toBe('rm -rf ./dist')
    const long = sanitizeSummary('x'.repeat(200))
    expect(long).toHaveLength(80)
    expect(long.endsWith('…')).toBe(true)
  })

  it('tira bidi/zero-width/C1 e quebra Unicode (disfarce do comando)', () => {
    expect(sanitizeSummary('echo ok\u202e fr- mr\u202c')).toBe('echo ok fr- mr')
    expect(sanitizeSummary('r\u200bm\u2066 -rf\u2069')).toBe('rm -rf')
    expect(sanitizeSummary('a\u2028b\u0085c')).toBe('a b c')
  })
})

describe('stripUnsafeDisplay', () => {
  it('tira bidi e controle mas mantém as linhas do contexto', () => {
    expect(stripUnsafeDisplay('Bash command\n  echo ok\u202e fr- mr\u2069\x1b[31m\x07\n')).toBe(
      'Bash command\n  echo ok fr- mr \n',
    )
  })
})
