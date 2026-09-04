import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useToastStore } from '@/features/notifications/toast-store'
import { reportHitFailure, resetHitFailures } from './hit-failure'

const toasts = () => useToastStore.getState().toasts

describe('reportHitFailure', () => {
  beforeEach(() => {
    useToastStore.setState({ toasts: [] })
    resetHitFailures()
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  })

  it('folds a burst of failures into one toast and one log', () => {
    reportHitFailure('a1', 'hover', new Error('timeout'), 1000)
    reportHitFailure('a1', 'hover', new Error('timeout'), 1200)
    reportHitFailure('a1', 'click', new Error('timeout'), 3000)
    expect(toasts()).toHaveLength(1)
    expect(console.warn).toHaveBeenCalledTimes(1)
  })

  it('reports again once the quiet window has passed', () => {
    reportHitFailure('a1', 'click', new Error('timeout'), 1000)
    reportHitFailure('a1', 'click', new Error('timeout'), 20_000)
    expect(toasts()).toHaveLength(2)
  })
})
