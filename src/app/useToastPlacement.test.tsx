/** @vitest-environment jsdom */
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('@/lib/ipc', () => {
  const api = new Proxy({}, { get: () => new Proxy({}, { get: () => vi.fn() }) })
  return new Proxy({}, { get: () => api })
})

import { useFeaturePanelStore } from '@/features/session-canvas/feature-panel-store'
import { useMotherDockStore } from '@/features/session-canvas/mother-dock'
import { useProjectsViewStore } from '@/features/session-canvas/projects-view-store'
import { useAppStore } from '@/store/appStore'
import { useCrewDockStore } from '@/features/handoffs/crew-dock-store'
import { showToast, useToastStore } from '@/features/notifications/toast-store'
import { useToastPlacement } from './useToastPlacement'
import { TOAST_EST_H, TOAST_MARGIN } from './toast-placement'

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

  // Print 03 da rodada 3: painel da mãe aberto, a pilha cobria a filha enquadrada.
  it('painel da mãe aberto: cartão de sessão é obstáculo; sem vão, "+N" na barra do mapa', () => {
    useMotherDockStore.setState({ shownId: 'm1' })
    const map = addBox({ 'data-testid': 'session-map' }, { left: 700, top: 0, width: 700, height: H })
    const card = document.createElement('div')
    card.className = 'react-flow__node react-flow__node-session'
    card.getBoundingClientRect = () => ({ left: 800, top: 120, width: 590, height: 900 }) as DOMRect
    map.appendChild(card)
    addBox({ 'data-testid': 'map-top-bar' }, { left: 700, top: 0, width: 700, height: 100 })
    const { result } = renderHook(() => useToastPlacement(0))
    act(() => void showToast({ title: 'filha despachada → web' }))
    settle()
    expect(result.current).toMatchObject({ maxVisible: 0, expandable: true })
    expect(result.current.top).toBeLessThan(100)
    useMotherDockStore.setState({ shownId: null })
  })

  it('sem painel, o mesmo cartão de sessão não é obstáculo (mapa largo)', () => {
    const map = addBox({ 'data-testid': 'session-map' }, { left: 0, top: 0, width: W, height: H })
    const card = document.createElement('div')
    card.className = 'react-flow__node react-flow__node-session'
    card.getBoundingClientRect = () => ({ left: 800, top: 120, width: 590, height: 900 }) as DOMRect
    map.appendChild(card)
    const { result } = renderHook(() => useToastPlacement(0))
    act(() => void showToast({ title: 'filha despachada → web' }))
    settle()
    expect(result.current.bottom).toBe(TOAST_MARGIN)
  })

  afterEach(() => {
    act(() => useToastStore.setState({ toasts: [] }))
  })
})

describe('useToastPlacement — modal do terminal redimensionada', () => {
  let roCallbacks: Array<() => void> = []
  beforeEach(() => {
    roCallbacks = []
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(cb: () => void) {
          roCallbacks.push(cb)
        }
        observe() {}
        disconnect() {}
      },
    )
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    useCrewDockStore.setState({ peekTarget: null })
  })

  it('a modal muda de tamanho sem a janela mudar: a pilha se remede', () => {
    const modal = document.createElement('div')
    modal.setAttribute('data-peek-mode', 'lift')
    modal.setAttribute('data-peek-lift', '')
    let width = 1000
    Object.defineProperty(modal, 'offsetLeft', { get: () => 100 })
    Object.defineProperty(modal, 'offsetTop', { get: () => 50 })
    Object.defineProperty(modal, 'offsetWidth', { get: () => width })
    Object.defineProperty(modal, 'offsetHeight', { get: () => 700 })
    document.body.appendChild(modal)
    useCrewDockStore.setState({ peekTarget: { kind: 'session', id: 's1' } })
    const { result } = renderHook(() => useToastPlacement(0))
    settle()
    // 1400 - (100 + 1000) = 300 de respiro lateral: a coluna cabe ao lado.
    expect(result.current.maxWidth).toBeDefined()

    // Arrastou o canto até quase a borda: não sobra respiro; a pilha sai do lado.
    width = 1280
    act(() => roCallbacks.forEach((cb) => cb()))
    expect(result.current.maxWidth).toBeUndefined()
  })
})

describe('useToastPlacement — janela maximizada fora do mapa', () => {
  afterEach(() => {
    act(() => useToastStore.setState({ toasts: [] }))
  })

  // Maximizar em Terminais com o composer na coluna da pilha: a altura velha dava
  // bottom = 700 − (900 − 16) = −184 e o "Desfazer" saía da tela.
  it('o resize remede a altura e a pilha continua dentro da viewport', () => {
    useFeaturePanelStore.setState({ openFeatureId: null })
    useProjectsViewStore.setState({ view: 'terminals' })
    Object.defineProperty(window, 'innerHeight', { value: 700, configurable: true })
    let composerTop = 600
    const composer = document.createElement('div')
    composer.setAttribute('data-composer-dock', '')
    composer.getBoundingClientRect = () =>
      ({ left: 0, top: composerTop, width: W, height: 100 }) as DOMRect
    document.body.appendChild(composer)

    const { result } = renderHook(() => useToastPlacement(0))
    act(
      () =>
        void showToast({ title: 'Sessão encerrada', actionLabel: 'Desfazer', onAction: () => {} }),
    )
    settle()
    expect(result.current.bottom).toBe(700 - (600 - TOAST_MARGIN))

    Object.defineProperty(window, 'innerHeight', { value: 1000, configurable: true })
    composerTop = 900
    act(() => void window.dispatchEvent(new Event('resize')))
    settle()

    const { bottom } = result.current
    expect(bottom).toBeGreaterThanOrEqual(0)
    expect(bottom).toBe(1000 - (900 - TOAST_MARGIN))
    expect(1000 - bottom! - TOAST_EST_H).toBeGreaterThanOrEqual(0)
  })
})
