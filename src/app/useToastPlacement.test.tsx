/** @vitest-environment jsdom */
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('@/lib/ipc', () => {
  const api = new Proxy({}, { get: () => new Proxy({}, { get: () => vi.fn() }) })
  return new Proxy({}, { get: () => api })
})

import { useFeaturePanelStore } from '@/features/session-canvas/feature-panel-store'
import { useProjectsViewStore } from '@/features/session-canvas/projects-view-store'
import { useAppStore } from '@/store/appStore'
import { useToastPlacement } from './useToastPlacement'
import { TOAST_MARGIN } from './toast-placement'

const W = 1400
let panelLeft = W - 420

beforeEach(() => {
  vi.useFakeTimers()
  Object.defineProperty(window, 'innerWidth', { value: W, configurable: true })
  const el = document.createElement('aside')
  el.setAttribute('data-feature-panel', '')
  el.getBoundingClientRect = () =>
    ({ left: panelLeft, top: 0, width: 420, height: 800 }) as DOMRect
  document.body.appendChild(el)
  useAppStore.setState({ area: 'projects' })
  useProjectsViewStore.setState({ view: 'map' })
  useFeaturePanelStore.setState({ openFeatureId: 'f1' })
})

afterEach(() => {
  document.body.innerHTML = ''
  useFeaturePanelStore.setState({ openFeatureId: null })
  vi.useRealTimers()
  panelLeft = W - 420
})

const settle = () => act(() => void vi.advanceTimersByTime(400))

describe('useToastPlacement — painel da feature', () => {
  it('abrir o dock da Equipe com o painel aberto remede o painel (a pilha não cobre o painel)', () => {
    const { result, rerender } = renderHook(({ dock }) => useToastPlacement(dock), {
      initialProps: { dock: 0 },
    })
    settle()
    expect(result.current.right).toBe(420 + TOAST_MARGIN)

    // O dock abre: o painel encosta nele e anda 400px para a esquerda.
    panelLeft = W - 820
    rerender({ dock: 400 })
    settle()
    expect(result.current.right).toBe(820 + TOAST_MARGIN)
  })

  it('fora do mapa (Terminais) a pilha ignora o painel ainda "aberto" no store', () => {
    const { result } = renderHook(() => useToastPlacement(0))
    settle()
    expect(result.current.right).toBe(420 + TOAST_MARGIN)
    act(() => useProjectsViewStore.setState({ view: 'terminals' }))
    settle()
    expect(result.current.right).toBe(TOAST_MARGIN)
  })
})
