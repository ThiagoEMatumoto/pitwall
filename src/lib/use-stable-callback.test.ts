import { renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { useStableCallback } from './use-stable-callback'

describe('useStableCallback', () => {
  it('keeps the same function across renders and always calls the latest one', () => {
    const { result, rerender } = renderHook(
      ({ step }: { step: number }) => useStableCallback((n: number) => n + step),
      { initialProps: { step: 1 } },
    )
    const first = result.current
    expect(first(10)).toBe(11)

    rerender({ step: 5 })
    expect(result.current).toBe(first)
    expect(first(10)).toBe(15)
  })
})
