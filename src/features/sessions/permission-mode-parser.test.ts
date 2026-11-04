import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseTuiMenu } from '../../../shared/tui/tui-menu-parser'
import {
  detectFooterMode,
  footerModeUpdate,
  parsePermissionMode,
  shouldNotifyModeChange,
} from './permission-mode-parser'

describe('parsePermissionMode', () => {
  it('reads acceptEdits from "accept edits on"', () => {
    expect(parsePermissionMode('accept edits on')).toBe('acceptEdits')
  })

  it('reads plan from "plan mode on"', () => {
    expect(parsePermissionMode('plan mode on')).toBe('plan')
  })

  it('reads auto from "auto mode on"', () => {
    expect(parsePermissionMode('auto mode on')).toBe('auto')
  })

  it('does not read "auto-accept edits on" as acceptEdits', () => {
    expect(parsePermissionMode('auto-accept edits on')).toBe('auto')
  })

  it('reads bypassPermissions from "bypass permissions"', () => {
    expect(parsePermissionMode('bypass permissions')).toBe('bypassPermissions')
  })

  it('returns null when no indicator is present', () => {
    expect(parsePermissionMode('just some terminal output without any footer')).toBeNull()
  })

  it('returns null for empty text', () => {
    expect(parsePermissionMode('')).toBeNull()
  })

  it('lets the last (rightmost) occurrence win', () => {
    expect(parsePermissionMode('plan mode on ... accept edits on')).toBe('acceptEdits')
    expect(parsePermissionMode('accept edits on ... plan mode on')).toBe('plan')
  })
})

describe('shouldNotifyModeChange', () => {
  it('does not notify on mount (prev and next both null)', () => {
    expect(shouldNotifyModeChange(null, null)).toBe(false)
  })

  it('does not notify on the first real detection (baseline, prev still null)', () => {
    expect(shouldNotifyModeChange(null, 'default')).toBe(false)
    expect(shouldNotifyModeChange(null, 'plan')).toBe(false)
  })

  it('does not notify when the mode stays the same', () => {
    expect(shouldNotifyModeChange('default', 'default')).toBe(false)
    expect(shouldNotifyModeChange('plan', 'plan')).toBe(false)
  })

  it('notifies on a real transition between two known modes', () => {
    expect(shouldNotifyModeChange('default', 'plan')).toBe(true)
    expect(shouldNotifyModeChange('plan', 'acceptEdits')).toBe(true)
  })

  it('does not notify if next somehow reverts to null', () => {
    expect(shouldNotifyModeChange('plan', null)).toBe(false)
  })
})

// Telas reais (sondas 2.1.316/2.1.317). O rodapé é o das últimas 10 linhas com conteúdo:
// a captura vem com linhas em branco abaixo do que a TUI desenhou.
describe('footerModeUpdate — rodapé com menu TUI aberto', () => {
  const screen = (name: string) =>
    readFileSync(join(__dirname, '../../../shared/tui/__fixtures__', `claude-${name}.txt`), 'utf8')
  const footerOf = (text: string) => text.trimEnd().split('\n').slice(-10).join('\n')
  const read = (name: string) => {
    const text = screen(name)
    return footerModeUpdate(footerOf(text), parseTuiMenu(text) != null)
  }

  it('diálogo de plano aberto: o rodapé some, mas isso não é "modo Padrão"', () => {
    expect(detectFooterMode(footerOf(screen('2.1.317-plan-default')))).toBe('default')
    expect(read('2.1.317-plan-default')).toBeNull()
  })

  it('prompt de permissão do Write aberto: mantém o modo atual', () => {
    expect(read('2.1.316-permission-write-create')).toBeNull()
  })

  it('sem menu, o rodapé decide: "manual mode on" é o Padrão, "auto mode on" é auto', () => {
    expect(read('2.1.317-plan-no-auto-after-manual')).toBe('default')
    expect(read('2.1.317-plan-auto-after-approve')).toBe('auto')
  })
})
