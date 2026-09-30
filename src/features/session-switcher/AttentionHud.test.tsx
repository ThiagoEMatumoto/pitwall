import { act, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.stubGlobal('window', Object.assign(window, {
  api: new Proxy({}, { get: () => new Proxy({}, { get: () => () => undefined }) }),
}))

const { AttentionHud } = await import('./AttentionHud')
const { useAttentionStore } = await import('./useAttentionQueue')
type AttentionItem = import('./attention-queue').AttentionItem

const item: AttentionItem = {
  key: 'crew:h',
  kind: 'crew',
  sessionId: 'child',
  ccSessionId: 'cc-child',
  handoffId: 'h',
  projectName: 'proj',
  title: 'Auth',
  reason: 'handoff-input',
  since: 1,
  liveStatus: 'waiting',
}

afterEach(() => {
  vi.useRealTimers()
  useAttentionStore.setState({ flash: null, cursor: null, activeCc: null })
})

describe('AttentionHud', () => {
  it('live region nasce vazia, escondida da árvore de acessibilidade', () => {
    render(<AttentionHud />)
    const hud = screen.getByTestId('attention-hud')
    expect(hud).toHaveAttribute('role', 'status')
    expect(hud).toBeEmptyDOMElement()
    expect(hud).toHaveAttribute('aria-hidden', 'true')
  })

  it('preenche e expõe no pulo, e volta a aria-hidden quando some', () => {
    vi.useFakeTimers()
    render(<AttentionHud />)
    act(() => useAttentionStore.setState({ flash: { nonce: 1, position: 3, total: 3, item } }))
    const hud = screen.getByTestId('attention-hud')
    expect(hud).not.toHaveAttribute('aria-hidden')
    expect(hud).toHaveTextContent('3/3 · proj · Auth · pergunta pendente')
    act(() => vi.advanceTimersByTime(1300))
    expect(hud).toHaveAttribute('aria-hidden', 'true')
    expect(hud).toHaveAttribute('data-visible', 'false')
  })
})
