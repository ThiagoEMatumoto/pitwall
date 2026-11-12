import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, it, expect, beforeEach, vi } from 'vitest'
import type { Handoff, LiveSessionInfo } from '../../../shared/types/ipc'

// Política de legibilidade do card no dock (340px): nenhum campo de origem
// externa renderiza sem teto, e a coluna de texto não divide a linha com as
// ações. O que estes testes travam é o que o uso real quebrou — a task inteira
// numa coluna de ~76px, virando cinquenta linhas de duas palavras.

vi.mock('@/lib/ipc', () => ({
  handoffsApi: {
    sendMessage: vi.fn().mockResolvedValue(undefined),
    isResumable: vi.fn().mockResolvedValue(false),
    fail: vi.fn().mockResolvedValue(undefined),
    resume: vi.fn().mockResolvedValue(undefined),
    wakeChild: vi.fn(),
    setOutcome: vi.fn().mockResolvedValue(undefined),
    dismiss: vi.fn().mockResolvedValue(undefined),
    detachChild: vi.fn().mockResolvedValue(undefined),
    release: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockResolvedValue([]),
    setChildEnded: vi.fn().mockResolvedValue(null),
  },
  prefsApi: { get: vi.fn().mockResolvedValue(null) },
  // O que o endSession real do appStore toca.
  sessionsApi: {
    kill: vi.fn().mockResolvedValue(undefined),
    clearSessionDrafts: vi.fn().mockResolvedValue(undefined),
    adoptDraft: vi.fn().mockResolvedValue(null),
  },
  workspaceApi: { savePanes: vi.fn().mockResolvedValue(undefined) },
}))

import { HandoffCard } from './HandoffCard'
import { useAppStore, type ActivePane } from '@/store/appStore'
import { useHandoffsStore } from '@/store/handoffsStore'
import { handoffsApi, sessionsApi } from '@/lib/ipc'
import { useToastStore } from '@/features/notifications/toast-store'
import { useSessionGraphStore } from '@/features/sessions/session-graph-store'
import type { SessionGraphNode } from '../../../shared/types/session-graph'

const LONG_TASK =
  'Melhorar o modo Chat em duas frentes que hoje forçam o usuário a sair para o Terminal. ' +
  'FRENTE 1 — Cancelar um comando pelo Chat. Hoje, para interromper algo em andamento, o ' +
  'usuário precisa ir ao Terminal e dar Ctrl+C. O Chat não tem esse controle.'

const handoff: Handoff = {
  id: 'h1',
  motherSessionId: 'm1',
  targetRepoId: 'r1',
  targetRepoLabel: 'claude-manager',
  childSessionId: 's-child',
  featureId: null,
  task: LONG_TASK,
  contextJson: null,
  composedPrompt: '',
  status: 'running',
  mode: 'interactive',
  currentStep: 'lendo ChatView.tsx',
  stepUpdatedAt: Date.now(),
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
  childAsleep: false,
}

const live: LiveSessionInfo = {
  id: 's-child',
  ccSessionId: 'cc-child',
  name: null,
  title: 'mauricio-melhorar-modo-chat',
  status: 'working',
  repo: null,
  projectName: null,
  projectIcon: null,
  projectColor: null,
  lastActivityAt: Date.now(),
  lastText: null,
}

// tier='mid' é o que o dock resolve na largura padrão de 340px (narrow só abaixo
// de 220, e o dock não desce de 240).
function mountDock(
  patch: Partial<Handoff> = {},
  liveStatus: LiveSessionInfo['status'] = 'working',
) {
  useAppStore.setState({ liveSessions: [{ ...live, status: liveStatus }] })
  return render(
    <HandoffCard handoff={{ ...handoff, ...patch }} ttlHours={2} tier="mid" onPeek={() => {}} />,
  )
}

describe('HandoffCard no dock (tier mid)', () => {
  beforeEach(() => {
    useAppStore.setState({ liveSessions: [] })
  })

  it('a task renderiza clampada em 2 linhas, com o integral no title', () => {
    mountDock()
    const task = screen.getByTestId('handoff-task')
    expect(task.className).toContain('line-clamp-2')
    expect(task.getAttribute('title')).toBe(LONG_TASK)
  })

  it('a pergunta aberta é clampada e nunca mais permissiva que o peek (max-h-32)', () => {
    const question = 'Posso trocar a lib de parsing? '.repeat(30)
    mountDock({ status: 'needs_input', pendingQuestion: question }, 'waiting')
    const box = screen.getByTestId('handoff-question')
    const text = box.querySelector('[title]')!
    expect(text.className).toContain('line-clamp-3')
    expect(text.className).toContain('max-h-24')
    expect(text.getAttribute('title')).toBe(question)
  })

  it('bloqueada: o pedido dela vem ANTES do briefing', () => {
    mountDock({ status: 'needs_input', pendingQuestion: 'posso apagar?' }, 'waiting')
    const question = screen.getByTestId('handoff-question')
    const task = screen.getByTestId('handoff-task')
    // compareDocumentPosition: FOLLOWING (4) = a task vem depois da pergunta.
    expect(question.compareDocumentPosition(task) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('as ações não dividem a linha do nome — descem pro rodapé do card', () => {
    const { container } = mountDock()
    const card = container.querySelector('[data-testid="handoff-card"]')!
    const peek = screen.getByTitle('Espiar a conversa desta filha (Espaço)')
    const name = screen.getByText('mauricio-melhorar-modo-chat')
    // A coluna de conteúdo é filha direta do card (não há coluna lateral), e o
    // cluster de ações é um irmão POSTERIOR dela.
    const contentColumn = name.closest('.min-w-0')!
    expect(contentColumn.parentElement).toBe(card)
    expect(contentColumn.contains(peek)).toBe(false)
    expect(
      contentColumn.compareDocumentPosition(peek) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
  })

  it('trabalhando: sem campo de resposta (o card é pra ler)', () => {
    mountDock()
    expect(screen.queryByPlaceholderText(/filha/i)).toBeNull()
  })

  it('esperando: o campo de resposta aparece inline, no caminho crítico', () => {
    mountDock({ status: 'needs_input', pendingQuestion: 'posso apagar?' }, 'waiting')
    expect(screen.getByPlaceholderText('Responder à pergunta da filha…')).toBeTruthy()
  })

  // Respondida por fora (mensagem peer): o needs_input segue no banco, mas a
  // filha voltou a reportar passo. O card mostra o AGORA dela, sem âmbar.
  it('pergunta já respondida fora do app: o card volta a mostrar o passo corrente', () => {
    const { container } = mountDock(
      {
        status: 'needs_input',
        pendingQuestion: 'posso apagar?',
        questionAskedAt: 1000,
        stepUpdatedAt: 2000,
        currentStep: 'seguindo para a Frente 2',
      },
      'working',
    )
    expect(screen.queryByTestId('handoff-question')).toBeNull()
    expect(screen.getByText('seguindo para a Frente 2')).toBeTruthy()
    expect(screen.getByText('trabalhando')).toBeTruthy()
    const card = container.querySelector<HTMLElement>('[data-testid="handoff-card"]')!
    expect(card.style.borderColor).not.toContain('warning')
  })
})

// "Dispensar" com a filha viva tirava o card e deixava a sessão rodando como
// sessão comum: prometia arquivar e soltava. Agora o card só é arquivado com o
// processo morto; com ele vivo o que tira da frente é Minimizar ou Encerrar.
describe('HandoffCard: "Arquivar card" só com o processo morto', () => {
  beforeEach(() => {
    useAppStore.setState({ liveSessions: [] })
    useToastStore.setState({ toasts: [] })
    vi.mocked(handoffsApi.dismiss).mockClear()
  })

  it('filha viva: nem o "×" nem o item do menu, e nada se chama Dispensar', () => {
    mountDock({ status: 'needs_input', pendingQuestion: 'posso apagar?' }, 'waiting')
    expect(screen.queryByLabelText('Arquivar card')).toBeNull()
    fireEvent.click(screen.getByLabelText('Mais ações'))
    expect(screen.queryByText('Arquivar card')).toBeNull()
    expect(screen.queryByText(/Dispensar/)).toBeNull()
    // O menu não fica num beco: Encerrar é o que tira a filha viva da frente.
    expect(screen.getByText('Encerrar filha')).toBeTruthy()
  })

  it('processo morto: "×" e menu arquivam pelo mesmo handoffs:dismiss de antes', async () => {
    render(<HandoffCard handoff={handoff} ttlHours={2} tier="mid" onPeek={() => {}} />)
    fireEvent.click(screen.getByLabelText('Mais ações'))
    expect(screen.getByText('Arquivar card')).toBeTruthy()
    fireEvent.click(screen.getByLabelText('Arquivar card'))
    await waitFor(() => expect(handoffsApi.dismiss).toHaveBeenCalledWith('h1'))
    await waitFor(() =>
      expect(useToastStore.getState().toasts.map((t) => t.title)).toEqual(['Card arquivado']),
    )
  })

  it("'ended' ainda na lista viva conta como processo morto", () => {
    mountDock({}, 'ended')
    expect(screen.getByLabelText('Arquivar card')).toBeTruthy()
  })

  it("'ended' ainda na lista viva: o toast não diz que a filha continua rodando", async () => {
    useHandoffsStore.setState({ handoffs: [handoff] })
    mountDock({}, 'ended')
    fireEvent.click(screen.getByLabelText('Arquivar card'))
    await waitFor(() => expect(useToastStore.getState().toasts).toHaveLength(1))
    expect(useToastStore.getState().toasts[0].body).toBe('mauricio-melhorar-modo-chat')
  })

  // O "Dispensar" do Room não passa pelo gate do card: ali a filha pode estar viva.
  it('arquivado com a filha viva (fora do card): o toast avisa que ela continua rodando', async () => {
    useHandoffsStore.setState({ handoffs: [handoff] })
    useAppStore.setState({ liveSessions: [live] })
    await useHandoffsStore.getState().dismiss('h1')
    expect(useToastStore.getState().toasts[0].body).toBe(
      'mauricio-melhorar-modo-chat continua rodando — só o card saiu do painel.',
    )
  })

  it('já arquivado: nada de arquivar de novo', () => {
    render(
      <HandoffCard
        handoff={{ ...handoff, dismissedAt: Date.now() }}
        ttlHours={2}
        tier="mid"
        onPeek={() => {}}
      />,
    )
    expect(screen.queryByLabelText('Arquivar card')).toBeNull()
  })
})

// O endSession tira a filha da lista viva na hora, mas a PTY só morre quando a
// janela do Desfazer expira. Arquivar ali e desfazer deixava a filha viva sem
// card. Aqui o Encerrar é o do appStore, não um mock.
describe('HandoffCard: Encerrar com o Desfazer em aberto não libera o Arquivar', () => {
  // END_UNDO_MS + END_KILL_GRACE_MS do appStore.
  const END_WINDOW_MS = 5750

  beforeEach(() => {
    vi.useFakeTimers()
    useAppStore.setState({ liveSessions: [], panes: [] })
    useToastStore.setState({ toasts: [] })
    vi.mocked(sessionsApi.kill).mockClear()
  })
  afterEach(() => {
    vi.runAllTimers()
    vi.useRealTimers()
    useAppStore.setState({ liveSessions: [], panes: [] })
    useToastStore.setState({ toasts: [] })
  })

  function endChildFromMenu() {
    mountDock({}, 'idle')
    fireEvent.click(screen.getByLabelText('Mais ações'))
    fireEvent.click(screen.getByText('Encerrar filha'))
    expect(useAppStore.getState().liveSessions).toEqual([])
  }

  it('na janela do Desfazer a PTY segue viva: nem o "×" nem o item do menu', () => {
    endChildFromMenu()
    expect(screen.queryByLabelText('Arquivar card')).toBeNull()
    fireEvent.click(screen.getByLabelText('Mais ações'))
    expect(screen.getByText('Desvincular')).toBeTruthy()
    expect(screen.queryByText('Arquivar card')).toBeNull()
  })

  it('Desfazer devolve a filha viva, e o card segue sem Arquivar', () => {
    endChildFromMenu()
    act(() => useToastStore.getState().toasts[0].onAction?.())
    expect(useAppStore.getState().liveSessions.map((s) => s.id)).toEqual(['s-child'])
    expect(screen.queryByLabelText('Arquivar card')).toBeNull()
  })

  it('janela expirada: o processo foi morto e o "×" aparece', () => {
    endChildFromMenu()
    act(() => {
      vi.advanceTimersByTime(END_WINDOW_MS)
    })
    expect(sessionsApi.kill).toHaveBeenCalledWith('s-child')
    // O que o refreshLiveSessions do timer faz com o watch ligado: lista nova.
    act(() => useAppStore.setState({ liveSessions: [] }))
    expect(screen.getByLabelText('Arquivar card')).toBeTruthy()
  })

  // O "Dispensar" do Room não passa pelo gate do card, e ali a filha já saiu da
  // lista viva: sem aviso, o Desfazer do Encerrar a devolvia viva a um card
  // arquivado sem que nada tivesse dito que ela ainda rodava.
  function archivedToastBody() {
    return useToastStore.getState().toasts.find((t) => t.title === 'Card arquivado')?.body
  }

  it('arquivado pelo Room na janela do Desfazer: o toast avisa que o encerramento está pendente', async () => {
    useHandoffsStore.setState({ handoffs: [handoff] })
    endChildFromMenu()
    await act(() => useHandoffsStore.getState().dismiss('h1'))
    expect(archivedToastBody()).toBe(
      'claude-manager: encerramento pendente — se desfizer, ela segue rodando sem o card.',
    )
  })

  it('arquivado depois da janela: o processo morreu e o toast traz só o nome', async () => {
    useHandoffsStore.setState({ handoffs: [handoff] })
    endChildFromMenu()
    act(() => {
      vi.advanceTimersByTime(END_WINDOW_MS)
    })
    await act(() => useHandoffsStore.getState().dismiss('h1'))
    expect(archivedToastBody()).toBe('claude-manager')
  })
})

// Reabrir a filha levava três cliques e passava pela modal do quick look. A aba é
// onde se trabalha nela: o card leva direto.
describe('HandoffCard: "Abrir na aba" é a ação primária', () => {
  const realFocusOrOpenSession = useAppStore.getState().focusOrOpenSession
  const focusOrOpenSession = vi.fn().mockResolvedValue(undefined)

  beforeEach(() => {
    focusOrOpenSession.mockClear()
    useAppStore.setState({ liveSessions: [live], focusOrOpenSession })
  })
  afterEach(() => {
    useAppStore.setState({ liveSessions: [], focusOrOpenSession: realFocusOrOpenSession })
  })

  it('abre a aba da filha direto, sem passar pelo quick look', () => {
    const onPeek = vi.fn()
    render(<HandoffCard handoff={handoff} ttlHours={2} tier="mid" onPeek={onPeek} />)
    fireEvent.click(screen.getByRole('button', { name: 'Abrir na aba' }))
    expect(focusOrOpenSession).toHaveBeenCalledWith(live)
    expect(onPeek).not.toHaveBeenCalled()
  })

  it('vem antes do Espiar no cluster de ações', () => {
    render(<HandoffCard handoff={handoff} ttlHours={2} tier="mid" onPeek={() => {}} />)
    const open = screen.getByRole('button', { name: 'Abrir na aba' })
    const peek = screen.getByTitle('Espiar a conversa desta filha (Espaço)')
    expect(open.compareDocumentPosition(peek) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('no dock apertado (só ícone) o botão segue com nome', () => {
    render(<HandoffCard handoff={handoff} ttlHours={2} tier="narrow" onPeek={() => {}} />)
    expect(screen.getByRole('button', { name: 'Abrir na aba' }).textContent).toBe('')
  })

  it('sem processo vivo não há aba a abrir', () => {
    useAppStore.setState({ liveSessions: [] })
    render(<HandoffCard handoff={handoff} ttlHours={2} tier="mid" onPeek={() => {}} />)
    expect(screen.queryByRole('button', { name: 'Abrir na aba' })).toBeNull()
  })
})

// Os verbos da filha são os mesmos da barra e do X da aba, com o mesmo efeito:
// Minimizar tira da tela, Encerrar mata o processo (e não desvincula).
describe('HandoffCard: Minimizar e Encerrar no menu da filha viva', () => {
  const real = {
    endSession: useAppStore.getState().endSession,
    closePane: useAppStore.getState().closePane,
  }
  const endSession = vi.fn()
  const closePane = vi.fn()
  const childPane = {
    paneId: 'pane-child',
    session: { id: 's-child', ccSessionId: 'cc-child', title: null },
  } as unknown as ActivePane

  function openMenu(liveStatus: LiveSessionInfo['status'] = 'working') {
    mountDock({}, liveStatus)
    fireEvent.click(screen.getByLabelText('Mais ações'))
  }

  beforeEach(() => {
    endSession.mockClear()
    closePane.mockClear()
    useAppStore.setState({ liveSessions: [], panes: [], endSession, closePane })
    // "É filha" sai do grafo: hierarchyMotherId, escrito no main por
    // session-graph.ts a partir de readHierarchyLinks.
    useSessionGraphStore.setState({
      graph: {
        nodes: [
          { sessionId: 's-child', hierarchyMotherId: 'm1' },
          { sessionId: 'm1', hierarchyMotherId: null },
        ] as unknown as SessionGraphNode[],
        lanes: [],
        edges: [],
      },
    })
  })
  afterEach(() => {
    vi.restoreAllMocks()
    useAppStore.setState({ liveSessions: [], panes: [], ...real })
    useSessionGraphStore.setState({ graph: { nodes: [], lanes: [], edges: [] } })
  })

  it('Encerrar com a filha trabalhando pede confirmação; negada, nada é encerrado', () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    openMenu('working')
    fireEvent.click(screen.getByText('Encerrar filha'))
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(endSession).not.toHaveBeenCalled()
  })

  it('confirmada, encerra pelo caminho da barra: mata o processo e mantém o vínculo', () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    openMenu('working')
    fireEvent.click(screen.getByText('Encerrar filha'))
    expect(endSession).toHaveBeenCalledWith('s-child', { linkedChild: true })
  })

  it('filha parada encerra direto (o Desfazer do toast cobre o clique errado)', () => {
    const confirm = vi.spyOn(window, 'confirm')
    openMenu('idle')
    fireEvent.click(screen.getByText('Encerrar filha'))
    expect(confirm).not.toHaveBeenCalled()
    expect(endSession).toHaveBeenCalledWith('s-child', { linkedChild: true })
  })

  it('Minimizar fecha só a aba dela', () => {
    useAppStore.setState({ panes: [childPane] })
    openMenu()
    fireEvent.click(screen.getByText('Minimizar'))
    expect(closePane).toHaveBeenCalledWith('pane-child')
    expect(endSession).not.toHaveBeenCalled()
  })

  it('sem aba aberta não há o que minimizar', () => {
    openMenu()
    expect(screen.queryByText('Minimizar')).toBeNull()
  })

  it('sem processo o menu não oferece Encerrar nem Minimizar', () => {
    useAppStore.setState({ panes: [childPane] })
    render(<HandoffCard handoff={handoff} ttlHours={2} tier="mid" onPeek={() => {}} />)
    fireEvent.click(screen.getByLabelText('Mais ações'))
    expect(screen.queryByText('Encerrar filha')).toBeNull()
    expect(screen.queryByText('Minimizar')).toBeNull()
  })
})

describe('HandoffCard: Desvincular e Forçar falha', () => {
  beforeEach(() => {
    useAppStore.setState({ liveSessions: [] })
    vi.mocked(handoffsApi.detachChild).mockClear()
    vi.mocked(handoffsApi.release).mockClear()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('o menu chama de Desvincular, não mais de Soltar', () => {
    mountDock()
    fireEvent.click(screen.getByLabelText('Mais ações'))
    expect(screen.getByText('Desvincular')).toBeTruthy()
    expect(screen.queryByText(/Soltar/)).toBeNull()
  })

  // O Desvincular do diálogo de vínculo (ChildLinkDialog) solta TODOS os handoffs
  // da conversa (detachChild). O do card soltava só o próprio: com outro handoff
  // apontando pra mesma conversa ela seguia filha depois de "desvinculada".
  it('é o mesmo Desvincular do diálogo de vínculo: solta a conversa, não só este handoff', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    mountDock()
    fireEvent.click(screen.getByLabelText('Mais ações'))
    fireEvent.click(screen.getByText('Desvincular'))
    expect(confirm).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(handoffsApi.detachChild).toHaveBeenCalledWith('s-child'))
    expect(handoffsApi.release).not.toHaveBeenCalled()
  })

  it('sem confirmação nada é desvinculado', () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    mountDock()
    fireEvent.click(screen.getByLabelText('Mais ações'))
    fireEvent.click(screen.getByText('Desvincular'))
    expect(handoffsApi.detachChild).not.toHaveBeenCalled()
  })

  it('filha viva: sem "Forçar falha" (o verbo é Encerrar)', () => {
    mountDock()
    fireEvent.click(screen.getByLabelText('Mais ações'))
    expect(screen.queryByText('Forçar falha')).toBeNull()
  })

  it('running sem processo: também sem "Forçar falha" (Arquivar cobre a limpeza)', () => {
    render(<HandoffCard handoff={handoff} ttlHours={2} tier="mid" onPeek={() => {}} />)
    fireEvent.click(screen.getByLabelText('Mais ações'))
    expect(screen.queryByText('Forçar falha')).toBeNull()
    expect(screen.getByText('Arquivar card')).toBeTruthy()
  })

  it('aprovado que nunca subiu: "Forçar falha" continua lá', () => {
    render(
      <HandoffCard
        handoff={{ ...handoff, status: 'approved', childSessionId: null }}
        ttlHours={2}
        tier="mid"
      />,
    )
    fireEvent.click(screen.getByLabelText('Mais ações'))
    expect(screen.getByText('Forçar falha')).toBeTruthy()
  })
})

describe('HandoffCard no inbox (tier wide)', () => {
  it('mantém a coluna lateral com data e ações — lá há largura de sobra', () => {
    useAppStore.setState({ liveSessions: [live] })
    render(<HandoffCard handoff={handoff} ttlHours={2} />)
    const name = screen.getByText('mauricio-melhorar-modo-chat')
    const terminal = screen.getByRole('button', { name: 'Abrir na aba' })
    const row = name.closest('.min-w-0')!.parentElement!
    expect(row.className).toContain('justify-between')
    expect(row.contains(terminal)).toBe(true)
    // E o campo de envio continua sempre disponível na largura do inbox.
    expect(screen.getByPlaceholderText('Enviar mensagem para a filha…')).toBeTruthy()
  })
})

// Decisão do usuário: a mensagem que ele manda a uma filha fora da tela abre a aba
// dela antes do envio. O card do inbox desmonta ao trocar de área: a aba nasce em
// segundo plano e ele só é levado até ela com o envio aceito.
describe('HandoffCard: a mensagem do usuário abre a aba da filha', () => {
  const realFocusOrOpenSession = useAppStore.getState().focusOrOpenSession
  const focusOrOpenSession = vi.fn().mockResolvedValue(undefined)
  const sendMessage = vi.mocked(handoffsApi.sendMessage)

  function send(text: string) {
    render(<HandoffCard handoff={handoff} ttlHours={2} />)
    fireEvent.change(screen.getByPlaceholderText('Enviar mensagem para a filha…'), {
      target: { value: text },
    })
    fireEvent.click(screen.getByTitle('Enviar (Enter)'))
  }

  beforeEach(() => {
    focusOrOpenSession.mockClear()
    sendMessage.mockClear()
    useAppStore.setState({ liveSessions: [live], panes: [], focusOrOpenSession })
    // "É filha" sai do grafo: hierarchyMotherId, escrito no main por
    // session-graph.ts a partir de readHierarchyLinks.
    useSessionGraphStore.setState({
      graph: {
        nodes: [
          { sessionId: 's-child', hierarchyMotherId: 'm1' },
          { sessionId: 'm1', hierarchyMotherId: null },
        ] as unknown as SessionGraphNode[],
        lanes: [],
        edges: [],
      },
    })
  })
  afterEach(() => {
    useAppStore.setState({
      liveSessions: [],
      panes: [],
      area: 'overview',
      focusPaneId: null,
      focusOrOpenSession: realFocusOrOpenSession,
    })
    useSessionGraphStore.setState({ graph: { nodes: [], lanes: [], edges: [] } })
  })

  it('filha sem aba: a aba nasce em segundo plano, o envio sai e só então leva até ela', async () => {
    send('segue por aqui')

    await waitFor(() => expect(focusOrOpenSession).toHaveBeenCalledTimes(2))
    expect(sendMessage).toHaveBeenCalledWith({ id: 'h1', text: 'segue por aqui' })
    expect(focusOrOpenSession.mock.calls).toEqual([[live, { background: true }], [live]])
    const [opened, taken] = focusOrOpenSession.mock.invocationCallOrder
    const sent = sendMessage.mock.invocationCallOrder[0]
    expect(opened).toBeLessThan(sent)
    expect(sent).toBeLessThan(taken)
  })

  // O inbox só existe na área handoffs: sair dela antes da resposta do envio
  // desmontaria o card com o texto digitado e o motivo da recusa.
  it('envio recusado: o usuário fica onde está, com o texto e o motivo no card', async () => {
    useAppStore.setState({ area: 'handoffs', focusOrOpenSession: realFocusOrOpenSession })
    // Como a recusa chega do ipcRenderer.invoke: o prefixo do canal e a classe do
    // erro do main (ChildWriteRefusedError de menu aberto, do guarded-inject).
    const reason =
      'Não deu para entregar: há um menu aberto na tela da filha (permissão/pergunta): o Enter da mensagem o responderia. Responda o menu no terminal dela primeiro.'
    sendMessage.mockRejectedValueOnce(
      new Error(
        `Error invoking remote method 'handoffs:send-message': ChildWriteRefusedError: ${reason}`,
      ),
    )

    send('segue por aqui')

    expect(await screen.findByText(reason)).toBeTruthy()
    expect(useAppStore.getState().area).toBe('handoffs')
    expect(useAppStore.getState().focusPaneId).toBeNull()
    expect(useAppStore.getState().panes.map((p) => p.session.id)).toEqual(['s-child'])
    expect(
      (screen.getByPlaceholderText('Enviar mensagem para a filha…') as HTMLTextAreaElement).value,
    ).toBe('segue por aqui')
  })

  it('filha que já tem aba: só envia', async () => {
    useAppStore.setState({
      panes: [
        { paneId: 'pane-child', session: { id: 's-child', ccSessionId: 'cc-child', title: null } },
      ] as unknown as ActivePane[],
    })
    send('segue por aqui')

    await waitFor(() => expect(sendMessage).toHaveBeenCalled())
    expect(focusOrOpenSession).not.toHaveBeenCalled()
  })
})

// Dormindo = handoff done cuja sessão hibernou (childAsleep, derivado pelo
// handoff-store). Sem processo: o card é o único lugar de onde o usuário a acorda.
describe('HandoffCard: filha concluída dormindo', () => {
  const asleep: Partial<Handoff> = {
    status: 'done',
    childAsleep: true,
    currentStep: null,
    summary: 'entregue',
  }
  const woken: LiveSessionInfo = { ...live, id: 's-woken', status: 'idle' }
  const wakeChild = vi.mocked(handoffsApi.wakeChild)

  function mountAsleep(patch: Partial<Handoff> = {}) {
    return render(
      <HandoffCard
        handoff={{ ...handoff, ...asleep, ...patch }}
        ttlHours={2}
        tier="mid"
        onPeek={() => {}}
      />,
    )
  }

  beforeEach(() => {
    wakeChild.mockReset()
    vi.mocked(handoffsApi.resume).mockClear()
    useAppStore.setState({ liveSessions: [], panes: [], area: 'overview', focusPaneId: null })
  })
  afterEach(() => {
    useAppStore.setState({ liveSessions: [], panes: [], area: 'overview', focusPaneId: null })
  })

  it('diz "Dormindo" e oferece Acordar; não há processo para abrir nem para encerrar', () => {
    mountAsleep()
    expect(screen.getByText('Dormindo')).toBeTruthy()
    expect(screen.queryByText('Concluído')).toBeNull()
    expect(screen.getByRole('button', { name: 'Acordar' })).toBeTruthy()
    expect(screen.queryByLabelText('Abrir na aba')).toBeNull()
    expect(screen.queryByPlaceholderText(/filha/i)).toBeNull()
  })

  it('Acordar chama handoffs.wakeChild (sem kickoff) e abre a aba da sessão acordada', async () => {
    wakeChild.mockImplementation(async () => {
      // A lista viva que o refresh traria: a linha nova do relance.
      useAppStore.setState({ liveSessions: [woken] })
      return {
        handoff: { ...handoff, ...asleep, childAsleep: false, childSessionId: woken.id },
        sessionId: woken.id,
      }
    })
    mountAsleep()

    fireEvent.click(screen.getByRole('button', { name: 'Acordar' }))

    await waitFor(() =>
      expect(useAppStore.getState().panes.map((p) => p.session.id)).toEqual([woken.id]),
    )
    expect(wakeChild).toHaveBeenCalledWith('h1')
    expect(handoffsApi.resume).not.toHaveBeenCalled()
    expect(useAppStore.getState().area).toBe('projects')
  })

  it('não acordou: o motivo fica no card e dá pra tentar de novo', async () => {
    wakeChild.mockRejectedValueOnce(
      new Error(
        "Error invoking remote method 'handoffs:wake-child': Error: O transcript da sessão-filha não foi encontrado — não é possível retomá-la.",
      ),
    )
    mountAsleep()

    fireEvent.click(screen.getByRole('button', { name: 'Acordar' }))

    expect(
      await screen.findByText(
        'O transcript da sessão-filha não foi encontrado — não é possível retomá-la.',
      ),
    ).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Acordar' }) as HTMLButtonElement).disabled).toBe(
      false,
    )
    expect(useAppStore.getState().panes).toEqual([])
  })

  it('dormindo dá pra arquivar o card e desvincular; o vínculo não some sozinho', async () => {
    mountAsleep()
    expect(screen.getByLabelText('Arquivar card')).toBeTruthy()
    fireEvent.click(screen.getByLabelText('Mais ações'))
    expect(await screen.findByText('Desvincular')).toBeTruthy()
    expect(screen.queryByText('Encerrar filha')).toBeNull()
  })

  it('com o processo ainda vivo (o /exit não saiu) ela não está dormindo', () => {
    useAppStore.setState({ liveSessions: [live] })
    mountAsleep()
    expect(screen.queryByText('Dormindo')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Acordar' })).toBeNull()
    expect(screen.getByLabelText('Abrir na aba')).toBeTruthy()
  })

  it('concluída que não hibernou segue "Concluído", sem Acordar', () => {
    mountAsleep({ childAsleep: false })
    expect(screen.getByText('Concluído')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Acordar' })).toBeNull()
  })
})

describe('HandoffCard: filha encerrada pelo usuário', () => {
  beforeEach(() => {
    useAppStore.setState({ liveSessions: [] })
  })

  it('pausada porque o usuário encerrou: o selo diz quem encerrou e o Retomar fica', () => {
    render(
      <HandoffCard
        handoff={{ ...handoff, status: 'interrupted', resumable: true, endedByUserAt: 123 }}
        ttlHours={2}
        tier="mid"
      />,
    )
    expect(screen.getByText('Encerrada por você')).toBeTruthy()
    expect(screen.queryByText('Pausada')).toBeNull()
    expect(screen.getByRole('button', { name: /Retomar/ })).toBeTruthy()
  })

  it('pausada por outro motivo (app reiniciado, aba fechada) segue "Pausada"', () => {
    render(
      <HandoffCard
        handoff={{ ...handoff, status: 'interrupted', resumable: true }}
        ttlHours={2}
        tier="mid"
      />,
    )
    expect(screen.getByText('Pausada')).toBeTruthy()
  })
})
