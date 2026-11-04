import { act, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { noteFallback } = vi.hoisted(() => ({ noteFallback: vi.fn(() => Promise.resolve()) }))
vi.mock('@/lib/ipc', () => ({ chatApi: { noteFallback } }))

import { ChatWaitBanners } from './ChatWaitBanners'
import { PlanCard } from './PlanCard'
import { FALLBACK_STABLE_MS } from './useChatFallback'

beforeEach(() => {
  vi.useFakeTimers()
  noteFallback.mockClear()
})
afterEach(() => vi.useRealTimers())

describe('contador de fallback pro terminal', () => {
  it('o link residual ao terminal que fica na tela conta uma vez, por kind/motivo', () => {
    render(
      <ChatWaitBanners
        pendingPrompt={null}
        waitInTerminal
        menuKind="question"
        onToggleMode={() => {}}
      />,
    )
    act(() => vi.advanceTimersByTime(FALLBACK_STABLE_MS))
    expect(noteFallback).toHaveBeenCalledTimes(1)
    expect(noteFallback).toHaveBeenCalledWith('question', 'wait-in-terminal')
  })

  it('banner que some antes do tempo (resposta acabou de sair) não conta', () => {
    const { rerender } = render(
      <ChatWaitBanners pendingPrompt={{ kind: 'plan', id: 'p' }} waitInTerminal={false} />,
    )
    act(() => vi.advanceTimersByTime(FALLBACK_STABLE_MS - 100))
    rerender(<ChatWaitBanners pendingPrompt={null} waitInTerminal={false} />)
    act(() => vi.advanceTimersByTime(FALLBACK_STABLE_MS))
    expect(noteFallback).not.toHaveBeenCalled()
  })

  it('plano pendente sem menu vivo conta como pending-without-menu', () => {
    render(<ChatWaitBanners pendingPrompt={{ kind: 'plan', id: 'p' }} waitInTerminal={false} />)
    act(() => vi.advanceTimersByTime(FALLBACK_STABLE_MS))
    expect(noteFallback).toHaveBeenCalledWith('plan', 'pending-without-menu')
  })

  it('diálogo de plano sem nenhuma opção reconhecida conta como plan:no-options', () => {
    render(<PlanCard plan="# p" onDecide={() => {}} choices={[]} />)
    act(() => vi.advanceTimersByTime(FALLBACK_STABLE_MS))
    expect(noteFallback).toHaveBeenCalledWith('plan', 'no-options')
  })

  it('card de plano com opções não conta nada', () => {
    render(
      <PlanCard
        plan="# p"
        onDecide={() => {}}
        canFeedback
        choices={[
          {
            intent: 'approve-manual',
            label: 'Aprovar com edições manuais',
            optionLabel: 'Yes, manually approve edits',
            highlighted: false,
            tone: 'primary',
          },
        ]}
      />,
    )
    act(() => vi.advanceTimersByTime(FALLBACK_STABLE_MS * 2))
    expect(noteFallback).not.toHaveBeenCalled()
  })
})
