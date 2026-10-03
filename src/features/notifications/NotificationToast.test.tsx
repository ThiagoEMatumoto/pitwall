import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/ipc', () => ({
  notificationsApi: { onEvent: () => () => {}, onOpenSession: () => () => {} },
}))

const { NotificationToast } = await import('./NotificationToast')
const { useBarPillStore, useToastStore } = await import('./toast-store')

afterEach(() => act(() => useToastStore.setState({ toasts: [] })))

function showThree() {
  act(() => {
    for (const title of ['um', 'dois', 'três']) useToastStore.getState().show({ title })
  })
}

const visibleCards = () => screen.getAllByTestId('toast-card').filter((c) => !c.hidden)

describe('NotificationToast — teto do placement', () => {
  it('na faixa sobre a modal (teto 0) o "+N" não expande os cards por cima dela', () => {
    render(<NotificationToast maxVisible={0} />)
    showThree()
    fireEvent.click(screen.getByTestId('toast-overflow'))
    expect(visibleCards()).toHaveLength(0)
    expect(screen.getByTestId('toast-overflow')).toHaveTextContent('+3')
  })

  it('com teto > 0 o "+N" mostra todos', () => {
    render(<NotificationToast maxVisible={1} />)
    showThree()
    expect(visibleCards()).toHaveLength(1)
    fireEvent.click(screen.getByTestId('toast-overflow'))
    expect(visibleCards()).toHaveLength(3)
  })
})

describe('NotificationToast — "+N" no canto da barra do mapa estreito', () => {
  afterEach(() => {
    delete (HTMLButtonElement.prototype as { offsetWidth?: number }).offsetWidth
  })

  it('publica a largura do "+N" para a barra reservar o canto; some, zera', () => {
    Object.defineProperty(HTMLButtonElement.prototype, 'offsetWidth', {
      configurable: true,
      get: () => 84,
    })
    const { rerender } = render(<NotificationToast maxVisible={0} expandable />)
    expect(useBarPillStore.getState().width).toBe(0)
    showThree()
    expect(useBarPillStore.getState().width).toBe(84)
    // Fora do mapa estreito (teto > 0) o "+N" não mora na barra.
    rerender(<NotificationToast maxVisible={1} />)
    expect(useBarPillStore.getState().width).toBe(0)
  })

  // Expandido, o "+N" sumia e a barra liberava o canto: o 1º card (ancorado no
  // topo da barra) cobria os contadores e o "Trocar feature".
  it('expandido na barra, vira "Recolher" e mantém a reserva do canto', () => {
    Object.defineProperty(HTMLButtonElement.prototype, 'offsetWidth', {
      configurable: true,
      get: () => 84,
    })
    render(<NotificationToast maxVisible={0} expandable />)
    showThree()
    fireEvent.click(screen.getByTestId('toast-overflow'))
    expect(visibleCards()).toHaveLength(3)
    expect(screen.getByTestId('toast-overflow')).toHaveTextContent('Recolher')
    expect(useBarPillStore.getState().width).toBe(84)
    fireEvent.click(screen.getByTestId('toast-overflow'))
    expect(visibleCards()).toHaveLength(0)
    expect(screen.getByTestId('toast-overflow')).toHaveTextContent('+3')
  })
})

describe('NotificationToast — card fixo (atualização)', () => {
  // O card de update vivia fora da pilha: no mapa estreito ficava à vista abaixo
  // da barra, em cima dos cartões. Agora conta no teto e no "+N".
  it('conta no teto e no "+N" como qualquer aviso', () => {
    render(<NotificationToast maxVisible={0} expandable pinned={<div>update</div>} />)
    expect(screen.getByTestId('toast-overflow')).toHaveTextContent('+1 aviso')
    expect(visibleCards()).toHaveLength(0)
    showThree()
    expect(screen.getByTestId('toast-overflow')).toHaveTextContent('+4 avisos')
  })

  it('sem teto, aparece junto dos outros', () => {
    render(<NotificationToast pinned={<div>update</div>} />)
    expect(visibleCards()).toHaveLength(1)
    expect(screen.queryByTestId('toast-overflow')).toBeNull()
  })
})
