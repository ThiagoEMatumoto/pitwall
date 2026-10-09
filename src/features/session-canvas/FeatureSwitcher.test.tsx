import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/ipc', () => ({
  sessionGraphApi: { onUpdated: () => () => {}, get: () => new Promise(() => {}) },
}))

import { FeatureSwitcher, FeatureSwitcherButton } from './FeatureSwitcher'
import { useFeatureMruStore } from './feature-mru-store'
import { useFeatureRoomStore } from '@/features/feature-room/feature-room-store'
import { useRoomPanelStore } from '@/features/feature-room/room-panel-store'
import { useFeaturePanelStore } from './feature-panel-store'
import { useMapFocusStore } from './map-focus-store'
import { useProjectsViewStore } from './projects-view-store'
import { useSessionGraphStore } from '@/features/sessions/session-graph-store'
import { useAppStore } from '@/store/appStore'
import { setKeyboardLayoutLabels } from '@/lib/keybindings'
import type {
  SessionGraph,
  SessionGraphLane,
  SessionGraphNode,
} from '../../../shared/types/session-graph'

// Cada card tem uma sessão viva: o seletor só lista o que o mapa desenha.
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
  repos: [{ repoId: 'r1', label: 'repo', sessionIds: [`s-${featureId}`] }],
})
const looseLane: SessionGraphLane = {
  kind: 'project',
  projectId: 'p1',
  name: 'Proj',
  color: null,
  repos: [{ repoId: 'r1', label: 'repo', sessionIds: ['s-loose'] }],
}

const liveNode = (sessionId: string, featureId: string | null): SessionGraphNode => ({
  sessionId,
  ccSessionId: `cc-${sessionId}`,
  title: sessionId,
  projectId: 'p1',
  repoId: 'r1',
  repoLabel: 'repo',
  provider: 'claude',
  status: 'idle',
  attentionReason: null,
  lastActivityAt: 1,
  purposeHint: null,
  purpose: null,
  purposeSource: null,
  groupId: null,
  lastSummary: null,
  lastSummaryAt: null,
  childOfHandoffId: null,
  featureId,
})

const graphOf = (lanes: SessionGraphLane[]): SessionGraph => ({
  lanes,
  edges: [],
  nodes: lanes.flatMap((l) =>
    l.repos.flatMap((r) =>
      r.sessionIds.map((id) => liveNode(id, l.kind === 'feature' ? l.featureId : null)),
    ),
  ),
})

const ctrlBackquote = (shiftKey = false) =>
  fireEvent.keyDown(window, { key: '`', code: 'Backquote', ctrlKey: true, shiftKey })
const releaseCtrl = () => fireEvent.keyUp(window, { key: 'Control', code: 'ControlLeft' })
// O botão "Trocar feature" da barra do mapa: confirmar fica no mapa (OPEN-8).
const pickFromMapButton = () => {
  fireEvent.click(screen.getByTestId('map-feature-switcher'))
  fireEvent.keyDown(window, { key: 'Enter', code: 'Enter' })
}
// Ctrl+` numa feature: a visão de projeto com o painel da Room filtrado nela.
const roomFeature = () => useRoomPanelStore.getState().featureFilter

describe('FeatureSwitcher', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    // jsdom não implementa scrollIntoView.
    Element.prototype.scrollIntoView = vi.fn()
    localStorage.clear()
    useSessionGraphStore.setState({
      graph: graphOf([lane('f1'), lane('f2'), lane('f3')]),
    })
    useFeatureMruStore.setState({ order: ['f2', 'f3', 'f1'] })
    useMapFocusStore.setState({ featureId: 'f2', frame: null })
    useAppStore.setState({ area: 'features' })
    useFeatureRoomStore.setState({ featureId: null })
    useRoomPanelStore.setState({ open: false, featureFilter: null, focus: null })
    useProjectsViewStore.getState().setView('terminals')
  })

  it('segurar mostra o overlay em ordem MRU; Tab avança; soltar confirma e abre o painel da Room', () => {
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
    expect(roomFeature()).toBe('f1')
    expect(useAppStore.getState().area).toBe('projects')
    expect(useRoomPanelStore.getState().open).toBe(true)
    expect(useFeatureMruStore.getState().order[0]).toBe('f1')
    expect(useMapFocusStore.getState().frame).toBeNull()
  })

  it('no escopo de outro projeto, confirmar abre o mapa em "Todos"', () => {
    useProjectsViewStore.getState().setScopeMode('project')
    useAppStore.setState({ activeProjectId: 'p9' })
    render(
      <>
        <FeatureSwitcher />
        <FeatureSwitcherButton />
      </>,
    )
    pickFromMapButton()
    expect(useMapFocusStore.getState().featureId).toBe('f3')
    expect(useProjectsViewStore.getState().scopeMode).toBe('all')
  })

  it('no escopo do projeto da feature, o escopo fica', () => {
    useProjectsViewStore.getState().setScopeMode('project')
    useAppStore.setState({ activeProjectId: 'p1' })
    render(
      <>
        <FeatureSwitcher />
        <FeatureSwitcherButton />
      </>,
    )
    pickFromMapButton()
    expect(useProjectsViewStore.getState().scopeMode).toBe('project')
    useProjectsViewStore.getState().setScopeMode('all')
  })

  it('toque rápido alterna para a anterior sem mostrar o overlay', () => {
    render(<FeatureSwitcher />)
    ctrlBackquote()
    releaseCtrl()
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(roomFeature()).toBe('f3')
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
      graph: graphOf([lane('f1'), lane('f2'), looseLane]),
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
    expect(roomFeature()).toBe('f2')
    expect(useAppStore.getState().area).toBe('projects')
    expect(useRoomPanelStore.getState().open).toBe(true)
  })

  it('confirmar fecha o painel de outra feature (o mapa, ao montar, voltaria a ela)', () => {
    useFeaturePanelStore.setState({ openFeatureId: 'f1' })
    render(
      <>
        <FeatureSwitcher />
        <FeatureSwitcherButton />
      </>,
    )
    pickFromMapButton()
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
      graph: graphOf([lane('f1'), lane('f2'), looseLane]),
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
    expect(roomFeature()).toBe('f1')
  })

  // Regressão: no boot (a feature em foco não persiste) o toque pulava a mais recente.
  it('sem feature em foco, o toque rápido vai à mais recente do MRU', () => {
    useMapFocusStore.setState({ featureId: null, frame: null })
    render(<FeatureSwitcher />)
    ctrlBackquote()
    releaseCtrl()
    expect(roomFeature()).toBe('f2')
  })

  // No ABNT2 o layout rotula o Backquote como "'": a dica mostra a crase (o nome do
  // atalho) e a tecla física que o dispara.
  it('a dica sai do combo, com a crase e a tecla física no ABNT2', () => {
    setKeyboardLayoutLabels(new Map([['Backquote', "'"]]))
    try {
      render(<FeatureSwitcher />)
      ctrlBackquote()
      act(() => void vi.advanceTimersByTime(200))
      expect(screen.getByTestId('feature-switcher')).toHaveTextContent(
        "Solte o Ctrl para abrir · ` (tecla ') ou Tab avança",
      )
      const keys = [...screen.getByTestId('feature-switcher').querySelectorAll('kbd')]
      expect(keys.map((k) => k.textContent)).toContain('`')
      expect(keys.map((k) => k.textContent)).not.toContain("'")
      releaseCtrl()
    } finally {
      setKeyboardLayoutLabels(new Map())
    }
  })

  it('só lista as features com sessão viva (a regra do mapa)', () => {
    const g = graphOf([lane('f1'), lane('f2'), lane('f3'), looseLane])
    useSessionGraphStore.setState({
      graph: {
        ...g,
        nodes: g.nodes.map((n) =>
          n.sessionId === 's-f3' || n.sessionId === 's-loose' ? { ...n, status: 'ended' } : n,
        ),
      },
    })
    render(<FeatureSwitcher />)
    ctrlBackquote()
    act(() => void vi.advanceTimersByTime(200))
    expect(screen.getAllByRole('option').map((o) => o.getAttribute('data-key'))).toEqual([
      'f2',
      'f1',
    ])
    expect(screen.getByTestId('feature-switcher-backdrop')).toBeTruthy()
    releaseCtrl()
  })

  it('clicar no fundo cancela e o foco volta para onde estava (o mousedown não o rouba)', () => {
    render(
      <>
        <input data-testid="typing" />
        <FeatureSwitcher />
      </>,
    )
    const typing = screen.getByTestId('typing')
    typing.focus()
    ctrlBackquote()
    act(() => void vi.advanceTimersByTime(200))
    expect(document.activeElement).not.toBe(typing)
    // false = preventDefault: sem ele, o default do mousedown leva o foco ao <body>.
    expect(fireEvent.mouseDown(screen.getByTestId('feature-switcher-backdrop'))).toBe(false)
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(document.activeElement).toBe(typing)
    releaseCtrl()
  })

  it('o botão da barra do mapa abre sem modificador; soltar tecla não confirma, o clique sim', () => {
    render(
      <>
        <FeatureSwitcher />
        <FeatureSwitcherButton />
      </>,
    )
    const btn = screen.getByTestId('map-feature-switcher')
    expect(btn.getAttribute('title')).toBe('Trocar feature (Ctrl+`)')
    fireEvent.click(btn)
    expect(screen.getAllByRole('option')).toHaveLength(3)
    // Aberto pelo botão, soltar o Ctrl não faz nada: a dica não pode mandar soltá-lo.
    expect(screen.getByTestId('feature-switcher')).not.toHaveTextContent('Solte o')
    expect(screen.getByTestId('feature-switcher')).toHaveTextContent('Enter ou clique abre')
    fireEvent.keyDown(window, { key: 'ArrowDown', code: 'ArrowDown' })
    fireEvent.keyUp(window, { key: 'ArrowDown', code: 'ArrowDown' })
    expect(screen.queryByRole('listbox')).not.toBeNull()
    fireEvent.click(screen.getAllByRole('option')[2])
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(useMapFocusStore.getState().featureId).toBe('f1')
  })

  it('fechado, não reconstrói a lista a cada tail (só ao abrir)', () => {
    const { container } = render(<FeatureSwitcher />)
    useSessionGraphStore.setState({
      graph: graphOf([lane('f1'), lane('f2'), lane('f3'), lane('f4')]),
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
