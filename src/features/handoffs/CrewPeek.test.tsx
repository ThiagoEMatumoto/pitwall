import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { Handoff, LiveSessionInfo } from '../../../shared/types/ipc'

// O peek renderiza o ChatView, que puxa transcript por IPC — aqui só interessa a
// moldura do overlay (camada, semântica de modal, teclado, selo).
vi.mock('@/features/sessions/chat/ChatView', () => ({
  ChatView: () => <div data-testid="chat-view" />,
}))
// O Terminal real monta xterm/WebGL (canvas, que o jsdom não tem). O que estes
// testes travam é o CONTRATO do overlay com ele: que modo/chrome ele recebe.
const { terminalProps } = vi.hoisted(() => ({ terminalProps: [] as Record<string, unknown>[] }))
vi.mock('@/features/sessions/Terminal', () => ({
  Terminal: (props: Record<string, unknown>) => {
    terminalProps.push(props)
    return (
      <div data-testid="peek-terminal">
        <textarea data-testid="fake-xterm" />
      </div>
    )
  },
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
  dismissedAt: null,
  resumable: false,
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
    useCrewDockStore.setState({ peekId: null, peekMode: 'chat' })
    useAppStore.setState({ panes: [] })
    terminalProps.length = 0
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

describe('CrewPeek em modo terminal', () => {
  beforeEach(() => {
    useCrewDockStore.setState({ peekId: null, peekMode: 'chat' })
    useAppStore.setState({ panes: [] })
    terminalProps.length = 0
  })

  function mountTerminal() {
    useHandoffsStore.setState({ handoffs: [handoff] })
    useAppStore.setState({ liveSessions: [live] })
    useCrewDockStore.setState({ peekId: 'h1', peekMode: 'terminal' })
    return render(<CrewPeek />)
  }

  it('o botão Terminal troca o modo DENTRO da janela, sem criar pane', () => {
    const focusOrOpenSession = vi.fn()
    useAppStore.setState({ focusOrOpenSession })
    mount()
    fireEvent.click(screen.getByText('Terminal'))
    expect(useCrewDockStore.getState().peekMode).toBe('terminal')
    expect(useCrewDockStore.getState().peekId).toBe('h1')
    expect(focusOrOpenSession).not.toHaveBeenCalled()
    expect(useAppStore.getState().panes).toEqual([])
  })

  // A razão de existir desta tela: "só vou dar uma olhada" não pode ter um botão
  // de desligar a um clique. O terminal entra sem o header de sessão.
  it('o terminal entra sem a moldura de sessão (nada de encerrar aqui)', () => {
    mountTerminal()
    expect(screen.getByTestId('peek-terminal')).toBeInTheDocument()
    expect(screen.queryByTestId('chat-view')).not.toBeInTheDocument()
    expect(terminalProps.at(-1)).toMatchObject({ chrome: 'bare', mode: 'terminal' })
    expect(screen.queryByLabelText('Encerrar')).toBeNull()
  })

  it('Esc com o foco no terminal pertence à filha; shift+esc fecha a janela', () => {
    mountTerminal()
    screen.getByTestId('fake-xterm').focus()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(useCrewDockStore.getState().peekId).toBe('h1')
    fireEvent.keyDown(window, { key: 'Escape', shiftKey: true })
    expect(useCrewDockStore.getState().peekId).toBeNull()
  })

  it('Esc fora do corpo (foco na moldura) continua fechando', () => {
    mountTerminal()
    screen.getByLabelText('Fechar').focus()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(useCrewDockStore.getState().peekId).toBeNull()
  })

  it('Tab não é sequestrado em modo terminal — é tecla da TUI', () => {
    mountTerminal()
    const dialog = screen.getByRole('dialog')
    const first = dialog.querySelector<HTMLElement>('button')!
    first.focus()
    expect(fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true })).toBe(true)
    expect(document.activeElement).toBe(first)
  })

  // Dois xterms na mesma PTY brigariam pelo sessionsApi.resize.
  it('com aba já aberta pra esta filha, o Terminal leva pra aba em vez de duplicar', () => {
    const focusOrOpenSession = vi.fn()
    useAppStore.setState({
      focusOrOpenSession,
      panes: [{ paneId: 'p1', session: { ccSessionId: 'cc-child' } }] as never,
    })
    mount()
    fireEvent.click(screen.getByText('Terminal'))
    expect(focusOrOpenSession).toHaveBeenCalledWith(expect.objectContaining({ id: 's-child' }))
    expect(useCrewDockStore.getState().peekId).toBeNull()
  })

  it('promover a aba é ação explícita do rodapé', () => {
    const focusOrOpenSession = vi.fn()
    useAppStore.setState({ focusOrOpenSession })
    mount()
    fireEvent.click(screen.getByText('abrir como aba'))
    expect(focusOrOpenSession).toHaveBeenCalledWith(expect.objectContaining({ id: 's-child' }))
    expect(useCrewDockStore.getState().peekId).toBeNull()
  })
})
