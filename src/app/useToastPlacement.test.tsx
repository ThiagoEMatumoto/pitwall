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
import { showToast, useToastStore } from '@/features/notifications/toast-store'
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

describe('useToastPlacement — cartão da mãe e coluna fixada', () => {
  const H = 900
  function addBox(
    attrs: Record<string, string>,
    box: { left: number; top: number; width: number; height: number },
  ) {
    const el = document.createElement('div')
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v)
    el.getBoundingClientRect = () => box as DOMRect
    document.body.appendChild(el)
    return el
  }

  beforeEach(() => {
    useFeaturePanelStore.setState({ openFeatureId: null })
    Object.defineProperty(window, 'innerHeight', { value: H, configurable: true })
  })

  it('com um toast à vista, a pilha sobe para cima do cartão da mãe', () => {
    addBox({ 'data-variant': 'mother' }, { left: W - 600, top: 400, width: 580, height: 420 })
    const { result } = renderHook(() => useToastPlacement(0))
    act(() => void showToast({ title: 'filha despachada → web' }))
    settle()
    expect(result.current.bottom).toBe(H - 400 + TOAST_MARGIN)
  })

  it('o cartão da mãe anda com o pan: a pilha acompanha na releitura seguinte', () => {
    let top = 400
    const el = addBox({ 'data-variant': 'mother' }, { left: W - 600, top, width: 580, height: 420 })
    el.getBoundingClientRect = () => ({ left: W - 600, top, width: 580, height: 420 }) as DOMRect
    const { result } = renderHook(() => useToastPlacement(0))
    act(() => void showToast({ title: 'filha despachada → web' }))
    settle()
    top = 300
    settle()
    expect(result.current.bottom).toBe(H - 300 + TOAST_MARGIN)
  })

  it('a coluna da mãe fixada também é obstáculo', () => {
    Object.defineProperty(window, 'innerWidth', { value: 760, configurable: true })
    addBox({ 'data-testid': 'mother-dock' }, { left: 0, top: 40, width: 460, height: H - 40 })
    const { result } = renderHook(() => useToastPlacement(0))
    act(() => void showToast({ title: 'filha despachada → web' }))
    settle()
    const p = result.current
    const width = p.maxWidth ?? 320
    expect(760 - p.right - width).toBeGreaterThanOrEqual(460)
  })

  afterEach(() => {
    act(() => useToastStore.setState({ toasts: [] }))
  })
})
