import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/ipc', () => ({ chatApi: { noteFallback: vi.fn(() => Promise.resolve()) } }))

import { parseTuiMenu } from '../tui-menu-parser'
import { PlanCard } from './PlanCard'
import { planChoices } from './plan-choices'

// Variante do binário sem captura real (o bypass só aparece com ele habilitado).
const bypassMenu = parseTuiMenu(` Claude has written up a plan and is ready to execute. Would you like to proceed?
 ❯ 1. Yes, and switch to BYPASS PERMISSIONS (no further prompts) for this session
   2. Yes, manually approve edits
   3. Tell Claude what to change
      shift+tab to approve with this feedback
`)!

describe('PlanCard — bypass', () => {
  it('pede um 2º clique antes de aprovar com bypass', () => {
    const onDecide = vi.fn()
    render(<PlanCard plan="# p" onDecide={onDecide} choices={planChoices(bypassMenu)} />)
    const btn = screen.getByTestId('plan-choice-approve-bypass')
    fireEvent.click(btn)
    expect(onDecide).not.toHaveBeenCalled()
    expect(btn).toHaveTextContent('Confirmar bypass: sem mais prompts nesta sessão')
    fireEvent.click(btn)
    expect(onDecide).toHaveBeenCalledWith('approve-bypass')
  })

  it('as outras aprovações seguem com um clique', () => {
    const onDecide = vi.fn()
    render(<PlanCard plan="# p" onDecide={onDecide} choices={planChoices(bypassMenu)} />)
    fireEvent.click(screen.getByTestId('plan-choice-approve-manual'))
    expect(onDecide).toHaveBeenCalledWith('approve-manual')
  })
})
