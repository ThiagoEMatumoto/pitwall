import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/ipc', () => ({
  sessionGraphApi: { onUpdated: () => () => {}, get: () => new Promise(() => {}) },
}))

import { FeatureSwitcher } from './FeatureSwitcher'
import { useFeatureMruStore } from './feature-mru-store'
import { useFeaturePanelStore } from './feature-panel-store'
import { useMapFocusStore } from './map-focus-store'
import { useProjectsViewStore } from './projects-view-store'
import { useSessionGraphStore } from '@/features/sessions/session-graph-store'
import { useAppStore } from '@/store/appStore'
import { setKeyboardLayoutLabels } from '@/lib/keybindings'
import type { SessionGraphLane } from '../../../shared/types/session-graph'

const lane = (featureId: string): SessionGraphLane => ({
  kind: 'feature',
  featureId,
  projectId: 'p1',
  projectName: 'Proj',
  name: `Feature ${featureId}`,
  color: null,
  pulse: null,
  status: 'in_progress',
  pinned: false,
  repos: [],
})

const ctrlBackquote = (shiftKey = false) =>
  fireEvent.keyDown(window, { key: '`', code: 'Backquote', ctrlKey: true, shiftKey })
const releaseCtrl = () => fireEvent.keyUp(window, { key: 'Control', code: 'ControlLeft' })

describe('FeatureSwitcher', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    // jsdom não implementa scrollIntoView.
    Element.prototype.scrollIntoView = vi.fn()
    localStorage.clear()
    useSessionGraphStore.setState({
      graph: { nodes: [], edges: [], lanes: [lane('f1'), lane('f2'), lane('f3')] },
    })
    useFeatureMruStore.setState({ order: ['f2', 'f3', 'f1'] })
    useMapFocusStore.setState({ featureId: 'f2', frame: null })
    useAppStore.setState({ area: 'features' })
    useProjectsViewStore.getState().setView('terminals')
  })

  it('segurar mostra o overlay em ordem MRU; Tab avança; soltar confirma e leva ao mapa', () => {
    render(<FeatureSwitcher />)
    ctrlBackquote()
    act(() => void vi.advanceTimersByTime(200))
    const opts = screen.getAllByRole('option')
    expect(opts.map((o) => o.getAttribute('data-key'))).toEqual(['f2', 'f3', 'f1'])
    expect(opts[1].getAttribute('aria-selected')).toBe('true')
    const list = screen.getByRole('listbox')
    expect(list.getAttribute('aria-activedescendant')).toBe(opts[1].id)
    fireEvent.keyDown(window, { key: 'Tab', code: 'Tab', ctrlKey: true })
    expect(screen.getAllByRole('option')[2].getAttribute('aria-selected')).toBe('true')
    releaseCtrl()
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(useMapFocusStore.getState().featureId).toBe('f1')
    expect(useMapFocusStore.getState().frame?.featureId).toBe('f1')
    expect(useAppStore.getState().area).toBe('projects')
    expect(useProjectsViewStore.getState().view).toBe('map')
  })

  it('no escopo de outro projeto, confirmar abre o mapa em "Todos"', () => {
    useProjectsViewStore.getState().setScopeMode('project')
    useAppStore.setState({ activeProjectId: 'p9' })
    render(<FeatureSwitcher />)
    ctrlBackquote()
    releaseCtrl()
    expect(useMapFocusStore.getState().featureId).toBe('f3')
    expect(useProjectsViewStore.getState().scopeMode).toBe('all')
  })

  it('no escopo do projeto da feature, o escopo fica', () => {
    useProjectsViewStore.getState().setScopeMode('project')
    useAppStore.setState({ activeProjectId: 'p1' })
    render(<FeatureSwitcher />)
    ctrlBackquote()
    releaseCtrl()
    expect(useProjectsViewStore.getState().scopeMode).toBe('project')
    useProjectsViewStore.getState().setScopeMode('all')
  })

  it('toque rápido alterna para a anterior sem mostrar o overlay', () => {
    render(<FeatureSwitcher />)
    ctrlBackquote()
    releaseCtrl()
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(useMapFocusStore.getState().featureId).toBe('f3')
  })

  it('Esc cancela sem mudar nada; Shift volta; setas também navegam', () => {
    render(<FeatureSwitcher />)
    ctrlBackquote(true)
    act(() => void vi.advanceTimersByTime(200))
    expect(screen.getAllByRole('option')[2].getAttribute('aria-selected')).toBe('true')
    fireEvent.keyDown(window, { key: 'ArrowUp', code: 'ArrowUp', ctrlKey: true })
    expect(screen.getAllByRole('option')[1].getAttribute('aria-selected')).toBe('true')
    fireEvent.keyDown(window, { key: 'Escape', code: 'Escape', ctrlKey: true })
    releaseCtrl()
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(useMapFocusStore.getState().featureId).toBe('f2')
    expect(useMapFocusStore.getState().frame).toBeNull()
    expect(useAppStore.getState().area).toBe('features')
  })

  it('aberto, nenhuma tecla chega a quem escuta depois (xterm, atalhos)', () => {
    render(<FeatureSwitcher />)
    const spy = vi.fn()
    window.addEventListener('keydown', spy)
    ctrlBackquote()
    fireEvent.keyDown(window, { key: 'Tab', code: 'Tab', ctrlKey: true })
    fireEvent.keyDown(window, { key: 'a', code: 'KeyA', ctrlKey: true })
    expect(spy).not.toHaveBeenCalled()
    releaseCtrl()
    window.removeEventListener('keydown', spy)
  })

  it('"Sem feature": enquadra o grupo sem mudar a feature; o toque seguinte volta à anterior', () => {
    useSessionGraphStore.setState({
      graph: {
        nodes: [],
        edges: [],
        lanes: [
          lane('f1'),
          lane('f2'),
          { kind: 'project', projectId: 'p1', name: 'Proj', color: null, repos: [] },
        ],
      },
    })
    useFeatureMruStore.setState({ order: ['f2', 'f1'] })
    render(<FeatureSwitcher />)
    ctrlBackquote(true) // Shift abre pela última: o grupo do projeto
    releaseCtrl()
    expect(useMapFocusStore.getState().frame).toMatchObject({
      flowId: 'lane:p:p1',
      featureId: null,
    })
    expect(useMapFocusStore.getState().featureId).toBe('f2')
    ctrlBackquote()
    releaseCtrl()
    expect(useMapFocusStore.getState().featureId).toBe('f2')
    expect(useMapFocusStore.getState().frame).toMatchObject({ flowId: 'lane:f:f2' })
  })

  it('confirmar fecha o painel de outra feature (o mapa, ao montar, voltaria a ela)', () => {
    useFeaturePanelStore.setState({ openFeatureId: 'f1' })
    render(<FeatureSwitcher />)
    ctrlBackquote()
    releaseCtrl()
    expect(useMapFocusStore.getState().featureId).toBe('f3')
    expect(useFeaturePanelStore.getState().openFeatureId).toBeNull()
  })

  it('com um dialog aberto o combo não abre o seletor (o teclado é do dialog)', () => {
    const modal = document.createElement('div')
    modal.setAttribute('data-modal-overlay', '')
    document.body.appendChild(modal)
    try {
      render(<FeatureSwitcher />)
      ctrlBackquote()
      act(() => void vi.advanceTimersByTime(200))
      expect(screen.queryByRole('listbox')).toBeNull()
      releaseCtrl()
      expect(useMapFocusStore.getState().featureId).toBe('f2')
    } finally {
      modal.remove()
    }
  })

  it('o overlay vai por portal ao body, acima das camadas z-[1000]', () => {
    render(<FeatureSwitcher />)
    ctrlBackquote()
    act(() => void vi.advanceTimersByTime(200))
    const overlay = screen.getByTestId('feature-switcher')
    expect(overlay.parentElement).toBe(document.body)
    expect(overlay.className).toContain('z-[1100]')
    releaseCtrl()
  })

  // Regressão: o listener do seletor entrava depois dos de captura do mapa
  // montado no boot (Ctrl+Shift+P do painel, Ctrl+Shift+O), que rodavam por baixo.
  it('aberto, cala até os listeners de captura registrados ANTES dele', () => {
    const early = vi.fn()
    window.addEventListener('keydown', early, true)
    try {
      render(<FeatureSwitcher />)
      ctrlBackquote()
      fireEvent.keyDown(window, { key: 'P', code: 'KeyP', ctrlKey: true, shiftKey: true })
      expect(early).not.toHaveBeenCalled()
      releaseCtrl()
    } finally {
      window.removeEventListener('keydown', early, true)
    }
  })

  // Regressão: escolhido um "Sem feature", voltar à feature em foco pelo cartão
  // (setFeature sem mudar a em foco) não contava e o toque ficava nela. Com f2 de
  // novo como a atual, o toque vai à anterior entre as features (os grupos "Sem
  // feature" fecham a lista).
  it('"Sem feature" → cartão da feature em foco → toque rápido sai dela', () => {
    useSessionGraphStore.setState({
      graph: {
        nodes: [],
        edges: [],
        lanes: [
          lane('f1'),
          lane('f2'),
          { kind: 'project', projectId: 'p1', name: 'Proj', color: null, repos: [] },
        ],
      },
    })
    useFeatureMruStore.setState({ order: ['f2', 'f1'] })
    render(<FeatureSwitcher />)
    ctrlBackquote(true)
    releaseCtrl()
    expect(useMapFocusStore.getState().frame).toMatchObject({ flowId: 'lane:p:p1' })
    useMapFocusStore.getState().takeFrame()
    useMapFocusStore.getState().setFeature('f2') // clique num cartão de f2
    ctrlBackquote()
    releaseCtrl()
    expect(useMapFocusStore.getState().frame).toMatchObject({ flowId: 'lane:f:f1' })
    expect(useMapFocusStore.getState().featureId).toBe('f1')
  })

  // Regressão: no boot (a feature em foco não persiste) o toque pulava a mais recente.
  it('sem feature em foco, o toque rápido vai à mais recente do MRU', () => {
    useMapFocusStore.setState({ featureId: null, frame: null })
    render(<FeatureSwitcher />)
    ctrlBackquote()
    releaseCtrl()
    expect(useMapFocusStore.getState().featureId).toBe('f2')
  })

  it('a dica sai do combo e do layout do teclado', () => {
    setKeyboardLayoutLabels(new Map([['Backquote', "'"]]))
    try {
      render(<FeatureSwitcher />)
      ctrlBackquote()
      act(() => void vi.advanceTimersByTime(200))
      expect(screen.getByTestId('feature-switcher')).toHaveTextContent(
        "Solte o Ctrl para abrir · ' ou Tab avança",
      )
      const keys = [...screen.getByTestId('feature-switcher').querySelectorAll('kbd')]
      expect(keys.map((k) => k.textContent)).toContain("'")
      releaseCtrl()
    } finally {
      setKeyboardLayoutLabels(new Map())
    }
  })

  it('fechado, não reconstrói a lista a cada tail (só ao abrir)', () => {
    const { container } = render(<FeatureSwitcher />)
    useSessionGraphStore.setState({
      graph: { nodes: [], edges: [], lanes: [lane('f1'), lane('f2'), lane('f3'), lane('f4')] },
    })
    useFeatureMruStore.setState({ order: ['f2', 'f4', 'f3', 'f1'] })
    expect(container.innerHTML).toBe('')
    ctrlBackquote()
    act(() => void vi.advanceTimersByTime(200))
    // A lista é a do grafo NA HORA de abrir.
    expect(screen.getAllByRole('option').map((o) => o.getAttribute('data-key'))).toEqual([
      'f2',
      'f4',
      'f3',
      'f1',
    ])
    releaseCtrl()
  })
})
