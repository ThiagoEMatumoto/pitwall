import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Handoff, LiveSessionInfo } from '../../../shared/types/ipc'

// O dock voltou a ter uma lista só (a equipe): sem abas, sem contador de
// perguntas entre agentes, e sem equipe ele não monta.

vi.mock('@/lib/ipc', () => ({
  handoffsApi: {
    sendMessage: vi.fn().mockResolvedValue(undefined),
    isResumable: vi.fn().mockResolvedValue(false),
    setChildEnded: vi.fn().mockResolvedValue(null),
  },
  prefsApi: { get: vi.fn().mockResolvedValue(null) },
  // O que o endSession real do appStore toca.
  sessionsApi: {
    kill: vi.fn().mockResolvedValue(undefined),
    clearSessionDrafts: vi.fn().mockResolvedValue(undefined),
  },
  workspaceApi: { savePanes: vi.fn().mockResolvedValue(undefined) },
}))

import { CrewDock } from './CrewDock'
import { useChildActivityStore } from './child-activity-store'
import { useCrewDockStore } from './crew-dock-store'
import { useAppStore } from '@/store/appStore'
import { useHandoffsStore } from '@/store/handoffsStore'

const handoff: Handoff = {
  id: 'h1',
  motherSessionId: 'm1',
  targetRepoId: 'r1',
  targetRepoLabel: 'claude-manager',
  childSessionId: 's-child',
  featureId: null,
  task: 'remover o canal de perguntas',
  contextJson: null,
  composedPrompt: '',
  status: 'running',
  mode: 'interactive',
  currentStep: null,
  stepUpdatedAt: null,
  pendingQuestion: null,
  questionAskedAt: null,
  summary: null,
  error: null,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  consumedAt: null,
  fromRepoId: null,
  outcome: null,
  dismissedAt: null,
  resumable: false,
  predecessorSessionId: null,
  endedByUserAt: null,
}

beforeAll(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  )
})

describe('CrewDock', () => {
  beforeEach(() => {
    useAppStore.setState({ liveSessions: [] })
    useHandoffsStore.setState({ handoffs: [] })
    useCrewDockStore.setState({ collapsed: false })
  })

  it('sem filha delegada não monta', () => {
    const { container } = render(<CrewDock />)
    expect(container).toBeEmptyDOMElement()
  })

  it('aberto: cabeçalho "Equipe N" e os cards, sem abas nem Conversas', () => {
    useHandoffsStore.setState({ handoffs: [handoff] })
    render(<CrewDock />)

    expect(screen.getByTestId('crew-dock')).toBeInTheDocument()
    expect(screen.getByTestId('crew-dock-title')).toHaveTextContent('Equipe1')
    expect(screen.getByTestId('handoff-task')).toHaveTextContent('remover o canal de perguntas')
    expect(screen.queryByRole('tablist')).toBeNull()
    expect(screen.queryByRole('tab')).toBeNull()
    expect(screen.queryByTestId('conversations-tab-button')).toBeNull()
  })

  it('recolhido: a trilha não tem o atalho de Conversas', () => {
    useHandoffsStore.setState({ handoffs: [handoff] })
    useCrewDockStore.setState({ collapsed: true })
    render(<CrewDock />)

    expect(screen.getByTestId('crew-rail-child')).toBeInTheDocument()
    expect(screen.queryByTestId('crew-rail-conversations')).toBeNull()
  })
})

// O dot era só mais um jeito de expandir o dock: clicar na filha X abria a lista
// inteira e deixava achar a X por conta do usuário.
describe('CrewDock: o dot da trilha foca aquela filha', () => {
  const live: LiveSessionInfo = {
    id: 's-child',
    ccSessionId: 'cc-child',
    name: null,
    title: 'mauricio-remover-canal',
    status: 'working',
    repo: null,
    projectName: null,
    projectIcon: null,
    projectColor: null,
    lastActivityAt: Date.now(),
    lastText: null,
  }
  const realFocusOrOpenSession = useAppStore.getState().focusOrOpenSession
  const focusOrOpenSession = vi.fn().mockResolvedValue(undefined)

  beforeEach(() => {
    focusOrOpenSession.mockClear()
    useAppStore.setState({ liveSessions: [], focusOrOpenSession })
    useHandoffsStore.setState({ handoffs: [handoff] })
    useCrewDockStore.setState({ collapsed: true, focusedId: null })
    useChildActivityStore.setState({ unread: {} })
  })
  afterEach(() => {
    useAppStore.setState({ liveSessions: [], focusOrOpenSession: realFocusOrOpenSession })
  })

  it('filha viva: abre a aba dela e a trilha segue recolhida', () => {
    useAppStore.setState({ liveSessions: [live] })
    render(<CrewDock />)

    fireEvent.click(screen.getByTestId('crew-rail-child'))

    expect(focusOrOpenSession).toHaveBeenCalledWith(live)
    expect(useCrewDockStore.getState().collapsed).toBe(true)
  })

  it('sem processo: expande o dock com o foco no card dela', async () => {
    const other: Handoff = { ...handoff, id: 'h0', childSessionId: 's-other', task: 'outra frente' }
    useHandoffsStore.setState({ handoffs: [other, handoff] })
    render(<CrewDock />)

    fireEvent.click(screen.getAllByTestId('crew-rail-child')[1])

    expect(focusOrOpenSession).not.toHaveBeenCalled()
    expect(useCrewDockStore.getState().collapsed).toBe(false)
    await waitFor(() =>
      expect(document.activeElement?.getAttribute('data-crew-card')).toBe('h1'),
    )
    expect(useCrewDockStore.getState().focusedId).toBe('h1')
  })

  it("'ended' ainda na lista viva não tem aba a abrir: vai pro card", () => {
    useAppStore.setState({ liveSessions: [{ ...live, status: 'ended' }] })
    render(<CrewDock />)

    fireEvent.click(screen.getByTestId('crew-rail-child'))

    expect(focusOrOpenSession).not.toHaveBeenCalled()
    expect(useCrewDockStore.getState().collapsed).toBe(false)
  })

  it('mensagem da mãe não lida: ponto no dot dela e o motivo no rótulo', () => {
    const other: Handoff = { ...handoff, id: 'h0', childSessionId: 's-other', task: 'outra frente' }
    useHandoffsStore.setState({ handoffs: [other, handoff] })
    useAppStore.setState({ liveSessions: [{ ...live, id: 's-other', ccSessionId: 'cc-o' }, live] })
    useChildActivityStore.setState({ unread: { 's-child': 'message' } })
    render(<CrewDock />)

    const [quiet, marked] = screen.getAllByTestId('crew-rail-child')
    expect(within(marked).getByTestId('crew-rail-unread')).toBeInTheDocument()
    expect(marked.title).toContain('a mãe mandou mensagem e você ainda não abriu a aba')
    expect(marked.getAttribute('aria-label')).toContain('a mãe mandou mensagem')
    expect(within(quiet).queryByTestId('crew-rail-unread')).toBeNull()
    expect(quiet.title).not.toContain('mensagem')
  })
})

// O Delete do dock é o "×" do card pelo teclado: vale a mesma regra.
describe('CrewDock: Delete arquiva o card só com o processo morto', () => {
  const realDismiss = useHandoffsStore.getState().dismiss
  const dismiss = vi.fn().mockResolvedValue(undefined)

  beforeEach(() => {
    dismiss.mockClear()
    useAppStore.setState({ liveSessions: [] })
    useHandoffsStore.setState({ handoffs: [handoff], dismiss })
    useCrewDockStore.setState({ collapsed: false, focusedId: null })
  })
  afterEach(() => {
    useAppStore.setState({ liveSessions: [] })
    useHandoffsStore.setState({ handoffs: [], dismiss: realDismiss })
  })

  function pressDeleteOnCard() {
    const { container } = render(<CrewDock />)
    const card = container.querySelector<HTMLElement>('[data-crew-card="h1"]')!
    fireEvent.keyDown(card, { key: 'Delete' })
  }

  it('filha viva: Delete não arquiva', () => {
    useAppStore.setState({
      liveSessions: [{ id: 's-child', ccSessionId: 'cc-child', status: 'working' } as LiveSessionInfo],
    })
    pressDeleteOnCard()
    expect(dismiss).not.toHaveBeenCalled()
  })

  it('processo morto: Delete arquiva', () => {
    pressDeleteOnCard()
    expect(dismiss).toHaveBeenCalledWith('h1')
  })

  // O endSession (o do appStore, não um mock) tira a filha da lista viva na hora,
  // mas a PTY só morre quando a janela do Desfazer expira.
  describe('Encerrar com o Desfazer em aberto', () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })
    afterEach(() => {
      vi.runAllTimers()
      vi.useRealTimers()
    })

    it('Delete não arquiva: a PTY segue viva', () => {
      useAppStore.setState({
        liveSessions: [{ id: 's-child', ccSessionId: 'cc-child', status: 'idle' } as LiveSessionInfo],
      })
      useAppStore.getState().endSession('s-child', { linkedChild: true })
      expect(useAppStore.getState().liveSessions).toEqual([])
      pressDeleteOnCard()
      expect(dismiss).not.toHaveBeenCalled()
    })
  })
})
