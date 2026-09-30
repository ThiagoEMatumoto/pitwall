import { describe, expect, it } from 'vitest'
import type {
  SessionGraph,
  SessionGraphEdge,
  SessionGraphNode,
} from '../../../shared/types/session-graph'
import { linkNavOrder, sessionLinks, stepLink } from './session-links'

function node(sessionId: string, over: Partial<SessionGraphNode> = {}): SessionGraphNode {
  return {
    sessionId,
    ccSessionId: `cc-${sessionId}`,
    title: sessionId,
    projectId: 'p1',
    repoId: 'r-web',
    repoLabel: 'web',
    provider: 'claude',
    status: 'idle',
    attentionReason: null,
    lastActivityAt: null,
    purposeHint: null,
    childOfHandoffId: null,
    ...over,
  }
}

function handoff(from: string, to: string, createdAt: number): SessionGraphEdge {
  return {
    kind: 'handoff',
    from,
    to,
    handoffId: `h-${to}`,
    handoffStatus: 'running',
    currentStep: `passo de ${to}`,
    createdAt,
  }
}

function graph(nodes: SessionGraphNode[], edges: SessionGraphEdge[]): SessionGraph {
  return { nodes, lanes: [], edges }
}

// Mãe M com filhas A e B2 (nessa ordem); A delegou K; B2 recebeu o bastão de B
// (B2 é a filha atual do handoff, B a antecessora ainda viva).
const family = graph(
  [
    node('M'),
    node('A', { repoId: 'r-api', purposeHint: 'auth', childOfHandoffId: 'h-A' }),
    node('B', { repoId: 'r-api' }),
    node('B2', { repoId: 'r-api', purposeHint: 'perf', childOfHandoffId: 'h-B2' }),
    node('K', { repoId: 'r-api' }),
  ],
  [
    handoff('M', 'A', 1),
    handoff('M', 'B2', 2),
    handoff('A', 'K', 3),
    { kind: 'baton', from: 'B', to: 'B2', handoffId: 'h-B2' },
  ],
)

describe('sessionLinks', () => {
  it('filha: mãe, irmãs e as próprias filhas com o passo do handoff', () => {
    const l = sessionLinks(family, 'A')
    expect(l.mother?.sessionId).toBe('M')
    expect(l.siblings.map((n) => n.sessionId)).toEqual(['B2'])
    expect(l.children.map((c) => [c.node.sessionId, c.handoffId, c.step])).toEqual([
      ['K', 'h-K', 'passo de K'],
    ])
    expect(l.baton).toEqual({ predecessor: undefined, successor: undefined })
  })

  it('bastão nos dois sentidos', () => {
    expect(sessionLinks(family, 'B2').baton.predecessor?.sessionId).toBe('B')
    expect(sessionLinks(family, 'B').baton.successor?.sessionId).toBe('B2')
    // A antecessora não é mais filha: não tem mãe no grafo.
    expect(sessionLinks(family, 'B').mother).toBeUndefined()
  })

  it('sessão fora do grafo não tem vínculo nenhum', () => {
    const l = sessionLinks(family, 'ninguem')
    expect(l.mother).toBeUndefined()
    expect(l.children).toEqual([])
    expect(l.siblings).toEqual([])
    expect(l.linkedRepoSessions).toEqual([])
  })

  it('repos ligados: agrupa as sessões vivas do outro lado, nos dois sentidos do fio', () => {
    const g = graph(
      [
        node('w1'),
        node('a1', { repoId: 'r-api', repoLabel: 'api-core' }),
        node('a2', { repoId: 'r-api', repoLabel: 'api-core' }),
        node('s1', { repoId: 'r-site', repoLabel: 'site' }),
      ],
      [
        {
          kind: 'repoDep',
          fromRepoId: 'r-web',
          toRepoId: 'r-api',
          depKinds: ['calls-api'],
          fromSessionIds: ['w1'],
          toSessionIds: ['a1', 'a2'],
        },
        {
          kind: 'repoDep',
          fromRepoId: 'r-site',
          toRepoId: 'r-web',
          depKinds: ['depends-on'],
          fromSessionIds: ['s1'],
          toSessionIds: ['w1'],
        },
      ],
    )
    const l = sessionLinks(g, 'w1')
    expect(
      l.linkedRepoSessions.map((r) => [r.repoId, r.repoLabel, r.sessions.map((n) => n.sessionId)]),
    ).toEqual([
      ['r-api', 'api-core', ['a1', 'a2']],
      ['r-site', 'site', ['s1']],
    ])
    expect(sessionLinks(g, 'a1').linkedRepoSessions.map((r) => r.repoLabel)).toEqual(['web'])
  })
})

describe('navegação por relação (Alt+,/Alt+.)', () => {
  it('ordem estável: mãe → irmãs (com a atual no lugar dela) → filhas', () => {
    expect(linkNavOrder(family, 'A').map((n) => n.sessionId)).toEqual(['M', 'A', 'B2', 'K'])
    expect(linkNavOrder(family, 'M').map((n) => n.sessionId)).toEqual(['M', 'A', 'B2'])
  })

  it('bastão na linha do tempo: antecessora antes, sucessora depois (Alt+, e Alt+. inversos)', () => {
    expect(linkNavOrder(family, 'B2').map((n) => n.sessionId)).toEqual(['M', 'A', 'B', 'B2'])
    expect(linkNavOrder(family, 'B').map((n) => n.sessionId)).toEqual(['B', 'B2'])
    expect(stepLink(family, 'B2', -1)?.node.sessionId).toBe('B')
    expect(stepLink(family, 'B', 1)?.node.sessionId).toBe('B2')
  })

  it('anda um passo sem dar a volta; nas pontas fica parado', () => {
    expect(stepLink(family, 'M', 1)).toMatchObject({
      node: { sessionId: 'A' },
      position: 2,
      total: 3,
    })
    expect(stepLink(family, 'A', 1)?.node.sessionId).toBe('B2')
    expect(stepLink(family, 'A', -1)?.node.sessionId).toBe('M')
    expect(stepLink(family, 'M', -1)).toBeNull()
    expect(stepLink(family, 'K', 1)).toBeNull()
  })

  it('pula a sessão encerrada (sem aba pra focar), mas não a filha da crew', () => {
    const g = graph(
      [
        node('M', { status: 'ended' }),
        node('A', { childOfHandoffId: 'h-A' }),
        node('B', { status: 'ended', childOfHandoffId: 'h-B' }),
      ],
      [handoff('M', 'A', 1), handoff('M', 'B', 2)],
    )
    expect(stepLink(g, 'A', -1)).toBeNull()
    expect(stepLink(g, 'A', 1)).toMatchObject({ node: { sessionId: 'B' }, position: 2, total: 2 })
  })

  it('sessão sem vínculo não navega', () => {
    expect(linkNavOrder(family, 'ninguem')).toEqual([])
    expect(stepLink(family, 'ninguem', 1)).toBeNull()
  })
})
