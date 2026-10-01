import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/ipc', () => ({
  notificationsApi: { onEvent: () => () => {}, onOpenSession: () => () => {} },
}))

const { NotificationToast } = await import('./NotificationToast')
const { useToastStore } = await import('./toast-store')

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
