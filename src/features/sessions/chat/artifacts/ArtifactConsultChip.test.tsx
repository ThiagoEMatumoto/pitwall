import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/ipc', () => ({ diagramsApi: {}, designApi: {} }))
vi.mock('@/lib/nav', () => ({ navigateToDesign: vi.fn(), navigateToDiagram: vi.fn() }))

import { ArtifactConsultChip } from './ArtifactConsultChip'
import { navigateToDiagram } from '@/lib/nav'

const plan = {
  ref: { kind: 'diagram' as const, id: 'd1' },
  title: 'Arquitetura',
  lastTool: 'diagram_get',
}

describe('ArtifactConsultChip', () => {
  it('mostra "consultou <título>" e abre o painel ao lado', () => {
    const onShowSide = vi.fn()
    render(<ArtifactConsultChip plan={plan} onShowSide={onShowSide} />)
    const chip = screen.getByTestId('artifact-consult-chip')
    expect(chip.textContent).toBe('consultouArquitetura')
    fireEvent.click(chip)
    expect(onShowSide).toHaveBeenCalledWith(plan.ref)
  })

  it('sem painel disponível abre no editor', () => {
    render(<ArtifactConsultChip plan={plan} />)
    fireEvent.click(screen.getByTestId('artifact-consult-chip'))
    expect(navigateToDiagram).toHaveBeenCalledWith('d1')
  })
})
