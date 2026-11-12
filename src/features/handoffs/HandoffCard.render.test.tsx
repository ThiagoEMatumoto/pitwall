import { fireEvent, render, screen, waitFor } from '@testing-library/react'
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
    setOutcome: vi.fn().mockResolvedValue(undefined),
    dismiss: vi.fn().mockResolvedValue(undefined),
    detachChild: vi.fn().mockResolvedValue(undefined),
    release: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockResolvedValue([]),
  },
  prefsApi: { get: vi.fn().mockResolvedValue(null) },
}))

import { HandoffCard } from './HandoffCard'
import { useAppStore, type ActivePane } from '@/store/appStore'
import { handoffsApi } from '@/lib/ipc'
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
function mountDock(patch: Partial<Handoff> = {}, liveStatus: LiveSessionInfo['status'] = 'working') {
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
