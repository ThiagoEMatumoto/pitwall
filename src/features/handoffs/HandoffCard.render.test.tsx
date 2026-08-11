import { render, screen } from '@testing-library/react'
import { describe, it, expect, beforeEach, vi } from 'vitest'
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
  },
  prefsApi: { get: vi.fn().mockResolvedValue(null) },
}))

import { HandoffCard } from './HandoffCard'
import { useAppStore } from '@/store/appStore'

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
    const name = screen.getByText('Maurício')
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

describe('HandoffCard no inbox (tier wide)', () => {
  it('mantém a coluna lateral com data e ações — lá há largura de sobra', () => {
    useAppStore.setState({ liveSessions: [live] })
    render(<HandoffCard handoff={handoff} ttlHours={2} />)
    const name = screen.getByText('Maurício')
    const terminal = screen.getByTitle('Anexar o terminal desta sessão-filha')
    const row = name.closest('.min-w-0')!.parentElement!
    expect(row.className).toContain('justify-between')
    expect(row.contains(terminal)).toBe(true)
    // E o campo de envio continua sempre disponível na largura do inbox.
    expect(screen.getByPlaceholderText('Enviar mensagem para a filha…')).toBeTruthy()
  })
})
