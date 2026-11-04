import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'

// O MarkdownViewer importa o preload; aqui ele é inerte.
vi.mock('@/lib/ipc', () => {
  const inert = new Proxy({}, { get: () => () => Promise.resolve(null) })
  return new Proxy({}, { get: () => inert })
})
import { ThinkingCard } from './ThinkingCard'

describe('ThinkingCard', () => {
  it('raciocínio curto (resumido, como o TUI mostra) nasce aberto', () => {
    const text = 'A proposta foi aprovada; falta ajustar o aviso no fluxo.'
    render(<ThinkingCard text={text} />)
    expect(screen.getByRole('button', { name: /Raciocínio/ })).toHaveAttribute(
      'aria-expanded',
      'true',
    )
    expect(screen.getByText(text)).toBeInTheDocument()
  })

  it('raciocínio longo nasce colapsado, só com o preview', () => {
    const text = `Primeira frase do raciocínio. ${'detalhe '.repeat(100)}`
    render(<ThinkingCard text={text} />)
    expect(screen.getByRole('button', { name: /Raciocínio/ })).toHaveAttribute(
      'aria-expanded',
      'false',
    )
    expect(screen.getByText(/Primeira frase do raciocínio/)).toBeInTheDocument()
  })
})
