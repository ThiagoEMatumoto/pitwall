import { describe, expect, it, vi } from 'vitest'

const featuresApi: Record<string, unknown> = {}
vi.mock('@/lib/ipc', () => ({
  get featuresApi() {
    return featuresApi
  },
}))

const { setFeaturePinned } = await import('./feature-pin-api')

describe('feature-pin-api', () => {
  it('sem canal de foco no preload o toggle vira no-op declarado (false)', async () => {
    delete featuresApi.pin
    delete featuresApi.setFocus
    await expect(setFeaturePinned('f1', true)).resolves.toBe(false)
  })

  it('com pin/unpin presentes chama o par conforme o alvo', async () => {
    const pin = vi.fn().mockResolvedValue(undefined)
    const unpin = vi.fn().mockResolvedValue(undefined)
    featuresApi.pin = pin
    featuresApi.unpin = unpin

    await expect(setFeaturePinned('f1', true)).resolves.toBe(true)
    expect(pin).toHaveBeenCalledWith('f1')
    await expect(setFeaturePinned('f1', false)).resolves.toBe(true)
    expect(unpin).toHaveBeenCalledWith('f1')

    delete featuresApi.pin
    delete featuresApi.unpin
  })

  it('sem o par, cai no setFocus com patch parcial', async () => {
    const setFocus = vi.fn().mockResolvedValue(undefined)
    featuresApi.setFocus = setFocus
    await expect(setFeaturePinned('f1', true)).resolves.toBe(true)
    expect(setFocus).toHaveBeenCalledWith({ featureId: 'f1', pinned: true })
    delete featuresApi.setFocus
  })
})
