import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { JumpToLatest, WorkingIndicator, formatElapsed } from './ChatLiveIndicators'

describe('formatElapsed', () => {
  it('segundos até 1 minuto, depois minutos com segundos em 2 dígitos', () => {
    expect(formatElapsed(0)).toBe('0s')
    expect(formatElapsed(12_400)).toBe('12s')
    expect(formatElapsed(65_000)).toBe('1min 05s')
    expect(formatElapsed(-5)).toBe('0s')
  })
})

describe('WorkingIndicator', () => {
  it('diz se está pensando ou agindo, com o tempo decorrido', () => {
    const { rerender } = render(<WorkingIndicator since={Date.now() - 3_000} thinking />)
    expect(screen.getByRole('status')).toHaveTextContent('Pensando…')
    expect(screen.getByText('3s')).toBeInTheDocument()
    rerender(<WorkingIndicator since={Date.now()} thinking={false} />)
    expect(screen.getByRole('status')).toHaveTextContent('Trabalhando…')
  })
})

describe('JumpToLatest', () => {
  it('troca o rótulo quando há conteúdo novo e chama o handler', () => {
    const onClick = vi.fn()
    const { rerender } = render(<JumpToLatest unseen={false} onClick={onClick} />)
    expect(screen.getByRole('button', { name: /Ir para o fim/ })).toBeInTheDocument()
    rerender(<JumpToLatest unseen onClick={onClick} />)
    fireEvent.click(screen.getByRole('button', { name: /Novas mensagens/ }))
    expect(onClick).toHaveBeenCalledOnce()
  })
})
