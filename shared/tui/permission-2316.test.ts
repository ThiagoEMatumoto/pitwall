import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseTuiMenu, parseTuiMenuFull } from './tui-menu-parser'
import { buildAmendKeys } from './respond-keys'
import { classifyChoice } from './permission-request'

// Telas reais do claude 2.1.316 (sonda e2e/scenarios/probe-chat-permission-2316.ts,
// sessão em sandbox, sem allow para o comando): Bash, Edit longo, Create, MCP e o
// fluxo Tab-to-amend.
function fixture(name: string): string {
  return readFileSync(join(__dirname, '__fixtures__', `claude-2.1.316-${name}.txt`), 'utf8')
}

const tailOf = (text: string) => (n: number) => text.split('\n').slice(-n).join('\n')

describe('permissão 2.1.316 — Edit com diff longo', () => {
  const screen = fixture('permission-edit-long-diff')

  it('o context vai da régua do topo até a pergunta, com o arquivo e o diff inteiro', () => {
    const menu = parseTuiMenu(screen)!
    expect(menu.kind).toBe('permission')
    const lines = menu.context!.split('\n')
    expect(lines[0]).toBe('Edit file')
    expect(lines[1]).toBe('src/app.js')
    expect(lines).toContain('4 -export const value3 = 3 // linha 3')
    expect(lines).toContain('13 +export const value12 = 12 // editado')
    expect(menu.contextClipped).toBeUndefined()
  })

  it('o pedido é Edit + caminho, não o diff', () => {
    expect(parseTuiMenu(screen)!.request).toEqual({ tool: 'Edit', command: 'src/app.js' })
  })

  it('janela curta corta o diff: marca clipped e o parse completo amplia', () => {
    expect(parseTuiMenu(tailOf(screen)(25))!.contextClipped).toBe(true)
    const full = parseTuiMenuFull(tailOf(screen), screen.split('\n').length)!
    expect(full.contextClipped).toBeUndefined()
    expect(full.context!.startsWith('Edit file\nsrc/app.js')).toBe(true)
  })

  it('lê cursor e "Tab to amend" do rodapé', () => {
    const menu = parseTuiMenu(screen)!
    expect(menu.cursorIndex).toBe(0)
    expect(menu.amendable).toBe(true)
  })
})

describe('permissão 2.1.316 — Create e MCP', () => {
  it('Create file: ferramenta + caminho', () => {
    const menu = parseTuiMenu(fixture('permission-write-create'))!
    expect(menu.request).toEqual({ tool: 'Create', command: 'notas.txt' })
  })

  it('MCP: a ferramenta vem da linha "<servidor> — <Ferramenta> Tool: (MCP)"', () => {
    const menu = parseTuiMenu(fixture('permission-mcp'))!
    expect(menu.request).toEqual({ tool: 'echo — Shout', command: 'text: "oi"' })
  })

  // Visto ao vivo (sandbox-084, handoff_report de filha): argumento longo empurra
  // "Tool use" e a linha "(MCP)" para fora da tela lida; o card virava "Claude pede
  // permissão" genérico. A linha "About the … Tool:" fica colada na pergunta.
  it('MCP com argumento longo: sem o cabeçalho na tela, a ferramenta vem do "About the … Tool:"', () => {
    const lines = fixture('permission-mcp').split('\n')
    const clipped = lines.slice(lines.findIndex((l) => l.includes('text: "oi"'))).join('\n')
    const menu = parseTuiMenu(clipped)!
    expect(menu.kind).toBe('permission')
    expect(menu.request?.tool).toBe('echo — Shout')
  })
})

describe('permissão 2.1.316 — Bash e Tab-to-amend', () => {
  const curl = parseTuiMenu(fixture('permission-bash-curl'))!

  it('"don’t ask again" com apóstrofo tipográfico conta como Sempre', () => {
    expect(curl.options[1].label).toBe('Yes, and don’t ask again for: curl *')
    expect(classifyChoice(curl, { kind: 'select', optionIndex: 1 })).toBe('always')
  })

  it('"switch to accept edits" conta como Sempre', () => {
    const edit = parseTuiMenu(fixture('permission-edit-long-diff'))!
    expect(classifyChoice(edit, { kind: 'select', optionIndex: 1 })).toBe('always')
  })

  it('amend no "No" vira negar', () => {
    expect(classifyChoice(curl, { kind: 'amend', optionIndex: 3, text: 'x' })).toBe('deny')
  })

  it('negar explicando: setas do cursor até o No, Tab, texto, Enter (sequência validada ao vivo)', () => {
    expect(buildAmendKeys(curl, 3, 'use wget em vez de curl')).toEqual([
      '\x1b[B',
      '\x1b[B',
      '\x1b[B',
      '\t',
      'use wget em vez de curl',
      '\r',
    ])
  })

  it('texto com quebra de linha não vira Enter antecipado', () => {
    expect(buildAmendKeys(curl, 3, 'a\nb\r')).toEqual([
      '\x1b[B',
      '\x1b[B',
      '\x1b[B',
      '\t',
      'a b',
      '\r',
    ])
  })

  it('sem texto, sem cursor conhecido ou sem amend no rodapé: nada é digitado', () => {
    expect(buildAmendKeys(curl, 3, '   ')).toEqual([])
    expect(buildAmendKeys({ ...curl, cursorIndex: undefined }, 3, 'x')).toEqual([])
    expect(buildAmendKeys({ ...curl, amendable: undefined }, 3, 'x')).toEqual([])
  })

  it('campo de amend aberto: o label do No muda e o cursor fica nele', () => {
    const open = parseTuiMenu(fixture('permission-bash-amend-open'))!
    expect(open.cursorIndex).toBe(3)
    expect(open.options[3].label).toBe('No, and tell Claude what to do differently')
    const typed = parseTuiMenu(fixture('permission-bash-amend-typed'))!
    expect(typed.options[3].label).toBe('No, use wget em vez de curl')
  })
})
