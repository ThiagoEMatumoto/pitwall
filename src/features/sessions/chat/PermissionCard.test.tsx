import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { parseTuiMenu } from '../../../../shared/tui/tui-menu-parser'
import { PermissionCard } from './PermissionCard'

describe('PermissionCard', () => {
  it('todo atalho anunciado é uma tecla que a Room aceita (/^[1-9]$/)', () => {
    const lines = Array.from(
      { length: 9 },
      (_, i) => `${i === 0 ? '❯' : ' '} ${i + 1}. Opção ${i + 1}`,
    )
    const menu = parseTuiMenu(['Do you want to proceed?', ...lines, '', 'Esc to cancel'].join('\n'))
    expect(menu?.options).toHaveLength(9)
    const { container } = render(
      <PermissionCard kind="permission" options={menu!.options} onRespond={() => {}} />,
    )
    const keys = [...container.querySelectorAll('[data-permission-option]')].map((b) =>
      b.getAttribute('data-permission-option'),
    )
    expect(keys).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9'])
    for (const k of keys) expect(k).toMatch(/^[1-9]$/)
  })
})
