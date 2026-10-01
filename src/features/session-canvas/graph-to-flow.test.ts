import { getElevatedEdgeZIndex } from '@xyflow/system'
import { describe, expect, it } from 'vitest'
import {
  CARD_H,
  CARD_W,
  OPEN_H,
  OPEN_W,
  TERMINAL_H,
  TERMINAL_W,
  graphToFlow,
  noteExcerpt,
  type LaneData,
  type MapInput,
  type SessionCardData,
} from './graph-to-flow'
import type { SessionGraph, SessionGraphNode } from '../../../shared/types/session-graph'
import type { CanvasNote, SessionGroup } from '../../../shared/types/canvas'

function node(sessionId: string, patch: Partial<SessionGraphNode> = {}): SessionGraphNode {
  return {
    sessionId,
    ccSessionId: `cc-${sessionId}`,
    title: sessionId,
    projectId: 'p1',
    repoId: 'r-api',
    repoLabel: 'api',
    provider: 'claude',
    status: 'working',
    attentionReason: null,
    lastActivityAt: 1_000,
    purposeHint: null,
    purpose: null,
    purposeSource: null,
    groupId: null,
    lastSummary: null,
    lastSummaryAt: null,
    childOfHandoffId: null,
    ...patch,
  }
}

// Mesmo formato que buildSessionGraph (electron/main/services/session-graph.ts)
// devolve: lanes projeto → repos com os sessionIds de cada repo.
function graph(nodes: SessionGraphNode[], edges: SessionGraph['edges'] = []): SessionGraph {
  const lanes: SessionGraph['lanes'] = []
  for (const n of nodes) {
    let lane = lanes.find((l) => l.projectId === n.projectId)
    if (!lane) {
      lane = { projectId: n.projectId, name: n.projectId ?? 'Avulsas', color: null, repos: [] }
      lanes.push(lane)
    }
    let repo = lane.repos.find((r) => r.repoId === n.repoId)
    if (!repo) {
      repo = { repoId: n.repoId, label: n.repoLabel ?? 'Avulsas', sessionIds: [] }
      lane.repos.push(repo)
    }
    repo.sessionIds.push(n.sessionId)
  }
  return { nodes, lanes, edges }
}

function input(patch: Partial<MapInput> & Pick<MapInput, 'graph'>): MapInput {
  return { scope: 'all', positions: [], notes: [], groups: [], ...patch }
}

const group = (id: string, scope = 'all'): SessionGroup => ({
  id,
  scope,
  name: `grupo ${id}`,
  color: null,
  createdAt: 1,
})

const note = (id: string, patch: Partial<CanvasNote> = {}): CanvasNote => ({
  id,
  scope: 'all',
  bodyMd: 'nota',
  attachedSessionId: null,
  color: null,
  createdAt: 1,
  updatedAt: 1,
  ...patch,
})

describe('graphToFlow — lanes', () => {
  it('projeto → repo → sessão via parentId, com pais antes dos filhos', () => {
    const g = graph([
      node('a'),
      node('b', { repoId: 'r-web', repoLabel: 'web' }),
      node('c', { projectId: 'p2', repoId: 'r-site', repoLabel: 'site' }),
    ])
    const { nodes } = graphToFlow(input({ graph: g }))
    const byId = new Map(nodes.map((n, i) => [n.id, { ...n, index: i }]))

    expect(byId.get('s:a')?.parentId).toBe('lane:r:r-api')
    expect(byId.get('lane:r:r-api')?.parentId).toBe('lane:p:p1')
    expect(byId.get('s:c')?.parentId).toBe('lane:r:r-site')
    for (const n of nodes) {
      if (n.parentId) expect(byId.get(n.parentId)!.index).toBeLessThan(byId.get(n.id)!.index)
    }
    // Lane cresce pra caber os cards; repos lado a lado dentro do projeto.
    const api = byId.get('lane:r:r-api')!
    const web = byId.get('lane:r:r-web')!
    expect(web.position.x).toBeGreaterThanOrEqual(api.position.x + (api.width ?? 0))
  })

  it('escopo de projeto mostra só as sessões daquele projeto', () => {
    const g = graph([node('a'), node('c', { projectId: 'p2', repoId: 'r-site' })])
    const ids = graphToFlow(input({ graph: g, scope: 'p2' })).nodes.map((n) => n.id)
    expect(ids).toContain('s:c')
    expect(ids).not.toContain('s:a')
    expect(ids).not.toContain('lane:p:p1')
  })

  it('posição salva vale (relativa ao pai); sessão nova empilha abaixo das salvas', () => {
    const g = graph([node('a'), node('b')])
    const { nodes } = graphToFlow(
      input({
        graph: g,
        positions: [
          { scope: 'all', kind: 'session', entityId: 'a', x: 40, y: 300, w: null, h: null },
        ],
      }),
    )
    const a = nodes.find((n) => n.id === 's:a')!
    const b = nodes.find((n) => n.id === 's:b')!
    expect(a.position).toEqual({ x: 40, y: 300 })
    expect(b.position.y).toBeGreaterThan(300)
  })
})

describe('graphToFlow — grupos do usuário', () => {
  it('sessão com groupId sai da lane e entra no grupo', () => {
    const g = graph([node('a', { groupId: 'g1' }), node('b')])
    const { nodes } = graphToFlow(input({ graph: g, groups: [group('g1')] }))
    expect(nodes.find((n) => n.id === 's:a')?.parentId).toBe('g:g1')
    const groupNode = nodes.find((n) => n.id === 'g:g1')
    expect(groupNode?.type).toBe('userGroup')
    expect(groupNode?.parentId).toBeUndefined()
    expect(nodes.find((n) => n.id === 's:b')?.parentId).toBe('lane:r:r-api')
  })

  it('grupo vazio aparece no escopo dele; de outro escopo sem membros visíveis, não', () => {
    const g = graph([node('a')])
    const ids = graphToFlow(
      input({ graph: g, scope: 'p1', groups: [group('mine', 'p1'), group('other', 'p2')] }),
    ).nodes.map((n) => n.id)
    expect(ids).toContain('g:mine')
    expect(ids).not.toContain('g:other')
  })

  it('groupId de grupo apagado cai de volta na lane', () => {
    const g = graph([node('a', { groupId: 'ghost' })])
    expect(graphToFlow(input({ graph: g })).nodes.find((n) => n.id === 's:a')?.parentId).toBe(
      'lane:r:r-api',
    )
  })
})

describe('graphToFlow — notas', () => {
  it('nota presa ganha fio pontilhado até a sessão; solta aparece só no escopo dela', () => {
    const g = graph([node('a')])
    const { nodes, edges } = graphToFlow(
      input({
        graph: g,
        scope: 'p1',
        notes: [
          note('pin', { attachedSessionId: 'a', scope: 'all' }),
          note('loose-here', { scope: 'p1' }),
          note('loose-elsewhere', { scope: 'p2' }),
        ],
      }),
    )
    const ids = nodes.map((n) => n.id)
    expect(ids).toEqual(expect.arrayContaining(['n:pin', 'n:loose-here']))
    expect(ids).not.toContain('n:loose-elsewhere')
    expect(edges.find((e) => e.id === 'e:n:pin')).toMatchObject({
      source: 'n:pin',
      target: 's:a',
      data: { kind: 'note' },
    })
  })
})

describe('graphToFlow — nota de sessão que saiu do grafo', () => {
  it('a sessão encerrou (ou o app reiniciou): a nota fica solta no escopo dela, marcada', () => {
    const { nodes, edges } = graphToFlow(
      input({
        graph: graph([node('a')]),
        scope: 'all',
        notes: [
          note('orfa', { attachedSessionId: 'morta', scope: 'all' }),
          note('orfa-outro-escopo', { attachedSessionId: 'morta', scope: 'p2' }),
        ],
      }),
    )
    const orfa = nodes.find((n) => n.id === 'n:orfa')
    expect(orfa?.data).toMatchObject({ sessionEnded: true })
    expect(nodes.map((n) => n.id)).not.toContain('n:orfa-outro-escopo')
    expect(edges.find((e) => e.id === 'e:n:orfa')).toBeUndefined()
  })

  it('sessão viva mas fora deste escopo: a nota não aparece aqui (não é órfã)', () => {
    const g = graph([node('a'), node('b', { projectId: 'p2' })])
    const { nodes } = graphToFlow(
      input({
        graph: g,
        scope: 'p1',
        notes: [note('de-b', { attachedSessionId: 'b', scope: 'p1' })],
      }),
    )
    expect(nodes.map((x) => x.id)).not.toContain('n:de-b')
  })
})

describe('graphToFlow — arestas', () => {
  const base = [
    node('mae'),
    node('filha', { repoId: 'r-web', repoLabel: 'web', childOfHandoffId: 'h1' }),
    node('suc', { repoId: 'r-web', repoLabel: 'web' }),
  ]

  it('handoff running anima; needs_input vira alerta com o passo atual no rótulo', () => {
    const running = graphToFlow(
      input({
        graph: graph(base, [
          {
            kind: 'handoff',
            from: 'mae',
            to: 'filha',
            handoffId: 'h1',
            handoffStatus: 'running',
            currentStep: 'rodando testes',
            createdAt: 1,
          },
        ]),
      }),
    ).edges[0]
    expect(running).toMatchObject({
      id: 'e:h:h1',
      source: 's:mae',
      target: 's:filha',
      data: { kind: 'handoff', live: true, alert: false, label: 'rodando testes', handoffId: 'h1' },
    })

    const asking = graphToFlow(
      input({
        graph: graph(base, [
          {
            kind: 'handoff',
            from: 'mae',
            to: 'filha',
            handoffId: 'h1',
            handoffStatus: 'needs_input',
            currentStep: null,
            createdAt: 1,
          },
        ]),
      }),
    ).edges[0]
    expect(asking.data).toMatchObject({ live: false, alert: true })
  })

  it('bastão, repoDep entre lanes e feature pontilhada entre as sessões', () => {
    const { edges, nodes } = graphToFlow(
      input({
        graph: graph(base, [
          { kind: 'baton', from: 'filha', to: 'suc', handoffId: 'h1' },
          {
            kind: 'repoDep',
            fromRepoId: 'r-api',
            toRepoId: 'r-web',
            depKinds: ['calls-api'],
            fromSessionIds: ['mae'],
            toSessionIds: ['filha'],
          },
          { kind: 'feature', featureId: 'f1', sessionIds: ['mae', 'filha', 'suc'] },
        ]),
      }),
    )
    const kinds = edges.map((e) => [e.id, e.source, e.target, e.data?.kind])
    expect(kinds).toEqual(
      expect.arrayContaining([
        ['e:b:h1', 's:filha', 's:suc', 'baton'],
        ['e:r:r-api:r-web', 'lane:r:r-api', 'lane:r:r-web', 'repoDep'],
        ['e:f:f1:0', 's:mae', 's:filha', 'feature'],
        ['e:f:f1:1', 's:filha', 's:suc', 'feature'],
      ]),
    )
    // A mãe mostra quantas filhas tem.
    expect(nodes.find((n) => n.id === 's:mae')?.data).toMatchObject({ childCount: 0 })
  })

  it('aresta com ponta fora do escopo não é desenhada', () => {
    const nodes = [node('mae'), node('fora', { projectId: 'p2', repoId: 'r-site' })]
    const { edges } = graphToFlow(
      input({
        scope: 'p1',
        graph: graph(nodes, [
          {
            kind: 'handoff',
            from: 'mae',
            to: 'fora',
            handoffId: 'h9',
            handoffStatus: 'running',
            currentStep: null,
            createdAt: 1,
          },
        ]),
      }),
    )
    expect(edges).toEqual([])
  })

  it('conta filhas pelo fio de handoff e marca o resumo desatualizado', () => {
    const { nodes } = graphToFlow(
      input({
        graph: graph(
          [
            node('mae', { lastSummary: 'x', lastSummaryAt: 500, lastActivityAt: 1_000 }),
            node('filha'),
          ],
          [
            {
              kind: 'handoff',
              from: 'mae',
              to: 'filha',
              handoffId: 'h1',
              handoffStatus: 'done',
              currentStep: null,
              createdAt: 1,
            },
          ],
        ),
      }),
    )
    expect(nodes.find((n) => n.id === 's:mae')?.data).toMatchObject({
      childCount: 1,
      summaryStale: true,
    })
  })
})

describe('graphToFlow — escopo: só as sessões em uso', () => {
  // Encerrada: o produtor (buildSessionGraph) zera lastActivityAt e grava endedAt.
  const ended = (id: string, patch: Partial<SessionGraphNode> = {}) =>
    node(id, { status: 'ended', lastActivityAt: null, endedAt: 5, ...patch })
  const cards = (r: ReturnType<typeof graphToFlow>) =>
    r.nodes
      .filter((n) => n.type === 'session')
      .map((n) => n.id.slice(2))
      .sort()
  const handoff = (from: string, to: string): SessionGraph['edges'][number] => ({
    kind: 'handoff',
    from,
    to,
    handoffId: `h-${from}-${to}`,
    handoffStatus: 'running',
    currentStep: null,
    createdAt: 1,
  })

  it('desenha só o conjunto em uso; a encerrada some, junto com os fios dela', () => {
    const g = graph(
      [node('viva'), node('filha'), ended('mae-velha')],
      [handoff('mae-velha', 'filha')],
    )
    const r = graphToFlow(input({ graph: g, inUse: new Set(['viva', 'filha']) }))
    expect(cards(r)).toEqual(['filha', 'viva'])
    expect(r.edges).toEqual([])
  })

  it('sessão viva fora do conjunto em uso (fechada pelo usuário) também não aparece', () => {
    const r = graphToFlow(input({ graph: graph([node('a'), node('b')]), inUse: new Set(['a']) }))
    expect(cards(r)).toEqual(['a'])
  })

  it('sem conjunto explícito, cai na vivacidade do próprio grafo', () => {
    expect(cards(graphToFlow(input({ graph: graph([node('a'), ended('b')]) })))).toEqual(['a'])
  })

  it('bastão de antecessora encerrada: "continua de <alias>" na sucessora, sem nó nem fio', () => {
    const g = graph(
      [ended('antiga', { title: 'ana-api' }), node('nova')],
      [{ kind: 'baton', from: 'antiga', to: 'nova', handoffId: 'b1' }],
    )
    const r = graphToFlow(input({ graph: g, inUse: new Set(['nova']) }))
    expect(cards(r)).toEqual(['nova'])
    expect(r.edges).toEqual([])
    const nova = r.nodes.find((n) => n.id === 's:nova')!.data as SessionCardData
    expect(nova.continuesFrom).toBe('ana-api')
  })

  it('bastão entre duas vivas: fio ⟲, sem "continua de"', () => {
    const g = graph(
      [node('antiga'), node('nova')],
      [{ kind: 'baton', from: 'antiga', to: 'nova', handoffId: 'b1' }],
    )
    const r = graphToFlow(input({ graph: g }))
    expect(r.edges.map((e) => e.data?.kind)).toEqual(['baton'])
    expect((r.nodes.find((n) => n.id === 's:nova')!.data as SessionCardData).continuesFrom).toBe(
      null,
    )
  })

  it('mais de 8 fios: repoDep/feature viram agregados e todos os rótulos ficam "busy"', () => {
    const many = Array.from({ length: 10 }, (_, i) => node(`s${i}`))
    const edges: SessionGraph['edges'] = [
      { kind: 'feature', featureId: 'f1', sessionIds: many.map((n) => n.sessionId) },
    ]
    const r = graphToFlow(input({ graph: graph(many, edges) }))
    expect(r.edges.length).toBe(9)
    expect(r.edges.every((e) => e.data?.aggregate && e.data.busy)).toBe(true)
    const few = graphToFlow(
      input({ graph: graph(many.slice(0, 3), [{ ...edges[0], sessionIds: ['s0', 's1', 's2'] }]) }),
    )
    // feature só no foco, sempre; mas sem mapa cheio nenhum rótulo fica "busy".
    expect(few.edges.every((e) => e.data?.aggregate && !e.data?.busy)).toBe(true)
  })
})

describe('graphToFlow — hierarquia visual', () => {
  it('na lane: quem pede você primeiro, depois a atividade mais recente', () => {
    const g = graph([
      node('velha', { lastActivityAt: 10 }),
      node('viva', { lastActivityAt: 50 }),
      node('pede', { status: 'waiting', attentionReason: 'waiting', lastActivityAt: 5 }),
    ])
    const r = graphToFlow(input({ graph: g }))
    const order = r.nodes
      .filter((n) => n.type === 'session')
      .sort((a, b) => a.position.y - b.position.y)
      .map((n) => n.id.slice(2))
    expect(order).toEqual(['pede', 'viva', 'velha'])
    const lane = r.nodes.find((n) => n.id === 'lane:p:p1')!.data as LaneData
    expect(lane.attentionCount).toBe(1)
  })

  it('cartões empilham com a altura cheia (default: aberto)', () => {
    const r = graphToFlow(input({ graph: graph([node('a', { lastActivityAt: 2 }), node('b')]) }))
    const byId = new Map(r.nodes.map((n) => [n.id, n]))
    expect(byId.get('s:a')!.position.y - byId.get('s:b')!.position.y).toBe(OPEN_H + 16)
    expect(byId.get('s:a')).toMatchObject({ width: OPEN_W, height: OPEN_H })
    expect((byId.get('s:a')!.data as SessionCardData).view).toBe('open')
  })

  it('o tamanho do cartão segue o estado de exibição; o empilhamento acompanha', () => {
    const r = graphToFlow(
      input({
        graph: graph([
          node('a', { lastActivityAt: 3 }),
          node('b', { lastActivityAt: 2 }),
          node('c', { lastActivityAt: 1 }),
        ]),
        views: { a: 'collapsed', b: 'terminal' },
      }),
    )
    const byId = new Map(r.nodes.map((n) => [n.id, n]))
    expect(byId.get('s:a')).toMatchObject({ width: CARD_W, height: CARD_H })
    expect(byId.get('s:b')).toMatchObject({ width: TERMINAL_W, height: TERMINAL_H })
    const ya = byId.get('s:a')!.position.y
    const yb = byId.get('s:b')!.position.y
    const yc = byId.get('s:c')!.position.y
    expect(yb - ya).toBe(CARD_H + 16)
    expect(yc - yb).toBe(TERMINAL_H + 16)
    // A lane do repo alarga pro terminal caber.
    const repoLane = r.nodes.find((n) => n.id === byId.get('s:b')!.parentId)!
    expect(repoLane.width).toBeGreaterThanOrEqual(TERMINAL_W)
  })

  it('o terminal usa o tamanho redimensionado pelo usuário', () => {
    const r = graphToFlow(
      input({
        graph: graph([node('a')]),
        views: { a: 'terminal' },
        terminalSizes: { a: { w: 900, h: 600 } },
      }),
    )
    expect(r.nodes.find((n) => n.id === 's:a')).toMatchObject({ width: 900, height: 600 })
  })

  it('mãe com mais de 3 filhas: fios recolhidos (só no foco) até o leque abrir', () => {
    const kids = ['k1', 'k2', 'k3', 'k4'].map((id) =>
      node(id, { repoId: 'r-web', repoLabel: 'web' }),
    )
    const edges: SessionGraph['edges'] = kids.map((k, i) => ({
      kind: 'handoff',
      from: 'mae',
      to: k.sessionId,
      handoffId: `h${i}`,
      handoffStatus: 'done',
      currentStep: null,
      createdAt: i,
    }))
    const g = graph([node('mae'), ...kids], edges)
    const closed = graphToFlow(input({ graph: g }))
    expect(closed.edges.every((e) => e.data?.fanned)).toBe(true)
    const mae = closed.nodes.find((n) => n.id === 's:mae')!.data as SessionCardData
    expect(mae).toMatchObject({ childCount: 4, fanCollapsible: true, fanExpanded: false })
    const open = graphToFlow(input({ graph: g, expandedMothers: new Set(['mae']) }))
    expect(open.edges.some((e) => e.data?.fanned)).toBe(false)
  })

  it('nota presa aparece como 1ª linha no rodapé do cartão', () => {
    const r = graphToFlow(
      input({
        graph: graph([node('a')]),
        notes: [note('n1', { attachedSessionId: 'a', bodyMd: '\n## Plano: medir TTFB\nresto' })],
      }),
    )
    expect((r.nodes.find((n) => n.id === 's:a')!.data as SessionCardData).noteExcerpt).toBe(
      'Plano: medir TTFB',
    )
    expect(noteExcerpt('- [ ] revisar o PR')).toBe('revisar o PR')
  })
})

describe('graphToFlow — camadas', () => {
  it('fio fica abaixo dos cartões e acima das lanes (z efetivo do xyflow)', () => {
    const g = graph(
      [node('a'), node('b', { repoId: 'r-web', repoLabel: 'web' })],
      [
        {
          kind: 'handoff',
          from: 'a',
          to: 'b',
          handoffId: 'h',
          handoffStatus: 'running',
          currentStep: null,
          createdAt: 1,
        },
      ],
    )
    const r = graphToFlow(input({ graph: g }))
    const card = r.nodes.find((n) => n.id === 's:a')!
    const e = r.edges[0]
    // O z que o xyflow DE FATO dá ao fio no modo do SessionMap ('manual'), com a
    // ponta selecionada (no 'basic' ela somava +1000 e o fio cobria os cartões).
    const selected = { parentId: 'lane:r:api', selected: true, internals: { z: 1005 } }
    const z = getElevatedEdgeZIndex({
      sourceNode: selected as never,
      targetNode: selected as never,
      zIndex: e.zIndex,
      elevateOnSelect: true,
      zIndexMode: 'manual',
    })
    expect(z).toBeLessThan(card.zIndex!)
    // Acima do fundo da lane de repo (z 1, filho da lane de projeto).
    expect(z).toBeGreaterThan(1)
  })
})
