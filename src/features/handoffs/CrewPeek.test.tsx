import { act, render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { Handoff, LiveSessionInfo } from '../../../shared/types/ipc'

// O peek renderiza o ChatView, que puxa transcript por IPC — aqui só interessa a
// moldura do overlay (camada, semântica de modal, teclado, selo).
const { chatViewProps } = vi.hoisted(() => ({ chatViewProps: [] as Record<string, unknown>[] }))
vi.mock('@/features/sessions/chat/ChatView', () => ({
  ChatView: (props: Record<string, unknown>) => {
    chatViewProps.push(props)
    return <div data-testid="chat-view" />
  },
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
const { sessionsApiMock } = vi.hoisted(() => ({
  sessionsApiMock: { attentionMenu: vi.fn(), attentionRespond: vi.fn() },
}))
vi.mock('@/lib/ipc', () => ({
  handoffsApi: { sendMessage: vi.fn().mockResolvedValue(undefined) },
  prefsApi: { get: vi.fn().mockResolvedValue(null) },
  sessionsApi: sessionsApiMock,
}))

import { CrewPeek } from './CrewPeek'
import { useCrewDockStore } from './crew-dock-store'
import { useAppStore } from '@/store/appStore'
import { useHandoffsStore } from '@/store/handoffsStore'
import { useAttentionListStore } from '@/store/attentionStore'
import { projectAttention } from '../../../shared/attention/project-attention'
import { useTerminalLease } from '@/features/sessions/terminal-lease'
import { useProjectsViewStore } from '@/features/session-canvas/projects-view-store'
import {
  defaultLiftSize,
  readLiftSizes,
  rememberLiftSize,
} from '@/features/sessions/lift-size-store'

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
  useCrewDockStore.setState({ peekTarget: { kind: 'handoff', id: 'h1' }, peekId: 'h1' })
  return render(<CrewPeek />)
}

// Menu do produtor real: a captura do claude 2.1.286 renderizada no xterm
// headless e parseada como o tui-menu-watch faz no main.
async function realPermissionMenu() {
  const { readFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const xtermHeadless = (await import('@xterm/headless')).default as unknown as {
    Terminal: typeof import('@xterm/headless').Terminal
  }
  const { scanScreen } = await import('../../../shared/tui/attention-reason')
  const raw = readFileSync(
    join(
      __dirname,
      '..',
      '..',
      '..',
      'shared',
      'tui',
      '__fixtures__',
      'claude-2.1.286-permission-bash.ansi',
    ),
    'utf8',
  )
  const term = new xtermHeadless.Terminal({ cols: 80, rows: 24, allowProposedApi: true })
  await new Promise<void>((resolve) => term.write(raw, resolve))
  return scanScreen((n) => {
    const buf = term.buffer.active
    let text = ''
    for (let y = Math.max(0, buf.length - n); y < buf.length; y++) {
      text += (buf.getLine(y)?.translateToString(true) ?? '') + '\n'
    }
    return text
  }, 1000).menu!
}

describe('CrewPeek — responder o menu da filha sem entrar nela', () => {
  beforeEach(() => {
    useCrewDockStore.setState({ peekTarget: null, peekId: null, peekMode: 'chat' })
    useAppStore.setState({ panes: [] })
    sessionsApiMock.attentionMenu.mockReset()
    sessionsApiMock.attentionRespond.mockReset()
    chatViewProps.length = 0
    useAttentionListStore.setState({ items: [] })
  })

  it('no chat, pedido de permissão vira botões que respondem pelo main', async () => {
    const menu = await realPermissionMenu()
    sessionsApiMock.attentionMenu.mockResolvedValue({
      sessionId: 's-child',
      fingerprint: 'fp',
      menuSeq: 3,
      menu,
    })
    sessionsApiMock.attentionRespond.mockResolvedValue({ ok: true })
    useHandoffsStore.setState({ handoffs: [handoff] })
    useAppStore.setState({
      liveSessions: [{ ...live, status: 'waiting', attentionReason: 'permission' }],
    })
    useCrewDockStore.setState({ peekTarget: { kind: 'handoff', id: 'h1' }, peekId: 'h1' })
    render(<CrewPeek />)

    expect(sessionsApiMock.attentionMenu).toHaveBeenCalledWith('s-child')
    fireEvent.click(await screen.findByTestId('attention-action-approve'))
    await waitFor(() =>
      expect(sessionsApiMock.attentionRespond).toHaveBeenCalledWith({
        sessionId: 's-child',
        fingerprint: 'fp',
        menuSeq: 3,
        action: { kind: 'select', optionIndex: 0 },
      }),
    )
  })

  it('com o painel Aprovar/Negar, nada manda responder só no terminal', async () => {
    const menu = await realPermissionMenu()
    sessionsApiMock.attentionMenu.mockResolvedValue({
      sessionId: 's-child',
      fingerprint: 'fp',
      menuSeq: 3,
      menu,
    })
    useHandoffsStore.setState({ handoffs: [handoff] })
    useAppStore.setState({
      liveSessions: [{ ...live, status: 'waiting', attentionReason: 'permission' }],
    })
    useCrewDockStore.setState({ peekTarget: { kind: 'handoff', id: 'h1' }, peekId: 'h1' })
    render(<CrewPeek />)

    await screen.findByTestId('attention-action-approve')
    expect(screen.queryByTestId('crew-peek-terminal-only')).toBeNull()
    expect(chatViewProps.at(-1)?.menuAnsweredElsewhere).toBe(true)
  })

  it('esperando sem menu respondível, o aviso de terminal continua', () => {
    useHandoffsStore.setState({ handoffs: [handoff] })
    useAppStore.setState({ liveSessions: [{ ...live, status: 'waiting' }] })
    // "Esperando" chega pela fila única: a projeção do main sobre a filha em waiting.
    useAttentionListStore.setState({
      items: projectAttention({
        handoffs: [handoff],
        transitions: new Map(),
        requests: [],
        dismissals: new Map(),
        live: [
          {
            sessionId: 's-child',
            status: 'waiting',
            screenReason: undefined,
            menuSeq: null,
            lastActivityAt: null,
            featureId: null,
            repoId: null,
          },
        ],
      }),
    })
    useCrewDockStore.setState({ peekTarget: { kind: 'handoff', id: 'h1' }, peekId: 'h1' })
    render(<CrewPeek />)

    expect(screen.queryByTestId('crew-peek-menu')).toBeNull()
    expect(screen.getByTestId('crew-peek-terminal-only')).toHaveTextContent('só no terminal')
    expect(chatViewProps.at(-1)?.menuAnsweredElsewhere).toBe(false)
  })

  it('sem menu na tela (fim de turno) não mostra o painel', () => {
    useHandoffsStore.setState({ handoffs: [handoff] })
    useAppStore.setState({
      liveSessions: [{ ...live, status: 'waiting', attentionReason: 'turn-end' }],
    })
    useCrewDockStore.setState({ peekTarget: { kind: 'handoff', id: 'h1' }, peekId: 'h1' })
    render(<CrewPeek />)
    expect(screen.queryByTestId('crew-peek-menu')).toBeNull()
    expect(sessionsApiMock.attentionMenu).not.toHaveBeenCalled()
  })
})

describe('CrewPeek', () => {
  beforeEach(() => {
    useCrewDockStore.setState({ peekTarget: null, peekId: null, peekMode: 'chat' })
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
    expect(document.getElementById(labelledBy)).toHaveTextContent('mauricio-auth-refactor')
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
    expect(screen.getByText('Pergunta pendente')).toBeInTheDocument()
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
    expect(screen.queryByText('Pergunta pendente')).not.toBeInTheDocument()
    const box = screen.getByTestId('peek-question')
    expect(box).toHaveTextContent('BLOQUEIO: escopo da Frente 2?')
    expect(box).toHaveTextContent(/já retomou/)
    expect(box.style.borderColor).not.toContain('warning')
  })

  it('sem bloqueio, o selo mostra o estado ao vivo da filha', () => {
    mount({}, 'working')
    expect(screen.getByText('trabalhando')).toBeInTheDocument()
    expect(screen.queryByText('Pergunta pendente')).not.toBeInTheDocument()
  })
})

describe('CrewPeek em modo terminal', () => {
  beforeEach(() => {
    useCrewDockStore.setState({ peekTarget: null, peekId: null, peekMode: 'chat' })
    useAppStore.setState({ panes: [] })
    terminalProps.length = 0
  })

  function mountTerminal() {
    useHandoffsStore.setState({ handoffs: [handoff] })
    useAppStore.setState({ liveSessions: [live] })
    useCrewDockStore.setState({
      peekTarget: { kind: 'handoff', id: 'h1' },
      peekId: 'h1',
      peekMode: 'terminal',
    })
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

  // Pelo dock a aba pode estar visível ao lado: tomar a PTY a esvaziaria.
  it('pelo dock, com aba já aberta pra esta filha, o Terminal leva pra aba', () => {
    const focusOrOpenSession = vi.fn()
    useAppStore.setState({
      focusOrOpenSession,
      panes: [{ paneId: 'p1', session: { ccSessionId: 'cc-child' } }] as never,
    })
    mount()
    useCrewDockStore.setState({ peekOrigin: 'dock' })
    fireEvent.click(screen.getByText('Terminal'))
    expect(focusOrOpenSession).toHaveBeenCalledWith(expect.objectContaining({ id: 's-child' }))
    expect(useCrewDockStore.getState().peekId).toBeNull()
    expect(useTerminalLease.getState().leases['s-child']).toBeUndefined()
  })

  // Regressão: o provider sem Chat View força o modo terminal, e a lease era
  // tomada sem olhar a origem — a aba aberta da filha virava "Aberto no mapa"
  // fora do mapa. Pelo dock, com aba, o terminal dela mora na aba.
  it('pelo dock, filha Codex com aba aberta: não toma a PTY, leva pra aba', () => {
    const focusOrOpenSession = vi.fn()
    useTerminalLease.setState({ leases: {}, stacks: {} })
    useAppStore.setState({
      focusOrOpenSession,
      panes: [{ paneId: 'p1', session: { ccSessionId: 'cc-child' } }] as never,
    })
    useHandoffsStore.setState({ handoffs: [handoff] })
    useAppStore.setState({ liveSessions: [{ ...live, provider: 'codex' }] })
    act(() => useCrewDockStore.getState().openPeek('h1'))
    render(<CrewPeek />)
    expect(useTerminalLease.getState().leases['s-child']).toBeUndefined()
    expect(focusOrOpenSession).toHaveBeenCalledWith(expect.objectContaining({ id: 's-child' }))
    expect(useCrewDockStore.getState().peekTarget).toBeNull()
  })

  // Pelo mapa a modal assume a PTY (terminal-lease): a aba cede, não o contrário.
  it('pelo mapa, com aba já aberta, o Terminal abre aqui e não navega', () => {
    const focusOrOpenSession = vi.fn()
    useAppStore.setState({
      focusOrOpenSession,
      panes: [{ paneId: 'p1', session: { ccSessionId: 'cc-child' } }] as never,
    })
    mount()
    act(() => useCrewDockStore.setState({ peekOrigin: 'map' }))
    fireEvent.click(screen.getByText('Terminal'))
    expect(focusOrOpenSession).not.toHaveBeenCalled()
    expect(useCrewDockStore.getState().peekMode).toBe('terminal')
    expect(useTerminalLease.getState().leases['s-child']).toBe('modal')
    act(() => useCrewDockStore.setState({ peekOrigin: 'dock' }))
  })

  it('promover a aba é ação explícita do rodapé', () => {
    const focusOrOpenSession = vi.fn()
    useAppStore.setState({ focusOrOpenSession })
    mount()
    fireEvent.click(screen.getByText('abrir como aba'))
    expect(focusOrOpenSession).toHaveBeenCalledWith(expect.objectContaining({ id: 's-child' }))
    expect(useCrewDockStore.getState().peekId).toBeNull()
  })

  describe('foco ao fechar', () => {
    function focusedButton(): HTMLButtonElement {
      const el = document.createElement('button')
      document.body.appendChild(el)
      el.focus()
      return el
    }

    it('fechar devolve o foco a quem abriu o peek', () => {
      const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
        cb(0)
        return 0
      })
      const origin = focusedButton()
      mount()
      act(() => useCrewDockStore.getState().closePeek())
      expect(document.activeElement).toBe(origin)
      raf.mockRestore()
    })

    // Alt+A/Alt+Q pulam do peek pra uma aba: devolver o foco à origem reativaria o
    // grupo dela no dockview e desfaria o pulo.
    it('fechar sem restaurar deixa o foco com a sessão de destino', () => {
      const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
        cb(0)
        return 0
      })
      focusedButton()
      mount()
      const target = document.createElement('button')
      document.body.appendChild(target)
      act(() => {
        useCrewDockStore.getState().closePeek({ restoreFocus: false })
        target.focus()
      })
      expect(document.activeElement).toBe(target)
      raf.mockRestore()
    })
  })
})

// Peek de uma sessão comum (sem handoff): o mapa de sessões abre qualquer
// cartão aqui em vez de criar aba.
describe('CrewPeek com peekTarget de sessão', () => {
  const solo: LiveSessionInfo = {
    ...live,
    id: 's-solo',
    ccSessionId: 'cc-solo',
    title: 'checkout-gateway',
  }

  beforeEach(() => {
    useCrewDockStore.setState({ peekTarget: null, peekId: null, peekMode: 'chat' })
    useHandoffsStore.setState({ handoffs: [] })
    useAppStore.setState({ panes: [], liveSessions: [solo] })
    terminalProps.length = 0
  })

  it('openSessionPeek não mexe no peekId de handoff; openPeek espelha o id do handoff', () => {
    useCrewDockStore.getState().openSessionPeek('s-solo', 'terminal')
    expect(useCrewDockStore.getState()).toMatchObject({
      peekTarget: { kind: 'session', id: 's-solo' },
      peekId: null,
      peekMode: 'terminal',
    })
    useCrewDockStore.getState().openPeek('h1')
    expect(useCrewDockStore.getState()).toMatchObject({
      peekTarget: { kind: 'handoff', id: 'h1' },
      peekId: 'h1',
    })
    useCrewDockStore.getState().closePeek()
    expect(useCrewDockStore.getState()).toMatchObject({ peekTarget: null, peekId: null })
  })

  it('mostra a sessão sem handoff: título da sessão, conversa, sem briefing', () => {
    act(() => useCrewDockStore.getState().openSessionPeek('s-solo'))
    render(<CrewPeek />)
    const dialog = screen.getByRole('dialog')
    expect(document.getElementById(dialog.getAttribute('aria-labelledby')!)).toHaveTextContent(
      'checkout-gateway',
    )
    expect(screen.getByTestId('chat-view')).toBeInTheDocument()
    expect(screen.queryByText('ver briefing')).toBeNull()
  })

  it('sem handoff (não há campo de resposta), o foco entra no diálogo', async () => {
    act(() => useCrewDockStore.getState().openSessionPeek('s-solo'))
    render(<CrewPeek />)
    const dialog = screen.getByRole('dialog')
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true))
  })

  it('abre em modo terminal quando pedido (provider sem transcript)', () => {
    act(() => useCrewDockStore.getState().openSessionPeek('s-solo', 'terminal'))
    render(<CrewPeek />)
    expect(terminalProps.at(-1)).toMatchObject({ chrome: 'bare', mode: 'terminal' })
  })

  it('fecha sozinho quando a sessão termina', () => {
    act(() => useCrewDockStore.getState().openSessionPeek('s-solo'))
    render(<CrewPeek />)
    act(() => useAppStore.setState({ liveSessions: [] }))
    expect(useCrewDockStore.getState().peekTarget).toBeNull()
  })

  it('sessão com aba aberta também abre no peek (não leva pra aba)', () => {
    const focusOrOpenSession = vi.fn()
    useAppStore.setState({
      focusOrOpenSession,
      panes: [{ paneId: 'p1', session: { ccSessionId: 'cc-solo' } }] as never,
    })
    act(() => useCrewDockStore.getState().openSessionPeek('s-solo'))
    render(<CrewPeek />)
    expect(focusOrOpenSession).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })
})

describe('CrewPeek como lift do mapa', () => {
  const a: LiveSessionInfo = { ...live, id: 's-a', ccSessionId: 'cc-a', title: 'mae-web' }
  const b: LiveSessionInfo = { ...live, id: 's-b', ccSessionId: 'cc-b', title: 'filha-api' }

  beforeEach(() => {
    useCrewDockStore.setState({ peekTarget: null, peekId: null, peekMode: 'chat' })
    useHandoffsStore.setState({ handoffs: [] })
    useAppStore.setState({ panes: [], liveSessions: [a, b] })
    useTerminalLease.setState({ leases: {}, stacks: {} })
    useProjectsViewStore.setState({ view: 'map' })
    terminalProps.length = 0
  })

  function openLift(id = 's-a') {
    act(() =>
      useCrewDockStore
        .getState()
        .openSessionPeek(id, 'terminal', { origin: 'map', siblings: ['s-a', 's-b'] }),
    )
    return render(<CrewPeek />)
  }

  it('painel grande, xterm em 14px, assumindo a PTY enquanto aberto', () => {
    openLift()
    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveAttribute('data-peek-lift', 'true')
    // Sem tamanho salvo: o padrão de sempre (até 1400px, 94vw × 90vh), em px.
    const def = defaultLiftSize({ w: window.innerWidth, h: window.innerHeight })
    expect(dialog.style.width).toBe(`${def.w}px`)
    expect(dialog.style.height).toBe(`${def.h}px`)
    expect(terminalProps.at(-1)).toMatchObject({ leaseHost: 'modal', chrome: 'bare' })
    expect(terminalProps.at(-1)!.fontSize).toBeGreaterThanOrEqual(14)
    expect(useTerminalLease.getState().leases['s-a']).toBe('modal')
    act(() => useCrewDockStore.getState().closePeek())
    expect(useTerminalLease.getState().leases['s-a']).toBeUndefined()
  })

  it('no Chat, a alça da borda direita não cobre a barra de rolagem do chat', () => {
    openLift()
    act(() => useCrewDockStore.getState().setPeekMode('chat'))
    // ChatView rola em absolute inset-0 sem padding: a faixa 'e' (w-1.5, z-20)
    // ficava em cima de 6 dos 10px da barra de rolagem.
    expect(screen.getByTestId('chat-view').parentElement!.className).toContain('mx-1.5')
    expect(screen.getByTestId('peek-resize-e').className).toContain('w-1.5')
  })

  it('redimensionar: arrastar só mexe a moldura; soltar aplica e lembra por sessão', () => {
    localStorage.clear()
    const view = { w: window.innerWidth, h: window.innerHeight }
    const def = defaultLiftSize(view)
    const { unmount } = openLift()
    const dialog = screen.getByRole('dialog')
    const handle = screen.getByTestId('peek-resize-se')
    // jsdom não tem PointerEvent (o fireEvent cairia num Event sem clientX/button)
    // nem pointer capture.
    if (!('PointerEvent' in window)) {
      ;(window as unknown as { PointerEvent: typeof MouseEvent }).PointerEvent = class extends (
        MouseEvent
      ) {}
    }
    handle.setPointerCapture = () => {}
    fireEvent.pointerDown(handle, { button: 0, clientX: 500, clientY: 500, pointerId: 1 })
    fireEvent.pointerMove(handle, { clientX: 450, clientY: 470, pointerId: 1 })
    expect(screen.getByTestId('peek-resize-ghost').style.width).toBe(`${def.w - 100}px`)
    expect(dialog.style.width).toBe(`${def.w}px`)
    fireEvent.pointerUp(handle, { clientX: 450, clientY: 470, pointerId: 1 })
    expect(screen.queryByTestId('peek-resize-ghost')).toBeNull()
    expect(dialog.style.width).toBe(`${def.w - 100}px`)
    expect(dialog.style.height).toBe(`${def.h - 60}px`)
    expect(readLiftSizes()['s-a']).toEqual({ w: def.w - 100, h: def.h - 60 })
    unmount()
    act(() => useCrewDockStore.getState().closePeek())
    // Outra sessão abre no padrão; "Tamanho padrão" só aparece com tamanho salvo.
    openLift('s-b')
    expect(screen.getByRole('dialog').style.width).toBe(`${def.w}px`)
    expect(screen.queryByTestId('peek-size-reset')).toBeNull()
    act(() => useCrewDockStore.getState().closePeek())
  })

  it('"Tamanho padrão" esquece o tamanho da sessão', () => {
    localStorage.clear()
    rememberLiftSize('s-a', { w: 700, h: 400 })
    openLift()
    expect(screen.getByRole('dialog').style.width).toBe('700px')
    fireEvent.click(screen.getByTestId('peek-size-reset'))
    const def = defaultLiftSize({ w: window.innerWidth, h: window.innerHeight })
    expect(screen.getByRole('dialog').style.width).toBe(`${def.w}px`)
    expect(readLiftSizes()['s-a']).toBeUndefined()
    act(() => useCrewDockStore.getState().closePeek())
  })

  it('a faixa troca de sessão no mesmo modo, e Alt+. anda por ela com volta', () => {
    openLift()
    fireEvent.click(screen.getByText('filha-api'))
    expect(useCrewDockStore.getState()).toMatchObject({
      peekTarget: { kind: 'session', id: 's-b' },
      peekMode: 'terminal',
      peekOrigin: 'map',
    })
    // A lease da anterior só volta pra aba quando a modal fecha: devolver a cada
    // passo remontaria o xterm (replay, fit, WebGL) de uma aba que ninguém vê.
    expect(useTerminalLease.getState().leases).toEqual({ 's-a': 'modal', 's-b': 'modal' })
    fireEvent.keyDown(window, { key: '.', code: 'Period', altKey: true })
    expect(useCrewDockStore.getState().peekTarget).toEqual({ kind: 'session', id: 's-a' })
    act(() => useCrewDockStore.getState().closePeek())
    expect(useTerminalLease.getState().leases).toEqual({})
  })

  // Regressão: a faixa abria toda irmã como sessão avulsa, e a filha do dock
  // perdia a pergunta pendente e a resposta pelo canal do handoff.
  it('Alt+. até uma filha do dock em needs_input abre o peek do handoff, com a resposta', () => {
    useHandoffsStore.setState({
      handoffs: [
        {
          ...handoff,
          childSessionId: 's-b',
          status: 'needs_input',
          pendingQuestion: 'qual branch?',
        },
      ],
    })
    // "Responder" acende pela fila única: a mesma projeção sobre o mesmo estado.
    useAttentionListStore.setState({
      items: projectAttention({
        handoffs: useHandoffsStore.getState().handoffs,
        transitions: new Map(),
        requests: [],
        dismissals: new Map(),
        live: [],
      }),
    })
    act(() =>
      useCrewDockStore
        .getState()
        .openSessionPeek('s-a', 'chat', { origin: 'map', siblings: ['s-a', 's-b'] }),
    )
    render(<CrewPeek />)
    fireEvent.keyDown(window, { key: '.', code: 'Period', altKey: true })
    expect(useCrewDockStore.getState()).toMatchObject({
      peekTarget: { kind: 'handoff', id: 'h1' },
      peekOrigin: 'map',
    })
    expect(screen.getByText('qual branch?')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('Responder à filha…')).toBeInTheDocument()
    useAttentionListStore.setState({ items: [] })
  })

  it('trocar em terminal para a filha do dock mantém a PTY anterior na modal', () => {
    useHandoffsStore.setState({ handoffs: [{ ...handoff, childSessionId: 's-b' }] })
    openLift()
    fireEvent.click(screen.getByText('filha-api'))
    expect(useCrewDockStore.getState().peekTarget).toEqual({ kind: 'handoff', id: 'h1' })
    expect(useTerminalLease.getState().leases).toEqual({ 's-a': 'modal', 's-b': 'modal' })
  })

  it('voltar pra conversa no mesmo painel devolve a PTY', () => {
    openLift()
    expect(useTerminalLease.getState().leases).toEqual({ 's-a': 'modal' })
    act(() => useCrewDockStore.getState().setPeekMode('chat'))
    expect(useTerminalLease.getState().leases).toEqual({})
  })

  it('a entrada anima só na abertura: trocar pela faixa não pisca o painel', () => {
    openLift()
    expect(screen.getByRole('dialog').className).toContain('pw-rise')
    fireEvent.click(screen.getByText('filha-api'))
    expect(screen.getByRole('dialog').className).not.toContain('pw-rise')
    act(() => useCrewDockStore.getState().closePeek())
    act(() =>
      useCrewDockStore
        .getState()
        .openSessionPeek('s-b', 'terminal', { origin: 'map', siblings: ['s-a', 's-b'] }),
    )
    expect(screen.getByRole('dialog').className).toContain('pw-rise')
  })

  it('"Abrir na aba" é a única saída que navega: solta a PTY e troca a vista', () => {
    const focusOrOpenSession = vi.fn()
    useAppStore.setState({ focusOrOpenSession })
    openLift()
    fireEvent.click(screen.getByTestId('peek-open-tab'))
    expect(useTerminalLease.getState().leases).toEqual({})
    expect(useProjectsViewStore.getState().view).toBe('terminals')
    expect(focusOrOpenSession).toHaveBeenCalledWith(expect.objectContaining({ id: 's-a' }))
    expect(useCrewDockStore.getState().peekTarget).toBeNull()
  })

  it('fechar não muda a vista do mapa', () => {
    openLift()
    fireEvent.click(screen.getByLabelText('Fechar'))
    expect(useCrewDockStore.getState().peekTarget).toBeNull()
    expect(useProjectsViewStore.getState().view).toBe('map')
  })
})
