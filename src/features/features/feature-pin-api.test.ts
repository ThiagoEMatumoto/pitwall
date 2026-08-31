import { describe, expect, it, vi } from 'vitest'

const setFocus = vi.fn()
const dismiss = vi.fn()
vi.mock('@/lib/ipc', () => ({
  featuresApi: {
    setFocus: (input: unknown) => setFocus(input),
    dismissDuplicate: (id: string) => dismiss(id),
  },
}))

const { dismissDuplicate, setFeaturePinned } = await import('./feature-pin-api')

describe('feature-pin-api', () => {
  it('fixa e desafixa por patch parcial (o botão não conhece o rank)', async () => {
    setFocus.mockResolvedValue(undefined)
    await expect(setFeaturePinned('f1', true)).resolves.toBe(true)
    expect(setFocus).toHaveBeenCalledWith({ featureId: 'f1', pinned: true })
    await expect(setFeaturePinned('f1', false)).resolves.toBe(true)
    expect(setFocus).toHaveBeenCalledWith({ featureId: 'f1', pinned: false })
  })

  it('falha do IPC vira false — quem chama avisa em vez de deixar o botão mudo', async () => {
    setFocus.mockRejectedValue(new Error('feature not found: f1'))
    await expect(setFeaturePinned('f1', true)).resolves.toBe(false)
    dismiss.mockRejectedValue(new Error('nope'))
    await expect(dismissDuplicate('f1')).resolves.toBe(false)
  })

  it('dispensar a suspeita chama o canal dedicado', async () => {
    dismiss.mockResolvedValue(undefined)
    await expect(dismissDuplicate('f1')).resolves.toBe(true)
    expect(dismiss).toHaveBeenCalledWith('f1')
  })
})
