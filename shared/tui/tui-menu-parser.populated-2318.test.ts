import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import xtermHeadless from '@xterm/headless'
import { describe, expect, it } from 'vitest'
import { keysForAction } from './menu-actions'
import { isKnownMenu, parseTuiMenu, parseTuiMenuFull, type TuiMenu } from './tui-menu-parser'

const { Terminal } = xtermHeadless as unknown as {
  Terminal: typeof import('@xterm/headless').Terminal
}

// /hooks e /permissions COM conteúdo (sonda populated-menus, claude 2.1.318, PTY 120x45):
// 24 hooks em 7 eventos e 18 regras. As fixtures unknown-* só tinham as telas vazias, e a
// tela populada caía em "tela que o chat não reconheceu".
function fixture(name: string): string {
  return readFileSync(join(__dirname, '__fixtures__', `claude-2.1.318-populated-${name}`), 'utf8')
}
const txt = (name: string) => parseTuiMenu(fixture(`${name}.txt`))

async function parseAnsi(name: string): Promise<TuiMenu | null> {
  const term = new Terminal({ cols: 120, rows: 45, allowProposedApi: true, scrollback: 2000 })
  await new Promise<void>((resolve) => term.write(fixture(`${name}.ansi`), resolve))
  const readTail = (n: number) => {
    const buf = term.buffer.active
    let text = ''
    for (let y = Math.max(0, buf.length - n); y < buf.length; y++)
      text += (buf.getLine(y)?.translateToString(true) ?? '') + '\n'
    return text
  }
  return parseTuiMenuFull(readTail, term.buffer.active.length)
}

const UP = '\x1b[A'
const DOWN = '\x1b[B'
const select = (m: TuiMenu, optionIndex: number) =>
  keysForAction(m, { kind: 'select', optionIndex })
const labels = (m: TuiMenu | null) => m?.options.map((o) => o.label)

describe('/hooks populado', () => {
  it('lista agrupada: só as linhas [Fonte] são opções; o evento é o grupo', async () => {
    const menu = (await parseAnsi('hooks'))!
    expect(menu).toMatchObject({
      kind: 'menu',
      question: 'Hooks',
      navigation: 'arrows',
      cursorIndex: 0,
      moreBelow: true,
      footer: 'Enter to view · Esc to close',
    })
    expect(menu.moreAbove).toBeUndefined()
    expect(isKnownMenu(menu)).toBe(true)
    expect(menu.context).toMatch(/^24 hooks on 7 events\n/)
    expect(menu.options).toHaveLength(14)
    expect(menu.options[0]).toMatchObject({
      label: '[Project] true pitwall-hook-4 · Agent · command',
      group: 'PreToolUse — before tool execution',
    })
    expect(menu.options[5].group).toBe('PostToolUse — after tool execution')
    expect(labels(menu)!.every((l) => l.startsWith('[Project] '))).toBe(true)
  })

  it('↓ pula o cabeçalho do evento: setas contam só as linhas de hook, nunca dígito', () => {
    const menu = txt('hooks-down3')!
    expect(menu.cursorIndex).toBe(3)
    expect(menu.options[3].label).toMatch(/pitwall-hook-5 /)
    // Opção 5 = 1º hook do PostToolUse: o cabeçalho entre eles não é parada (na sonda, 21 ↓
    // a partir do 1º hook pousaram no 1º do PreCompact, 6 cabeçalhos depois).
    expect(select(menu, 5)).toEqual([DOWN, DOWN, '\r'])
    expect(select(menu, 0)).toEqual([UP, UP, UP, '\r'])
    expect(menu.submitOnDigit).toBe(false)
  })

  it('rolado: "↑ 10 more" e "↓ 3 more" ficam fora das opções', () => {
    const menu = txt('hooks-scrolled')!
    expect(menu.moreAbove).toBe(true)
    expect(menu.moreBelow).toBe(true)
    expect(labels(menu)!.some((l) => /more$/.test(l))).toBe(false)
    // O cabeçalho do 1º hook visível rolou para fora: sem grupo.
    expect(menu.options[0]).toMatchObject({ label: '[Project] true pitwall-hook-21 · command' })
    expect(menu.options[0].group).toBeUndefined()
    const cur = menu.options[menu.cursorIndex!]
    expect(cur).toMatchObject({
      label: '[Project] true pitwall-hook-24 · command',
      group: 'PreCompact — before conversation compaction',
    })
  })

  it('detalhe do hook (Enter): tela só de leitura, só Esc', () => {
    const menu = txt('hooks-detail')!
    expect(menu).toMatchObject({
      kind: 'menu',
      question: 'Command hook',
      options: [],
      footer: 'Esc to go back',
    })
    expect(isKnownMenu(menu)).toBe(true)
    expect(menu.context).toContain('true pitwall-hook-24')
    expect(menu.context).not.toMatch(/╌/)
    expect(keysForAction(menu, { kind: 'esc' })).toEqual(['\x1b'])
  })
})

describe('/permissions populado', () => {
  it('Allow com foco nas abas: 10 regras visíveis, abas, ↓ + setas + Enter (dígito iria para a busca)', async () => {
    const menu = (await parseAnsi('permissions'))!
    expect(menu).toMatchObject({
      kind: 'menu',
      question: 'Permissions',
      tabSwitch: true,
      listFocusKey: true,
      moreBelow: true,
    })
    expect(menu.cursorIndex).toBeUndefined()
    expect(menu.tabs?.map((t) => t.label)).toEqual([
      'Recently blocked',
      'Allow',
      'Ask',
      'Deny',
      'Auto mode',
      'Workspace',
    ])
    expect(menu.context).toBe("Claude Code won't ask before using allowed tools.")
    expect(menu.options.map((o) => o.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
    expect(menu.options[0].label).toBe('Add a new rule…')
    expect(menu.options[9].label).toBe('Glob')
    expect(select(menu, 3)).toEqual([DOWN, DOWN, DOWN, DOWN, '\r'])
    expect(keysForAction(menu, { kind: 'tab', direction: 'next' })).toEqual(['\x1b[C'])
  })

  it('Ask e Deny (2+ regras numeradas a partir de 1) não viram pergunta do AskUserQuestion', () => {
    for (const name of ['permissions-ask', 'permissions-deny', 'permissions-ask-list']) {
      const menu = txt(name)
      expect(menu?.kind, name).toBe('menu')
      expect(menu?.question, name).toBe('Permissions')
      expect(menu?.options, name).toHaveLength(4)
    }
    expect(txt('permissions-ask')?.context).toMatch(/^Claude Code will always ask/)
    expect(labels(txt('permissions-deny'))).toEqual([
      'Add a new rule…',
      'Bash(curl:*)',
      'Bash(rm -rf:*)',
      'Read(./.env)',
    ])
  })

  it('cursor na lista: o dígito abre a regra (sonda: 4 abriu o item 4)', () => {
    const menu = txt('permissions-list')!
    expect(menu.cursorIndex).toBe(0)
    expect(menu.listFocusKey).toBeUndefined()
    expect(select(menu, 3)).toEqual(['4'])
    // Dois dígitos não existem no handler: setas.
    expect(select(menu, 9)).toEqual([...Array(9).fill(DOWN), '\r'])
  })

  it('lista rolada ("↑ 3." no topo): número absoluto, mas só setas a partir do cursor', () => {
    const menu = txt('permissions-list-scrolled')!
    expect(menu.moreAbove).toBe(true)
    expect(menu.navigation).toBe('arrows')
    expect(menu.options[0]).toMatchObject({ index: 2, label: 'Bash(echo:*)' })
    expect(menu.options.at(-1)).toMatchObject({ index: 11, label: 'Read(./src/**)' })
    expect(menu.cursorIndex).toBe(11)
    expect(select(menu, 9)).toEqual([UP, UP, '\r'])
  })

  it('dígito com foco nas abas vai para a busca: sem resultado, só Esc', () => {
    const menu = txt('permissions-digit')!
    expect(menu).toMatchObject({ kind: 'menu', question: 'Permissions', search: '3', options: [] })
    expect(menu.tabs).toHaveLength(6)
    expect(menu.tabSwitch).toBeUndefined()
    expect(menu.listFocusKey).toBeUndefined()
    expect(keysForAction(menu, { kind: 'tab', direction: 'next' })).toEqual([])
    expect(keysForAction(menu, { kind: 'esc' })).toEqual(['\x1b'])
  })

  it('busca com texto: lista filtrada sem caminho seguro (Enter/↓ pousa onde a sonda não previu)', () => {
    const menu = txt('permissions-search')!
    expect(menu.search).toBe('g')
    expect(labels(menu)).toEqual([
      'Bash(git diff:*)',
      'Bash(git log:*)',
      'Bash(git status:*)',
      'Glob',
      'Grep',
    ])
    for (const o of menu.options) expect(select(menu, o.index)).toEqual([])
    const cleared = txt('permissions-search-esc')!
    expect(cleared.search).toBeUndefined()
    expect(cleared.footer).toMatch(/Esc to clear/)
    for (const o of cleared.options) expect(select(cleared, o.index)).toEqual([])
  })

  it('regra de projeto: "Delete ask tool?" com o cursor em No', () => {
    const menu = txt('permissions-delete')!
    expect(menu).toMatchObject({
      kind: 'menu',
      question: 'Delete ask tool?',
      cursorIndex: 1,
      navigation: 'arrows',
    })
    expect(isKnownMenu(menu)).toBe(true)
    expect(labels(menu)).toEqual(['Yes', 'No'])
    expect(menu.context).toContain('Bash(git push:*)')
    expect(menu.context).toContain('Are you sure you want to delete this permission rule?')
    expect(select(menu, 1)).toEqual(['\r'])
    expect(select(menu, 0)).toEqual([UP, '\r'])
  })

  it('regra de fonte read-only: "Rule details" só com Esc', () => {
    const menu = txt('permissions-rule-readonly')!
    expect(menu).toMatchObject({
      kind: 'menu',
      question: 'Rule details',
      options: [],
      footer: 'Esc to cancel',
    })
    expect(menu.context).toContain('Bash(git diff:*)')
  })

  it('tela sem opção com título desconhecido e só Esc continua sem menu', () => {
    const raw = fixture('permissions-rule-readonly.txt').replace('Rule details', 'Rule summary')
    expect(parseTuiMenu(raw)).toBeNull()
  })
})
