import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { MeetingActionItem } from '../../../shared/types/ipc'

vi.mock('@/lib/ipc', () => ({
  meetingsApi: { onEvent: vi.fn(() => () => {}) },
}))
vi.mock('@/lib/nav', () => ({ navigateToTask: vi.fn() }))

const { ActionItemsList } = await import('./ActionItemsList')

function item(over: Partial<MeetingActionItem> & { id: string; title: string }): MeetingActionItem {
  return {
    meetingId: 'm1',
    quote: null,
    grounded: true,
    status: 'proposed',
    taskId: null,
    createdAt: 0,
    owner: null,
    ownerKind: 'unknown',
    ...over,
  }
}

const items = [
  item({ id: 'a', title: 'Enviar o PDF', quote: 'manda o PDF hoje' }),
  item({ id: 'b', title: 'Revisar a pauta', owner: 'Eu', ownerKind: 'me' }),
  item({ id: 'c', title: 'Ligar pro cliente' }),
  item({ id: 'd', title: 'Já criada', status: 'created', taskId: 't1' }),
]

describe('ActionItemsList', () => {
  it('seleciona 2 e cria → batch com os ids selecionados, sem overrides', () => {
    const onBatch = vi.fn()
    render(<ActionItemsList items={items} participants={['Eu', 'Bianca']} onBatch={onBatch} />)

    expect(screen.getByText('Ver na área Tarefas')).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('Selecionar Enviar o PDF'))
    fireEvent.click(screen.getByLabelText('Selecionar Ligar pro cliente'))
    expect(screen.getByText('2 selecionadas')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Criar tarefas' }))

    expect(onBatch).toHaveBeenCalledWith({ ids: ['a', 'c'], action: 'create' })
    expect(screen.getByText('0 selecionadas')).toBeInTheDocument()
  })

  it('edita o dono → override no batch; datalist traz os participantes', () => {
    const onBatch = vi.fn()
    render(<ActionItemsList items={items} participants={['Eu', 'Bianca']} onBatch={onBatch} />)

    const owner = screen.getByLabelText('Dono de Enviar o PDF') as HTMLInputElement
    expect(owner.placeholder).toBe('sem dono')
    const list = document.getElementById(owner.getAttribute('list')!)!
    expect(Array.from(list.querySelectorAll('option')).map((o) => o.getAttribute('value'))).toEqual(['Eu', 'Bianca'])

    fireEvent.change(owner, { target: { value: 'Bianca' } })
    fireEvent.click(screen.getByLabelText('Selecionar todas'))
    fireEvent.click(screen.getByRole('button', { name: 'Criar tarefas' }))

    expect(onBatch).toHaveBeenCalledWith({ ids: ['a', 'b', 'c'], action: 'create', overrides: { a: { owner: 'Bianca' } } })
  })

  it('descartar envia dismiss sem overrides', () => {
    const onBatch = vi.fn()
    render(<ActionItemsList items={items} participants={['Eu']} onBatch={onBatch} />)
    fireEvent.click(screen.getByLabelText('Selecionar Revisar a pauta'))
    fireEvent.click(screen.getByRole('button', { name: 'Descartar' }))
    expect(onBatch).toHaveBeenCalledWith({ ids: ['b'], action: 'dismiss' })
  })
})
