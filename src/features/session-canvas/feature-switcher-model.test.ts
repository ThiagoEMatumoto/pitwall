import { describe, expect, it } from 'vitest'
import {
  buildSwitcherEntries,
  groupKeyOf,
  leavesScope,
  openIndex,
  stepIndex,
} from './feature-switcher-model'
import type {
  SessionGraph,
  SessionGraphLane,
  SessionGraphNode,
} from '../../../shared/types/session-graph'

const node = (sessionId: string, over: Partial<SessionGraphNode> = {}): SessionGraphNode => ({
  sessionId,
  ccSessionId: `cc-${sessionId}`,
  title: sessionId,
  projectId: 'p1',
  repoId: 'r1',
  repoLabel: 'repo',
  provider: 'claude',
  status: 'idle',
  attentionReason: null,
  lastActivityAt: 1,
  purposeHint: null,
  purpose: null,
  purposeSource: null,
  groupId: null,
  lastSummary: null,
  lastSummaryAt: null,
  childOfHandoffId: null,
  ...over,
})

const featureLane = (featureId: string, sessionIds: string[]): SessionGraphLane => ({
  kind: 'feature',
  featureId,
  projectId: 'p1',
  projectName: 'Proj',
  name: `Feature ${featureId}`,
  color: null,
  pulse: `pulso ${featureId}`,
  status: 'in_progress',
  pinned: false,
  repos: [{ repoId: 'r1', label: 'repo', sessionIds }],
})

const handoff = (from: string, to: string) => ({
  kind: 'handoff' as const,
  from,
  to,
  handoffId: `h-${to}`,
  handoffStatus: 'in_progress' as const,
  currentStep: null,
  createdAt: 1,
})

describe('buildSwitcherEntries', () => {
  const graph: SessionGraph = {
    nodes: [
      node('m1', { featureId: 'f1', isMother: true, childCount: 1, title: 'Mãe um' }),
      node('c1', { featureId: 'f1', status: 'working' }),
      node('m2', { featureId: 'f2', isMother: true, childCount: 1, status: 'waiting' }),
      node('c2', { featureId: 'f2', attentionReason: 'handoff-input' }),
      node('loose', { featureId: null, status: 'working' }),
    ],
    lanes: [
      featureLane('f1', ['m1', 'c1']),
      featureLane('f2', ['m2', 'c2']),
      {
        kind: 'project',
        projectId: 'p1',
        name: 'Proj',
        color: null,
        repos: [{ repoId: 'r1', label: 'repo', sessionIds: ['loose'] }],
      },
    ],
    edges: [handoff('m1', 'c1'), handoff('m2', 'c2')],
  }

  it('um cartão por feature, com pulso, mãe e contadores; o grupo do projeto como "Sem feature"', () => {
    const entries = buildSwitcherEntries(graph, new Map())
    expect(entries.map((e) => e.key)).toEqual(['f1', 'f2', 'p:p1'])
    expect(entries[0]).toMatchObject({
      kind: 'feature',
      featureId: 'f1',
      laneFlowId: 'lane:f:f1',
      title: 'Feature f1',
      pulse: 'pulso f1',
      motherId: 'm1',
      motherTitle: 'Mãe um',
      working: 1,
      needsYou: 0,
    })
    // m2 está 'waiting' sem tela reconhecida e c2 tem pergunta pendente.
    expect(entries[1]).toMatchObject({ motherId: 'm2', motherTone: 'needs-you', needsYou: 2 })
    expect(entries[2]).toMatchObject({
      kind: 'project',
      featureId: null,
      laneFlowId: 'lane:p:p1',
      title: 'Sem feature · Proj',
      motherId: null,
      working: 1,
    })
  })

  it('a mãe de outra feature nunca vira a mãe do cartão (sem fallback)', () => {
    const g: SessionGraph = {
      ...graph,
      lanes: [featureLane('f3', ['x'])],
      nodes: [...graph.nodes, node('x', { featureId: 'f3' })],
    }
    expect(buildSwitcherEntries(g, new Map())[0].motherId).toBeNull()
  })

  // O mesmo tom do mapa e dos contadores: waiting com "Interrupted" no tail da
  // tela é interrompida, não "precisa de você".
  it('com o tail da tela, a interrompida não conta como precisa de você', () => {
    const g: SessionGraph = {
      ...graph,
      nodes: graph.nodes.map((n) => (n.sessionId === 'c2' ? { ...n, attentionReason: null } : n)),
    }
    const tail = ['  ⎿  Interrupted · What should Claude do instead?', '> ']
    expect(buildSwitcherEntries(g, new Map())[1]).toMatchObject({
      needsYou: 1,
      motherTone: 'needs-you',
    })
    const entry = buildSwitcherEntries(g, new Map(), (id) => (id === 'm2' ? tail : null))[1]
    expect(entry.needsYou).toBe(0)
    expect(entry.motherTone).not.toBe('needs-you')
  })

  it('sessões encerradas não contam nem viram mãe', () => {
    const g: SessionGraph = {
      ...graph,
      nodes: graph.nodes.map((n) =>
        n.sessionId === 'm1' || n.sessionId === 'c1' ? { ...n, status: 'ended' } : n,
      ),
    }
    expect(buildSwitcherEntries(g, new Map())[0]).toMatchObject({ motherId: null, working: 0 })
  })
})

describe('openIndex / stepIndex', () => {
  it('abrir já aponta para a anterior (toque rápido alterna as duas últimas)', () => {
    expect(openIndex(3, false)).toBe(1)
    expect(openIndex(3, true)).toBe(2)
    expect(openIndex(1, false)).toBe(0)
    expect(openIndex(0, false)).toBe(-1)
  })

  // Regressão: depois do boot (nada em foco) o toque rápido pulava a mais recente.
  it('sem a atual no topo, abre na 1ª (a mais recente)', () => {
    expect(openIndex(3, false, false)).toBe(0)
    expect(openIndex(3, true, false)).toBe(2)
    expect(openIndex(1, false, false)).toBe(0)
  })

  it('cicla com wrap-around nos dois sentidos', () => {
    expect(stepIndex(2, 1, 3)).toBe(0)
    expect(stepIndex(0, -1, 3)).toBe(2)
    expect(stepIndex(-1, 1, 0)).toBe(-1)
  })
})

// O mapa no escopo de um projeto só mostra os cards que tocam nele: o seletor
// lista todos, e confirmar um de fora precisa abrir o escopo para "Todos".
describe('escopo do mapa', () => {
  const projectLane = (projectId: string | null, sessionIds: string[]): SessionGraphLane => ({
    kind: 'project',
    projectId,
    name: `Sem feature · ${projectId}`,
    color: null,
    repos: [{ repoId: projectId ? 'r1' : null, label: 'repo', sessionIds }],
  })
  const multi: SessionGraphLane = {
    ...featureLane('f9', ['x']),
    projectId: 'p1',
    repos: [
      { repoId: 'r1', label: 'a', projectId: 'p1', sessionIds: ['x'] },
      { repoId: 'r2', label: 'b', projectId: 'p2', sessionIds: ['y'] },
    ],
  }
  const graph: SessionGraph = {
    nodes: [
      node('x', { featureId: 'f9' }),
      node('y', { featureId: 'f9', projectId: 'p2', repoId: 'r2' }),
      node('s', { featureId: null, projectId: 'p3' }),
      node('l', { featureId: null, projectId: 'p3', repoId: null }),
    ],
    edges: [],
    lanes: [multi, projectLane('p3', ['s']), projectLane(null, ['l'])],
  }
  const entries = new Map(buildSwitcherEntries(graph, new Map()).map((e) => [e.key, e]))

  it('feature que toca o projeto (home ou um repo) fica no escopo dele', () => {
    expect(leavesScope(entries.get('f9')!, 'p1')).toBe(false)
    expect(leavesScope(entries.get('f9')!, 'p2')).toBe(false)
    expect(leavesScope(entries.get('f9')!, 'p3')).toBe(true)
  })

  it('"Sem feature" de outro projeto e as avulsas saem do escopo', () => {
    expect(leavesScope(entries.get('p:p3')!, 'p3')).toBe(false)
    expect(leavesScope(entries.get('p:p3')!, 'p1')).toBe(true)
    expect(leavesScope(entries.get('p:loose')!, 'p1')).toBe(true)
  })

  it('escopo "Todos" nunca precisa trocar', () => {
    expect(leavesScope(entries.get('p:loose')!, null)).toBe(false)
  })

  it('groupKeyOf: a sessão sem feature pertence ao grupo da lane dela, não ao projectId', () => {
    expect(groupKeyOf(graph, 's')).toBe('p:p3')
    // Sem repo cai nas avulsas, mesmo com projectId.
    expect(groupKeyOf(graph, 'l')).toBe('p:loose')
    expect(groupKeyOf(graph, 'x')).toBeNull()
  })
})
