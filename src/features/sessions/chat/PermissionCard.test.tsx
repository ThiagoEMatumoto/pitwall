import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { parseTuiMenu } from '../../../../shared/tui/tui-menu-parser'
import { PermissionCard } from './PermissionCard'

// Telas reais do claude 2.1.316 (sonda e2e/scenarios/probe-chat-permission-2316.ts).
function menuOf(name: string) {
  const text = readFileSync(
    join(__dirname, '../../../../shared/tui/__fixtures__', `claude-2.1.316-${name}.txt`),
    'utf8',
  )
  return parseTuiMenu(text)!
}

describe('PermissionCard', () => {
  it('Bash: título humano, comando limpo e botões semânticos com o escopo do Sempre', () => {
    render(<PermissionCard menu={menuOf('permission-bash-curl')} onDecide={() => {}} />)
    expect(screen.getByRole('heading').textContent).toBe('Claude quer rodar um comando')
    expect(screen.getByTestId('permission-command').textContent).toBe(
      '$ curl -sI https://example.com',
    )
    expect(screen.getByTestId('permission-approve').textContent).toContain('Aprovar')
    expect(screen.getByTestId('permission-deny').textContent).toContain('Negar')
    expect(screen.getByTestId('permission-always-scope').textContent).toBe(
      'Sempre permitir: não perguntar de novo para curl *.',
    )
    expect(screen.getByText(/Ou: ligar o modo automático/)).toBeTruthy()
  })

  it('Edit: diff inteiro com + e − marcados, começando colapsado quando longo', () => {
    render(<PermissionCard menu={menuOf('permission-edit-long-diff')} onDecide={() => {}} />)
    expect(screen.getByRole('heading').textContent).toBe('Claude quer editar app.js')
    const diff = screen.getByTestId('permission-diff')
    expect(diff.querySelectorAll('[data-sign="-"]').length).toBeGreaterThan(0)
    fireEvent.click(screen.getByText(/Mostrar as \d+ linhas/))
    expect(diff.querySelectorAll('[data-sign="-"]')).toHaveLength(10)
    expect(diff.querySelectorAll('[data-sign="+"]')).toHaveLength(10)
  })

  it('Enter aprova, Esc nega, Ctrl+Enter é o Sempre', () => {
    const onDecide = vi.fn()
    render(<PermissionCard menu={menuOf('permission-bash-curl')} onDecide={onDecide} />)
    const card = screen.getByTestId('permission-card')
    expect(document.activeElement).toBe(card)
    fireEvent.keyDown(card, { key: 'Enter' })
    fireEvent.keyDown(card, { key: 'Escape' })
    fireEvent.keyDown(card, { key: 'Enter', ctrlKey: true })
    expect(onDecide.mock.calls.map((c) => c[0].optionIndex)).toEqual([0, 3, 1])
  })

  it('Negar e explicar manda amend no No com o texto; Esc no campo só fecha', () => {
    const onDecide = vi.fn()
    render(<PermissionCard menu={menuOf('permission-bash-curl')} onDecide={onDecide} />)
    fireEvent.click(screen.getByTestId('permission-explain'))
    const input = screen.getByTestId('permission-reason')
    fireEvent.change(input, { target: { value: 'use wget' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onDecide).toHaveBeenCalledWith({
      type: 'amend',
      optionIndex: 3,
      text: 'use wget',
      label: 'Negado: use wget',
    })
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(screen.queryByTestId('permission-reason')).toBeNull()
    expect(onDecide).toHaveBeenCalledTimes(1)
  })

  it('filha com regra derivável oferece Sempre permitir para filhas', () => {
    const onDecide = vi.fn()
    render(
      <PermissionCard
        menu={menuOf('permission-bash-curl')}
        onDecide={onDecide}
        childRule="Bash(curl:*)"
      />,
    )
    fireEvent.click(screen.getByTestId('permission-always-children'))
    expect(onDecide.mock.calls[0][0]).toMatchObject({ type: 'children', optionIndex: 0 })
  })

  it('enviado: vira uma linha de estado e não aceita outra decisão', () => {
    const onDecide = vi.fn()
    render(
      <PermissionCard menu={menuOf('permission-bash-curl')} onDecide={onDecide} sentLabel="Yes" />,
    )
    expect(screen.getByTestId('permission-sent').textContent).toContain('Enviado')
    expect(screen.queryByTestId('permission-approve')).toBeNull()
  })

  it('todo atalho anunciado é uma tecla que a Room aceita (/^[1-9]$/)', () => {
    const { container } = render(
      <PermissionCard menu={menuOf('permission-bash-curl')} onDecide={() => {}} />,
    )
    const keys = [...container.querySelectorAll('[data-permission-option]')].map((b) =>
      b.getAttribute('data-permission-option'),
    )
    expect(keys.sort()).toEqual(['1', '2', '3', '4'])
  })
})
