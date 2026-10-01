import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { Handoff } from '../../../shared/types/ipc'
import type { SessionGraph, SessionGraphNode } from '../../../shared/types/session-graph'

vi.mock('@/lib/ipc', () => ({
  sessionGraphApi: {
    get: vi.fn(() => new Promise(() => {})),
    onUpdated: vi.fn(() => () => {}),
  },
  handoffsApi: {},
}))

const { ConnectedChips } = await import('./ConnectedChips')
const { useSessionGraphStore } = await import('./session-graph-store')
const { useCrewDockStore } = await import('@/features/handoffs/crew-dock-store')
const { useHandoffsStore } = await import('@/store/handoffsStore')

function node(sessionId: string, over: Partial<SessionGraphNode> = {}): SessionGraphNode {
  return {
    sessionId,
    ccSessionId: `cc-${sessionId}`,
    title: sessionId,
    projectId: 'p1',
    repoId: 'r-web',
    repoLabel: 'web',
    provider: 'claude',
    status: 'working',
    attentionReason: null,
    lastActivityAt: null,
    purposeHint: null,
    childOfHandoffId: null,
    ...over,
  }
}

const graph: SessionGraph = {
  nodes: [
    node('orquestra'),
    node('mauricio', { purposeHint: 'Refatorar auth', childOfHandoffId: 'h1' }),
    node('antiga', { repoId: 'r-api', repoLabel: 'api-core' }),
  ],
  lanes: [],
  edges: [
    {
      kind: 'handoff',
      from: 'orquestra',
      to: 'mauricio',
      handoffId: 'h1',
      handoffStatus: 'running',
      currentStep: 'lendo o middleware',
      createdAt: 1,
    },
    { kind: 'baton', from: 'antiga', to: 'mauricio', handoffId: 'h1' },
  ],
}

beforeEach(() => {
  useSessionGraphStore.setState({ graph })
  useHandoffsStore.setState({
    handoffs: [{ id: 'h1', status: 'running', dismissedAt: null } as Handoff],
  })
})

afterEach(() => {
  cleanup()
  useCrewDockStore.getState().closePeek()
})

describe('ConnectedChips', () => {
  it('na mãe: um chip com a filha, e o tooltip diz do que ela trata', () => {
    render(<ConnectedChips sessionId="orquestra" />)
    const chip = screen.getByTestId('chip-children')
    expect(chip.textContent).toBe('↓ mauricio')
    expect(chip.getAttribute('title')).toContain('Refatorar auth')
    expect(chip.getAttribute('title')).toContain('lendo o middleware')
  })

  it('clicar na filha da crew abre o quick look, não uma aba', () => {
    render(<ConnectedChips sessionId="orquestra" />)
    fireEvent.click(screen.getByTestId('chip-children'))
    expect(useCrewDockStore.getState().peekId).toBe('h1')
  })

  it('na filha: mãe e bastão, com a tarefa dela no tooltip da mãe', () => {
    render(<ConnectedChips sessionId="mauricio" />)
    const mother = screen.getByTestId('chip-mother')
    expect(mother.textContent).toBe('↑ mãe: orquestra')
    expect(mother.getAttribute('title')).toContain('Tarefa desta sessão: Refatorar auth')
    expect(screen.getByTestId('chip-baton-in').textContent).toBe('⟲ bastão de antiga')
  })

  it('mãe encerrada: chip desabilitado, o clique não fecha o peek aberto', () => {
    useSessionGraphStore.setState({
      graph: {
        ...graph,
        nodes: graph.nodes.map((n) =>
          n.sessionId === 'orquestra' ? { ...n, status: 'ended' as const } : n,
        ),
      },
    })
    useCrewDockStore.getState().openPeek('h1')
    render(<ConnectedChips sessionId="mauricio" />)
    const mother = screen.getByTestId('chip-mother')
    expect(mother).toHaveAttribute('aria-disabled', 'true')
    expect(mother.getAttribute('title')).toContain('Sessão encerrada')
    fireEvent.click(mother)
    expect(useCrewDockStore.getState().peekId).toBe('h1')
  })

  it('filhas: o chip conta só as vivas; encerradas vão num "+N encerradas" à parte', () => {
    const kids = ['viva-a', 'viva-b', 'morta-a', 'morta-b', 'morta-c']
    useSessionGraphStore.setState({
      graph: {
        nodes: [
          node('orquestra'),
          ...kids.map((k) =>
            node(k, {
              status: k.startsWith('morta') ? 'ended' : 'working',
              childOfHandoffId: `h-${k}`,
            }),
          ),
        ],
        lanes: [],
        edges: kids.map((k, i) => ({
          kind: 'handoff' as const,
          from: 'orquestra',
          to: k,
          handoffId: `h-${k}`,
          handoffStatus: k.startsWith('morta') ? ('done' as const) : ('running' as const),
          currentStep: null,
          createdAt: i,
        })),
      },
    })
    render(<ConnectedChips sessionId="orquestra" />)
    expect(screen.getByTestId('chip-children').textContent).toBe('↓ 2 filhas')
    expect(screen.getByTestId('chip-children-ended').textContent).toBe('+3 encerradas')
  })

  it('bastão: o prefixo fica fora do trecho truncável, quem encolhe é o apelido', () => {
    render(<ConnectedChips sessionId="mauricio" />)
    const chip = screen.getByTestId('chip-baton-in')
    const truncated = chip.querySelector('.truncate')
    expect(truncated?.textContent).toBe('antiga')
    expect(chip.querySelector('.shrink-0.whitespace-pre')?.textContent).toBe('⟲ bastão de ')
  })

  it('sessão sem relação não desenha a faixa', () => {
    const { container } = render(<ConnectedChips sessionId="ninguem" />)
    expect(container.innerHTML).toBe('')
  })
})
