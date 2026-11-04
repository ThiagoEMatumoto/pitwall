import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { SystemCard } from './SystemCard'

describe('SystemCard', () => {
  it('nasce colapsado: o detalhe só aparece sob demanda', () => {
    render(<SystemCard label="Sistema" detail="detalhe interno" level="info" />)
    expect(screen.queryByText('detalhe interno')).toBeNull()
  })

  it('com defaultOpen (recap) o detalhe já aparece, como no terminal', () => {
    render(<SystemCard label="Recap" detail="Próximo passo: revisar o rascunho." level="info" defaultOpen />)
    expect(screen.getByText('Próximo passo: revisar o rascunho.')).toBeTruthy()
  })
})
