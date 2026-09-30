import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Handoff } from '../../../shared/types/ipc'

let resolvePref: (v: boolean | null) => void = () => {}
vi.mock('@/lib/ipc', () => ({
  prefsApi: { get: vi.fn(() => new Promise((r) => (resolvePref = r))) },
  handoffsApi: {},
}))

const { useHandoffs } = await import('./useHandoffs')
const { useHandoffsStore } = await import('@/store/handoffsStore')

const pending = { id: 'h1', status: 'pending', composedPrompt: 'p', dismissedAt: null } as Handoff

function seed(approve: ReturnType<typeof vi.fn>) {
  useHandoffsStore.setState({
    handoffs: [pending],
    load: async () => {},
    startUpdatedWatch: () => {},
    stopUpdatedWatch: () => {},
    approve,
  } as never)
}

afterEach(() => vi.clearAllMocks())

describe('useHandoffs — gate de aprovação no boot', () => {
  it('handoffs chegam antes da pref: com o gate LIGADO, nada é aprovado', async () => {
    const approve = vi.fn(async () => {})
    seed(approve)
    renderHook(() => useHandoffs())
    await new Promise((r) => setTimeout(r, 20))
    expect(approve).not.toHaveBeenCalled()
    resolvePref(true)
    await new Promise((r) => setTimeout(r, 20))
    expect(approve).not.toHaveBeenCalled()
  })

  it('gate desligado (default): destrava o pending depois que a pref chega', async () => {
    const approve = vi.fn(async () => {})
    seed(approve)
    renderHook(() => useHandoffs())
    expect(approve).not.toHaveBeenCalled()
    resolvePref(null)
    await waitFor(() => expect(approve).toHaveBeenCalledWith('h1', 'p'))
  })
})
