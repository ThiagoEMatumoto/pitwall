import { render, screen } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { ChatEmptyState } from './ChatEmptyState'

describe('ChatEmptyState', () => {
  it('mostra a mesma tela de boas-vindas em waiting e empty', () => {
    const { unmount } = render(<ChatEmptyState viewState="waiting" />)
    expect(screen.getByText('Pronto quando você estiver.')).toBeInTheDocument()
    expect(screen.getByText('Digite seu prompt abaixo para começar.')).toBeInTheDocument()
    unmount()

    render(<ChatEmptyState viewState="empty" />)
    expect(screen.getByText('Pronto quando você estiver.')).toBeInTheDocument()
    expect(screen.getByText('Digite seu prompt abaixo para começar.')).toBeInTheDocument()
  })

  it('mantém o estado transitório de loading distinto do hero', () => {
    render(<ChatEmptyState viewState="loading" />)
    expect(screen.getByRole('status', { name: 'Carregando conversa…' })).toBe(
      screen.getByTestId('chat-loading'),
    )
    expect(screen.getByText('Carregando conversa…')).toBeInTheDocument()
    expect(screen.queryByText('Pronto quando você estiver.')).not.toBeInTheDocument()
  })

  it('renderiza os children (cards TUI) por cima do estado vazio', () => {
    render(
      <ChatEmptyState viewState="waiting">
        <div>card de trust</div>
      </ChatEmptyState>,
    )
    expect(screen.getByText('card de trust')).toBeInTheDocument()
    expect(screen.getByText('Pronto quando você estiver.')).toBeInTheDocument()
  })
})
