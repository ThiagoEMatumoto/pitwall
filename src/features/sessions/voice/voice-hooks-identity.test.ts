import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { voiceApi } = vi.hoisted(() => ({
  voiceApi: { summarizeNow: vi.fn(), autoSummaryGet: vi.fn(), autoSummarySet: vi.fn() },
}))
vi.mock('@/lib/ipc', () => ({ voiceApi, prefsApi: { get: vi.fn() } }))

import { useAutoSummary } from './useAutoSummary'
import { useSummarizeNow } from './useSummarizeNow'
import { useVoiceRecorder } from './useVoiceRecorder'

beforeEach(() => {
  voiceApi.summarizeNow.mockReset().mockReturnValue(new Promise(() => {}))
  voiceApi.autoSummaryGet.mockReset().mockResolvedValue(false)
  voiceApi.autoSummarySet.mockReset().mockResolvedValue(undefined)
})

// O retorno desce como prop até a barra do composer: objeto novo por render
// re-renderizaria o Composer em memo; objeto velho com estado novo esconderia o estado.
describe('retorno dos hooks de voz', () => {
  it('useVoiceRecorder: mesmo objeto entre renders do dono', () => {
    const { result, rerender } = renderHook(() => useVoiceRecorder(() => {}))
    const first = result.current
    rerender()
    expect(result.current).toBe(first)
  })

  it('useSummarizeNow: mesmo objeto até o estado mudar, e aí um novo com o estado novo', () => {
    const { result, rerender } = renderHook(() => useSummarizeNow('cc-1'))
    const first = result.current
    rerender()
    expect(result.current).toBe(first)

    act(() => first.run())
    expect(result.current).not.toBe(first)
    expect(result.current.state).toEqual({ status: 'running' })
    // O run antigo enxerga o estado novo: não dispara um segundo resumo.
    act(() => first.run())
    expect(voiceApi.summarizeNow).toHaveBeenCalledTimes(1)
  })

  it('useAutoSummary: mesmo objeto até o estado mudar, e o toggle antigo lê o estado novo', async () => {
    const { result, rerender } = renderHook(() => useAutoSummary('cc-1'))
    await waitFor(() => expect(result.current.enabled).toBe(false))
    const settled = result.current
    rerender()
    expect(result.current).toBe(settled)

    act(() => settled.toggle())
    expect(result.current.enabled).toBe(true)
    act(() => settled.toggle())
    expect(result.current.enabled).toBe(false)
    expect(voiceApi.autoSummarySet.mock.calls).toEqual([
      ['cc-1', true],
      ['cc-1', false],
    ])
  })
})
