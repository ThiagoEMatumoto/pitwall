import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Handoff, LiveSessionInfo } from '../../../shared/types/ipc'

// O dock voltou a ter uma lista só (a equipe): sem abas, sem contador de
// perguntas entre agentes, e sem equipe ele não monta.

vi.mock('@/lib/ipc', () => ({
  handoffsApi: {
    sendMessage: vi.fn().mockResolvedValue(undefined),
    isResumable: vi.fn().mockResolvedValue(false),
  },
  prefsApi: { get: vi.fn().mockResolvedValue(null) },
}))

import { CrewDock } from './CrewDock'
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
})
