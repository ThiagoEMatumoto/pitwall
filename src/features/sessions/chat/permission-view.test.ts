import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { parseTuiMenu } from '../../../../shared/tui/tui-menu-parser'
import type { AttentionMenuSnapshot } from '../../../../shared/types/ipc'
import { pendingElsewhereLabel, permissionView } from './permission-view'
import { respondGuarded, sameDecision } from './permission-respond'

function menuOf(name: string) {
  const text = readFileSync(
    join(__dirname, '../../../../shared/tui/__fixtures__', `claude-2.1.316-${name}.txt`),
    'utf8',
  )
  return parseTuiMenu(text)!
}

describe('permissionView (capturas 2.1.316)', () => {
  it('Bash: descrição do Claude separada do comando; Sempre com os dois escopos', () => {
    const v = permissionView(menuOf('permission-bash-curl'))
    expect(v.kind).toBe('command')
    expect(v.description).toBe('Fetch HTTP headers from example.com')
    expect(v.command).toBe('curl -sI https://example.com')
    expect(v.notes.map((n) => n.trim())).toEqual(['This command requires approval'])
    expect(v.approve?.optionIndex).toBe(0)
    expect(v.deny?.optionIndex).toBe(3)
    expect(v.always.map((a) => a.optionIndex)).toEqual([1])
    expect(v.autoMode?.optionIndex).toBe(2)
    expect(v.canExplainDeny).toBe(true)
  })

  it('auto mode nunca entra na lista do Sempre', () => {
    const v = permissionView(menuOf('named-permission-bash'))
    expect(v.always).toEqual([])
    expect(v.autoMode?.optionIndex).toBe(1)
    expect(v.approve?.optionIndex).toBe(0)
  })

  it('Create: arquivo novo vira diff só de adições', () => {
    const v = permissionView(menuOf('permission-write-create'))
    expect(v.title).toBe('Claude quer criar notas.txt')
    expect(v.diff).toEqual([
      { num: '1', sign: '+', text: 'alfa' },
      { num: '2', sign: '+', text: 'beta' },
      { num: '3', sign: '+', text: 'gama' },
    ])
    expect(v.always[0].scope).toBe('aceitar edições de arquivo sem perguntar nesta sessão')
  })

  it('Edit: caminho completo e contexto do diff preservado', () => {
    const v = permissionView(menuOf('permission-edit-long-diff'))
    expect(v.target).toBe('src/app.js')
    expect(v.diff![0]).toEqual({ num: '1', sign: ' ', text: 'export const value0 = 0 // linha 0' })
    expect(v.notes).toEqual([])
  })

  it('MCP: título com a ferramenta e o escopo "nesta pasta"', () => {
    const v = permissionView(menuOf('permission-mcp'))
    expect(v.title).toBe('Claude quer usar echo — Shout')
    expect(v.always[0].scope).toBe('não perguntar de novo para echo — Shout nesta pasta')
  })
})

describe('respondGuarded', () => {
  const shown = menuOf('permission-bash-curl')
  const snap = (menu = shown): AttentionMenuSnapshot => ({
    sessionId: 's1',
    fingerprint: 'fp',
    menuSeq: 3,
    menu,
  })

  it('responde pelo main com o fingerprint e o menuSeq do snapshot fresco', async () => {
    const api = {
      attentionMenu: vi.fn().mockResolvedValue(snap()),
      attentionRespond: vi.fn().mockResolvedValue({ ok: true }),
    }
    const action = { kind: 'amend' as const, optionIndex: 3, text: 'use wget' }
    expect(await respondGuarded(api, 's1', shown, action)).toEqual({ ok: true })
    expect(api.attentionRespond).toHaveBeenCalledWith({
      sessionId: 's1',
      fingerprint: 'fp',
      menuSeq: 3,
      action,
    })
  })

  it('outro comando na tela: não responde', async () => {
    const other = { ...shown, request: { tool: 'Bash', command: 'wget x' } }
    const api = {
      attentionMenu: vi.fn().mockResolvedValue(snap(other)),
      attentionRespond: vi.fn(),
    }
    expect(await respondGuarded(api, 's1', shown, { kind: 'select', optionIndex: 0 })).toEqual({
      ok: false,
      error: 'decision-changed',
    })
    expect(api.attentionRespond).not.toHaveBeenCalled()
  })

  it('main sem menu: no-watch para quem chamou decidir o fallback', async () => {
    const api = { attentionMenu: vi.fn().mockResolvedValue(null), attentionRespond: vi.fn() }
    expect(await respondGuarded(api, 's1', shown, { kind: 'select', optionIndex: 0 })).toEqual({
      ok: false,
      error: 'no-watch',
    })
  })

  it('o campo de amend aberto muda o label do No: conta como decisão diferente', () => {
    expect(sameDecision(shown, menuOf('permission-bash-amend-open'), 3)).toBe(false)
    expect(sameDecision(shown, menuOf('permission-bash-amend-open'), 0)).toBe(true)
  })
})

it('chip: singular e plural', () => {
  expect(pendingElsewhereLabel(1)).toBe('1 sessão aguardando você')
  expect(pendingElsewhereLabel(2)).toBe('2 sessões aguardando você')
})
