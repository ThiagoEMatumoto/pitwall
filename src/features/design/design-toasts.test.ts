import { beforeEach, describe, expect, it } from 'vitest'
import { useToastStore } from '@/features/notifications/toast-store'
import { resetAgentToasts, showAgentToast } from './design-toasts'

const noop = (): void => undefined
const toasts = () => useToastStore.getState().toasts

describe('showAgentToast', () => {
  beforeEach(() => {
    useToastStore.setState({ toasts: [] })
    resetAgentToasts()
  })

  it('keeps a single live toast across artboards and lists them', () => {
    showAgentToast('update', 'a1', 'Home', noop, 1000)
    showAgentToast('update', 'a2', 'Cardápio', noop, 1500)
    showAgentToast('update', 'a1', 'Home', noop, 2000)
    expect(toasts()).toHaveLength(1)
    expect(toasts()[0].title).toBe('Claude atualizou 2 artboards')
    expect(toasts()[0].body).toBe('Home · Cardápio')
  })

  it('starts a fresh title once the previous toast has expired', () => {
    showAgentToast('update', 'a1', 'Home', noop, 1000)
    showAgentToast('update', 'a2', 'Contato', noop, 20_000)
    expect(toasts()).toHaveLength(1)
    expect(toasts()[0].title).toBe('Claude atualizou "Contato"')
  })

  it('finish replaces the update toast instead of stacking on it', () => {
    showAgentToast('update', 'a1', 'Home', noop, 1000)
    showAgentToast('finish', 'a1', 'Home', noop, 1200)
    expect(toasts()).toHaveLength(1)
    expect(toasts()[0].title).toBe('Claude terminou "Home"')
  })
})
