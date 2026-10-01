import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { PurposeLine } from './PurposeLine'
import { MapActionsContext, type MapActions } from './map-context'

function renderLine(source: 'user' | 'transcript' | 'handoff', purpose: string) {
  const actions = {
    editingPurposeId: 's1',
    savePurpose: vi.fn(),
    cancelEdit: vi.fn(),
    startEditPurpose: vi.fn(),
  } as unknown as MapActions
  render(
    <MapActionsContext.Provider value={actions}>
      <PurposeLine sessionId="s1" purpose={purpose} source={source} />
    </MapActionsContext.Provider>,
  )
  return { actions, input: screen.getByLabelText('Propósito da sessão') as HTMLInputElement }
}

describe('PurposeLine', () => {
  it('propósito derivado do transcript não pré-preenche e sair sem digitar não grava', () => {
    const { actions, input } = renderLine('transcript', 'corrige o bug do login quando…')
    expect(input.value).toBe('')
    expect(input.placeholder).toBe('corrige o bug do login quando…')
    fireEvent.blur(input)
    expect(actions.savePurpose).not.toHaveBeenCalled()
    expect(actions.cancelEdit).toHaveBeenCalled()
  })

  it('propósito do usuário pré-preenche; sair sem mudar não regrava', () => {
    const { actions, input } = renderLine('user', 'Tokens rotativos')
    expect(input.value).toBe('Tokens rotativos')
    fireEvent.blur(input)
    expect(actions.savePurpose).not.toHaveBeenCalled()
  })

  it('digitar um propósito novo grava como do usuário', () => {
    const { actions, input } = renderLine('handoff', 'tarefa do handoff')
    fireEvent.change(input, { target: { value: 'Frente de pagamentos' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(actions.savePurpose).toHaveBeenCalledWith('s1', 'Frente de pagamentos')
  })

  it('sem propósito e fora da edição: não ocupa linha (o convite é o ✎ do cabeçalho)', () => {
    const actions = { editingPurposeId: null } as unknown as MapActions
    const { container } = render(
      <MapActionsContext.Provider value={actions}>
        <PurposeLine sessionId="s1" purpose={null} source={null} />
      </MapActionsContext.Provider>,
    )
    expect(container.textContent).toBe('')
  })
})
