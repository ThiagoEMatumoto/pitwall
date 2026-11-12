import { render, screen } from '@testing-library/react'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Handoff } from '../../../shared/types/ipc'

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
