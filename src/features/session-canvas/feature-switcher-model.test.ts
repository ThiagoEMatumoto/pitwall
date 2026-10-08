import { describe, expect, it } from 'vitest'
import {
  buildSwitcherEntries,
  groupKeyOf,
  leavesScope,
  openIndex,
  stepIndex,
  switcherKeyLabel,
  switcherKeyNote,
} from './feature-switcher-model'
import { setKeyboardLayoutLabels } from '../../lib/keybindings'
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
      node('m2', {
        featureId: 'f2',
        isMother: true,
        childCount: 1,
        status: 'waiting',
        attentionReason: 'waiting',
      }),
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
    // m2 está na fila ('waiting' no nó): o TOM vem do indicador. A contagem
    // needsYou vem só da fila única (attention-unified.test): sem lista, zero.
    expect(entries[1]).toMatchObject({ motherId: 'm2', motherTone: 'needs-you', needsYou: 0 })
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

  // O tom segue o nó da fila única, como o HUD: a tela "Interrupted" não o muda.
  // Fora da fila, a mesma tela é interrompida.
  it('tail "Interrupted": o tom é o da fila; fora dela, interrompida', () => {
    const tail = ['  ⎿  Interrupted · What should Claude do instead?', '> ']
    const tailOf = (id: string) => (id === 'm2' ? tail : null)
    expect(buildSwitcherEntries(graph, new Map(), tailOf)[1].motherTone).toBe('needs-you')
    const g: SessionGraph = {
      ...graph,
      nodes: graph.nodes.map((n) => (n.sessionId === 'm2' ? { ...n, attentionReason: null } : n)),
    }
    expect(buildSwitcherEntries(g, new Map(), tailOf)[1].motherTone).toBe('interrupted')
  })

  it('sessões encerradas não contam nem viram mãe', () => {
    const g: SessionGraph = {
      ...graph,
      nodes: graph.nodes.map((n) => (n.sessionId === 'm1' ? { ...n, status: 'ended' } : n)),
    }
    expect(buildSwitcherEntries(g, new Map())[0]).toMatchObject({ motherId: null, working: 1 })
  })

  // Mesma regra do mapa: ele só desenha sessões em uso, o seletor só lista o que
  // dá para enquadrar nele.
  it('feature sem nenhuma sessão viva não entra na lista', () => {
    const g: SessionGraph = {
      ...graph,
      nodes: graph.nodes.map((n) =>
        n.sessionId === 'm1' || n.sessionId === 'c1' ? { ...n, status: 'ended' } : n,
      ),
    }
    expect(buildSwitcherEntries(g, new Map()).map((e) => e.key)).toEqual(['f2', 'p:p1'])
  })

  it('"Sem feature" só aparece com sessão viva no grupo', () => {
    const g: SessionGraph = {
      ...graph,
      nodes: graph.nodes.map((n) => (n.sessionId === 'loose' ? { ...n, status: 'ended' } : n)),
    }
    expect(buildSwitcherEntries(g, new Map()).map((e) => e.key)).toEqual(['f1', 'f2'])
  })

  it('o conjunto em uso do mapa (inUse) manda: fora dele a feature some', () => {
    const inUse = new Set(['m2', 'c2'])
    const entries = buildSwitcherEntries(graph, new Map(), () => null, inUse)
    expect(entries.map((e) => e.key)).toEqual(['f2'])
    expect(entries[0]).toMatchObject({ motherId: 'm2' })
  })
})

describe('switcherKeyLabel', () => {
  // ABNT2: o Backquote vira "'" no layout e a dica dizia "Ctrl+'" — o atalho é a crase.
  it('Backquote é sempre a crase', () => {
    expect(switcherKeyLabel({ mod: true, code: 'Backquote', key: "'" })).toBe('`')
  })
  it('outras teclas seguem o rótulo do combo', () => {
    expect(switcherKeyLabel({ mod: true, key: 'k' })).toBe('K')
  })
})

describe('switcherKeyNote', () => {
  // O atalho casa pela tecla física: no ABNT2 ela é a do ', e o ` de lá não dispara.
  it("no ABNT2 a crase vem com a tecla física (')", () => {
    setKeyboardLayoutLabels(new Map([['Backquote', "'"]]))
    try {
      expect(switcherKeyNote({ mod: true, code: 'Backquote' })).toBe("tecla '")
    } finally {
      setKeyboardLayoutLabels(new Map())
    }
  })
  it('no layout US (ou sem mapa do layout) não há nota', () => {
    expect(switcherKeyNote({ mod: true, code: 'Backquote' })).toBeNull()
    expect(switcherKeyNote({ mod: true, key: 'k' })).toBeNull()
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
