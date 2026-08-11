import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { Handoff, LiveSessionInfo } from '../../../shared/types/ipc'

// O peek renderiza o ChatView, que puxa transcript por IPC — aqui só interessa a
// moldura do overlay (camada, semântica de modal, teclado, selo).
vi.mock('@/features/sessions/chat/ChatView', () => ({
  ChatView: () => <div data-testid="chat-view" />,
}))
vi.mock('@/lib/ipc', () => ({
  handoffsApi: { sendMessage: vi.fn().mockResolvedValue(undefined) },
  prefsApi: { get: vi.fn().mockResolvedValue(null) },
}))

import { CrewPeek } from './CrewPeek'
import { useCrewDockStore } from './crew-dock-store'
import { useAppStore } from '@/store/appStore'
import { useHandoffsStore } from '@/store/handoffsStore'

const handoff: Handoff = {
  id: 'h1',
  motherSessionId: 'm1',
  targetRepoId: 'r1',
  targetRepoLabel: 'legal-core',
  childSessionId: 's-child',
  featureId: null,
  task: 'refatorar o auth',
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
  createdAt: 0,
  updatedAt: 0,
  consumedAt: null,
  fromRepoId: null,
  outcome: null,
}

const live: LiveSessionInfo = {
  id: 's-child',
  ccSessionId: 'cc-child',
  name: null,
  title: 'mauricio-auth-refactor',
  status: 'working',
  repo: null,
  projectName: null,
  projectIcon: null,
  projectColor: null,
  lastActivityAt: null,
  lastText: null,
}

function mount(patch: Partial<Handoff> = {}, liveStatus: LiveSessionInfo['status'] = 'working') {
  useHandoffsStore.setState({ handoffs: [{ ...handoff, ...patch }] })
  useAppStore.setState({ liveSessions: [{ ...live, status: liveStatus }] })
  useCrewDockStore.setState({ peekId: 'h1' })
  return render(<CrewPeek />)
}

describe('CrewPeek', () => {
  beforeEach(() => {
    useCrewDockStore.setState({ peekId: null })
  })

  it('o overlay fica acima das camadas do dockview (mesma faixa do Dialog)', () => {
    const { container } = mount()
    // .dv-sash = 99 e --dv-overlay-z-index = 999: abaixo de 1000 o peek some
    // atrás das divisórias assim que houver split.
    expect(container.querySelector('.fixed')!.className).toContain('z-[1000]')
  })

  it('o painel é um dialog modal rotulado pelo apelido da filha', () => {
    mount()
    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    const labelledBy = dialog.getAttribute('aria-labelledby')!
    expect(document.getElementById(labelledBy)).toHaveTextContent('Maurício')
  })

  it('Tab no último focável volta pro primeiro e Shift+Tab no primeiro vai pro último', () => {
    mount()
    const dialog = screen.getByRole('dialog')
    const items = Array.from(
      dialog.querySelectorAll<HTMLElement>('button:not([disabled]), textarea:not([disabled])'),
    )
    const first = items[0]
    const last = items[items.length - 1]

    last.focus()
    fireEvent.keyDown(dialog, { key: 'Tab' })
    expect(document.activeElement).toBe(first)

    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(last)
  })

  it('Tab no meio do overlay não é interceptado (segue o do navegador)', () => {
    mount()
    const dialog = screen.getByRole('dialog')
    const first = dialog.querySelector<HTMLElement>('button')!
    first.focus()
    const handled = fireEvent.keyDown(dialog, { key: 'Tab' })
    // fireEvent devolve false quando o handler chamou preventDefault
    expect(handled).toBe(true)
    expect(document.activeElement).toBe(first)
  })

  it('Escape continua fechando o peek', () => {
    mount()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(useCrewDockStore.getState().peekId).toBeNull()
  })

  it('com a filha bloqueada, o selo segue o handoff e não o PTY', () => {
    // O PTY diz 'working' porque a filha está parada num prompt — o cabeçalho não
    // pode anunciar "trabalhando" enquanto o corpo mostra a pergunta em aberto.
    mount({ status: 'needs_input', pendingQuestion: 'Posso apagar a tabela?' }, 'working')
    expect(screen.getByText('Aguardando resposta')).toBeInTheDocument()
    expect(screen.queryByText('trabalhando')).not.toBeInTheDocument()
  })

  // O relato: a mãe respondeu por mensagem peer, a filha retomou, e o painel
  // seguia alarmando. O registro da pergunta fica (auditoria); o alarme sai.
  it('pergunta com progresso posterior: selo volta ao vivo e o registro fica em tom neutro', () => {
    mount(
      {
        status: 'needs_input',
        pendingQuestion: 'BLOQUEIO: escopo da Frente 2?',
        questionAskedAt: 1000,
        stepUpdatedAt: 2000,
      },
      'working',
    )
    expect(screen.getByText('trabalhando')).toBeInTheDocument()
    expect(screen.queryByText('Aguardando resposta')).not.toBeInTheDocument()
    const box = screen.getByTestId('peek-question')
    expect(box).toHaveTextContent('BLOQUEIO: escopo da Frente 2?')
    expect(box).toHaveTextContent(/já retomou/)
    expect(box.style.borderColor).not.toContain('warning')
  })

  it('sem bloqueio, o selo mostra o estado ao vivo da filha', () => {
    mount({}, 'working')
    expect(screen.getByText('trabalhando')).toBeInTheDocument()
    expect(screen.queryByText('Aguardando resposta')).not.toBeInTheDocument()
  })
})
