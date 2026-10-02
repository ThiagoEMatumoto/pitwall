import { getElevatedEdgeZIndex } from '@xyflow/system'
import { describe, expect, it } from 'vitest'
import {
  CARD_H,
  CARD_W,
  CARD_GAP,
  OPEN_EST_H,
  OPEN_H,
  OPEN_W,
  graphToFlow,
  homeRepoLaneId,
  layoutRects,
  noteExcerpt,
  positionKey,
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

  it('bastão e repoDep entre lanes', () => {
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
        ]),
      }),
    )
    const kinds = edges.map((e) => [e.id, e.source, e.target, e.data?.kind])
    expect(kinds).toEqual(
      expect.arrayContaining([
        ['e:b:filha:suc', 's:filha', 's:suc', 'baton'],
        ['e:r:r-api:r-web', 'lane:r:r-api', 'lane:r:r-web', 'repoDep'],
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

  const chain = (ids: string[]): SessionGraph['edges'] =>
    ids.slice(1).map((to, i) => ({ kind: 'baton', from: ids[i], to, handoffId: `b${i}` }))

  it('mais de 8 fios: todos os rótulos ficam "busy"', () => {
    const many = Array.from({ length: 10 }, (_, i) => node(`s${i}`))
    const r = graphToFlow(input({ graph: graph(many, chain(many.map((n) => n.sessionId))) }))
    expect(r.edges.length).toBe(9)
    expect(r.edges.every((e) => e.data?.busy)).toBe(true)
    const few = graphToFlow(input({ graph: graph(many.slice(0, 3), chain(['s0', 's1', 's2'])) }))
    expect(few.edges.some((e) => e.data?.busy)).toBe(false)
  })

  // Fio de ask é temporário: um pendente não pode virar o mapa inteiro pra "busy"
  // (rótulos somem, repoDep esconde) e desvirar quando respondem.
  it('8 fios + 1 ask pendente: o ask não conta pro mapa cheio', () => {
    const nine = Array.from({ length: 9 }, (_, i) => node(`s${i}`))
    const r = graphToFlow(
      input({
        graph: graph(nine, chain(nine.map((n) => n.sessionId))),
        asks: [{ id: 'q', from: 's0', to: 's1', text: 'oi' }],
      }),
    )
    expect(r.edges).toHaveLength(9)
    expect(r.edges.some((e) => e.data?.busy)).toBe(false)
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

  it('cartões abertos empilham pela altura desenhada (estimativa até a medição)', () => {
    const r = graphToFlow(input({ graph: graph([node('a', { lastActivityAt: 2 }), node('b')]) }))
    const byId = new Map(r.nodes.map((n) => [n.id, n]))
    expect(byId.get('s:a')!.position.y - byId.get('s:b')!.position.y).toBe(OPEN_EST_H + CARD_GAP)
    expect(byId.get('s:a')).toMatchObject({ width: OPEN_W, height: OPEN_EST_H })
    expect((byId.get('s:a')!.data as SessionCardData).view).toBe('open')

    const measured = graphToFlow(
      input({ graph: graph([node('a', { lastActivityAt: 2 }), node('b')]), cardHeights: { b: 150, a: 999 } }),
    )
    const m = new Map(measured.nodes.map((n) => [n.id, n]))
    expect(m.get('s:b')!.height).toBe(150)
    expect(m.get('s:a')!.position.y - m.get('s:b')!.position.y).toBe(150 + CARD_GAP)
    // Teto: a vaga máxima.
    expect(m.get('s:a')!.height).toBe(OPEN_H)
    // Caixa da lane justa ao conteúdo.
    const lane = measured.nodes.find((n) => n.id === m.get('s:a')!.parentId)!
    expect(lane.height).toBe(m.get('s:a')!.position.y + OPEN_H + 12)
  })

  it('o tamanho do cartão segue o estado de exibição; o empilhamento acompanha', () => {
    const r = graphToFlow(
      input({
        graph: graph([
          node('a', { lastActivityAt: 3 }),
          node('b', { lastActivityAt: 2 }),
          node('c', { lastActivityAt: 1 }),
        ]),
        // 'terminal' legado (do banco antigo) ocupa a vaga de um cartão aberto.
        views: { a: 'collapsed', b: 'terminal' },
      }),
    )
    const byId = new Map(r.nodes.map((n) => [n.id, n]))
    expect(byId.get('s:a')).toMatchObject({ width: CARD_W, height: CARD_H })
    expect(byId.get('s:b')).toMatchObject({ width: OPEN_W, height: OPEN_EST_H })
    const ya = byId.get('s:a')!.position.y
    const yb = byId.get('s:b')!.position.y
    const yc = byId.get('s:c')!.position.y
    expect(yb - ya).toBe(CARD_H + CARD_GAP)
    expect(yc - yb).toBe(OPEN_EST_H + CARD_GAP)
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

describe('graphToFlow — ask agente↔agente pendente', () => {
  const g = graph([node('a', { projectId: 'p1' }), node('b', { projectId: 'p2', repoId: 'r-b' })])

  it('vira fio temporário de quem perguntou pra quem responde, com a pergunta no rótulo', () => {
    const flow = graphToFlow(
      input({ graph: g, asks: [{ id: 'q1', from: 'a', to: 'b', text: 'como está o contrato?' }] }),
    )
    const ask = flow.edges.find((e) => e.id === 'e:a:q1')
    expect(ask).toMatchObject({ source: 's:a', target: 's:b' })
    expect(ask?.data).toMatchObject({ kind: 'ask', label: 'como está o contrato?' })
  })

  it('some sem asks pendentes e não desenha ponta fora do mapa', () => {
    expect(graphToFlow(input({ graph: g })).edges.some((e) => e.data?.kind === 'ask')).toBe(false)
    const flow = graphToFlow(
      input({ graph: g, asks: [{ id: 'q2', from: 'a', to: 'fora', text: 'oi' }] }),
    )
    expect(flow.edges.some((e) => e.data?.kind === 'ask')).toBe(false)
  })
})

describe('graphToFlow — card da feature', () => {
  // Mesmo shape do buildSessionGraph: um card 'feature' com 3 repos de 2 projetos.
  function featureGraph(nodes: SessionGraphNode[], edges: SessionGraph['edges'] = []): SessionGraph {
    const inRepo = (repoId: string) => nodes.filter((n) => n.repoId === repoId && n.featureId === 'f1')
    return {
      nodes,
      edges,
      lanes: [
        {
          kind: 'feature',
          featureId: 'f1',
          projectId: 'p1',
          projectName: 'Loja',
          name: 'Checkout E2E',
          color: null,
          pulse: 'Pagamento integrado',
          status: 'in-progress',
          pinned: false,
          repos: [
            { repoId: 'r-api', label: 'api', projectId: 'p1', projectName: 'Loja', sessionIds: inRepo('r-api').map((n) => n.sessionId) },
            { repoId: 'r-web', label: 'web', projectId: 'p1', projectName: 'Loja', sessionIds: inRepo('r-web').map((n) => n.sessionId) },
            { repoId: 'r-data', label: 'data', projectId: 'p2', projectName: 'Dados', sessionIds: inRepo('r-data').map((n) => n.sessionId) },
          ],
        },
        {
          kind: 'project',
          projectId: 'p1',
          name: 'Sem feature · Loja',
          color: null,
          repos: [
            {
              repoId: 'r-api',
              label: 'api',
              sessionIds: nodes.filter((n) => !n.featureId).map((n) => n.sessionId),
            },
          ],
        },
      ],
    }
  }
  const f = (id: string, repoId: string, patch: Partial<SessionGraphNode> = {}) =>
    node(id, { repoId, featureId: 'f1', featureTitle: 'Checkout E2E', ...patch })
  const handoff = (from: string, to: string): SessionGraph['edges'][number] => ({
    kind: 'handoff',
    from,
    to,
    handoffId: `h-${to}`,
    handoffStatus: 'running',
    currentStep: null,
    createdAt: 1,
  })

  it('1 card com 3 lanes de repo (inclusive vazias), projeto alheio marcado; sem feature à parte', () => {
    const g = featureGraph([f('m', 'r-api'), f('c', 'r-data'), node('solta')])
    const { nodes } = graphToFlow(input({ graph: g }))
    const card = nodes.find((n) => n.id === 'lane:f:f1')!
    expect(card.data).toMatchObject({
      level: 'feature',
      label: 'Checkout E2E',
      pulse: 'Pagamento integrado',
      sessionCount: 2,
      repoCount: 3,
    })
    const lanes = nodes.filter((n) => n.parentId === 'lane:f:f1')
    expect(lanes.map((n) => [n.id, (n.data as LaneData).projectName])).toEqual([
      ['lane:f:f1:r:r-api', null],
      ['lane:f:f1:r:r-web', null],
      ['lane:f:f1:r:r-data', 'Dados'],
    ])
    expect(nodes.find((n) => n.id === 's:c')?.parentId).toBe('lane:f:f1:r:r-data')
    // O mesmo repo no card e em "Sem feature": ids distintos.
    expect(nodes.find((n) => n.id === 's:solta')?.parentId).toBe('lane:r:r-api')
    expect((nodes.find((n) => n.id === 'lane:p:p1')!.data as LaneData).label).toBe(
      'Sem feature · Loja',
    )
  })

  it('mãe primeiro na própria lane; filha de outra lane alinhada ao topo; bastão lado a lado', () => {
    const g = featureGraph(
      [
        f('c1', 'r-api', { lastActivityAt: 9_000 }),
        f('m', 'r-api'),
        f('c2', 'r-data'),
        f('suc', 'r-web'),
        f('pred', 'r-web', { lastActivityAt: 9_999 }),
      ],
      [handoff('m', 'c1'), handoff('m', 'c2'), { kind: 'baton', from: 'pred', to: 'suc', handoffId: 'b' }],
    )
    const { nodes } = graphToFlow(input({ graph: g }))
    const at = (id: string) => nodes.find((n) => n.id === `s:${id}`)!
    const bottom = (id: string) => at(id).position.y + at(id).height!
    // c1 é mais recente, mas a mãe vem primeiro na lane dela.
    expect(at('c1').position.y).toBe(bottom('m') + CARD_GAP)
    // c2 está em outra lane: começa no topo dela, sem vão por geração.
    expect(at('c2').position.y).toBe(at('m').position.y)
    expect(at('pred').position.y).toBe(at('suc').position.y)
    expect(at('pred').position.x).toBeGreaterThanOrEqual(at('suc').position.x + at('suc').width!)
    // Caixa justa: a lane do web cabe as duas lado a lado, sem sobrar coluna.
    const web = nodes.find((n) => n.id === 'lane:f:f1:r:r-web')!
    expect(web.width).toBe(at('pred').position.x + at('pred').width! + 12)
  })

  it('cada coluna alinha ao topo: a pilha alta de outra coluna não empurra ninguém', () => {
    const g = featureGraph(
      [
        f('m', 'r-web'),
        f('x1', 'r-data'),
        f('x2', 'r-data'),
        f('x3', 'r-data'),
        f('x4', 'r-data'),
        f('c-web', 'r-web'),
        f('c-api', 'r-api'),
      ],
      [handoff('m', 'c-web'), handoff('m', 'c-api')],
    )
    const { nodes } = graphToFlow(input({ graph: g }))
    const at = (id: string) => nodes.find((n) => n.id === `s:${id}`)!
    const bottom = (id: string) => at(id).position.y + at(id).height!
    expect(at('c-web').position.y).toBe(bottom('m') + CARD_GAP)
    expect(at('c-api').position.y).toBe(at('m').position.y)
    expect(at('x1').position.y).toBe(at('m').position.y)
  })

  it('tidy determinístico e posição do card persistida por lane:f; migra a de lane:p', () => {
    const g = featureGraph([f('m', 'r-api')])
    expect(positionKey('lane:f:f1')).toEqual({ kind: 'lane', entityId: 'f:f1' })
    expect(positionKey('lane:f:f1:r:r-api')).toBeNull()
    const migrated = graphToFlow(
      input({ graph: g, positions: [{ scope: 'all', kind: 'lane', entityId: 'p:p1', x: 500, y: 70, w: null, h: null }] }),
    )
    expect(migrated.nodes.find((n) => n.id === 'lane:f:f1')?.position).toEqual({ x: 500, y: 70 })
    const own = graphToFlow(
      input({
        graph: g,
        positions: [
          { scope: 'all', kind: 'lane', entityId: 'p:p1', x: 500, y: 70, w: null, h: null },
          { scope: 'all', kind: 'lane', entityId: 'f:f1', x: 10, y: 20, w: null, h: null },
        ],
      }),
    )
    expect(own.nodes.find((n) => n.id === 'lane:f:f1')?.position).toEqual({ x: 10, y: 20 })
    const a = graphToFlow(input({ graph: g })).nodes.map((n) => [n.id, n.position])
    const b = graphToFlow(input({ graph: g })).nodes.map((n) => [n.id, n.position])
    expect(a).toEqual(b)
  })

  it('card salvo que cresceu (resolvedor moveu sessões) não cobre o vizinho salvo; nada é persistido', () => {
    const g = featureGraph([f('m', 'r-api'), f('c', 'r-data'), node('solta')])
    const positions = [
      { scope: 'all', kind: 'lane', entityId: 'f:f1', x: 0, y: 0, w: null, h: null },
      // Salvo por "Organizar" quando o card tinha 1 lane: agora ele tem 3.
      { scope: 'all', kind: 'lane', entityId: 'p:p1', x: 320, y: 0, w: null, h: null },
    ] as MapInput['positions']
    const { nodes } = graphToFlow(input({ graph: g, positions }))
    const card = nodes.find((n) => n.id === 'lane:f:f1')!
    const loose = nodes.find((n) => n.id === 'lane:p:p1')!
    expect(card.position).toEqual({ x: 0, y: 0 })
    expect(card.width!).toBeGreaterThan(320)
    expect(loose.position.x).toBeGreaterThanOrEqual(card.position.x + card.width!)
    expect(loose.position.y).toBe(0)
  })

  it('card novo não nasce em cima da lane "Sem feature" salva no v1 (lane:p ainda exibida)', () => {
    const g = featureGraph([f('m', 'r-api'), node('solta')])
    const { nodes } = graphToFlow(
      input({ graph: g, positions: [{ scope: 'all', kind: 'lane', entityId: 'p:p1', x: 0, y: 0, w: null, h: null }] }),
    )
    const card = nodes.find((n) => n.id === 'lane:f:f1')!
    const loose = nodes.find((n) => n.id === 'lane:p:p1')!
    expect(loose.position).toEqual({ x: 0, y: 0 })
    expect(card.position.x).toBeGreaterThanOrEqual(loose.position.x + loose.width!)
  })

  it('escopo de projeto: o card cross-project mostra a sessão do repo do outro projeto', () => {
    const g = featureGraph([f('m', 'r-api'), f('c', 'r-data', { projectId: 'p2' })])
    const { nodes } = graphToFlow(input({ graph: g, scope: 'p1' }))
    expect(nodes.find((n) => n.id === 's:c')?.parentId).toBe('lane:f:f1:r:r-data')
    expect((nodes.find((n) => n.id === 'lane:f:f1')!.data as LaneData).sessionCount).toBe(2)
    // E o escopo do outro projeto também vê o card inteiro (ele tem repo lá).
    const other = graphToFlow(input({ graph: g, scope: 'p2' })).nodes
    expect(other.find((n) => n.id === 's:m')?.parentId).toBe('lane:f:f1:r:r-api')
  })

  it('mãe com posição salva (v1): a filha de outra lane nasce no topo da dela', () => {
    const g = featureGraph([f('m', 'r-api'), f('c1', 'r-data')], [handoff('m', 'c1')])
    const { nodes } = graphToFlow(
      input({
        graph: g,
        positions: [{ scope: 'all', kind: 'session', entityId: 'm', x: 12, y: 600, w: null, h: null }],
      }),
    )
    const at = (id: string) => nodes.find((n) => n.id === `s:${id}`)!
    expect(at('m').position.y).toBe(600)
    expect(at('c1').position.y).toBe(30)
  })

  it('homeRepoLaneId: a lane de repo do card em que a sessão mora', () => {
    const g = featureGraph([f('m', 'r-api'), node('solta')])
    expect(homeRepoLaneId(g, 'm')).toBe('lane:f:f1:r:r-api')
    expect(homeRepoLaneId(g, 'solta')).toBe('lane:r:r-api')
  })
})

describe('graphToFlow — quebra em linhas e densidade compacta', () => {
  const many = () =>
    graph(
      ['p1', 'p2', 'p3', 'p4'].flatMap((p) =>
        [1, 2].map((i) => node(`${p}-${i}`, { projectId: p, repoId: `r-${p}-${i}`, repoLabel: `repo${i}` })),
      ),
    )
  const tops = (nodes: ReturnType<typeof graphToFlow>['nodes']) =>
    nodes.filter((n) => !n.parentId && n.type === 'lane')

  it('sem rowWidth os cards ficam numa linha só; com ele quebram abaixo de tudo, com 32px', () => {
    const one = tops(graphToFlow(input({ graph: many() })).nodes)
    expect(new Set(one.map((n) => n.position.y))).toEqual(new Set([0]))
    const laneW = one[0].width!
    const wrapped = tops(graphToFlow(input({ graph: many(), rowWidth: laneW * 2 + 100 })).nodes)
    const rows = [...new Set(wrapped.map((n) => n.position.y))].sort((a, b) => a - b)
    expect(rows.length).toBe(2)
    const firstRowBottom = Math.max(
      ...wrapped.filter((n) => n.position.y === 0).map((n) => n.position.y + n.height!),
    )
    expect(rows[1]).toBe(firstRowBottom + 32)
    // Cada linha recomeça na borda esquerda e nada se cobre.
    expect(wrapped.filter((n) => n.position.y === rows[1])[0].position.x).toBe(0)
    for (const a of wrapped)
      for (const b of wrapped) {
        if (a === b) continue
        const overlap =
          a.position.x < b.position.x + b.width! &&
          a.position.x + a.width! > b.position.x &&
          a.position.y < b.position.y + b.height! &&
          a.position.y + a.height! > b.position.y
        expect(overlap).toBe(false)
      }
  })

  it('card mais largo que a linha fica sozinho nela (não quebra no 1º)', () => {
    const t = tops(graphToFlow(input({ graph: many(), rowWidth: 10 })).nodes)
    expect(t[0].position).toEqual({ x: 0, y: 0 })
    expect(new Set(t.map((n) => n.position.y)).size).toBe(t.length)
  })

  it('compacto: o cartão aberto reserva só o resumo e a raia encolhe junto', () => {
    const g = graph([node('a'), node('b')])
    const full = graphToFlow(input({ graph: g }))
    const compact = graphToFlow(input({ graph: g, compact: true }))
    const card = (r: typeof full) => r.nodes.find((n) => n.id === 's:a')!
    expect(card(full).height).toBe(OPEN_EST_H)
    expect(card(compact).height).toBe(64)
    expect(card(compact).width).toBe(320)
    const lane = (r: typeof full) => r.nodes.find((n) => n.id === 'lane:r:r-api')!
    // 2 cartões de 64 + gap + cabeçalho + padding: nada de vaga de cartão cheio.
    expect(lane(compact).height).toBeLessThan(2 * 64 + 2 * CARD_GAP + 60)
    expect(lane(compact).height).toBeLessThan(lane(full).height!)
  })

  it('compacto: cartões da mesma raia com vão de 12px (não 24)', () => {
    const g = graph([node('a'), node('b')])
    const ys = graphToFlow(input({ graph: g, compact: true }))
      .nodes.filter((n) => n.type === 'session')
      .map((n) => n.position.y)
      .sort((x, y) => x - y)
    expect(ys[1] - ys[0]).toBe(64 + 12)
  })

  it('grupo "Sem feature": as raias começam abaixo do cabeçalho de 48px', () => {
    const f = graphToFlow(input({ graph: graph([node('a')]) }))
    expect(f.nodes.find((n) => n.id === 'lane:r:r-api')!.position.y).toBe(48)
  })
})

describe('layoutRects', () => {
  it('posição absoluta = soma da cadeia de pais; tops só os de raiz', () => {
    const f = graphToFlow(input({ graph: graph([node('a')]) }))
    const { rects, tops } = layoutRects(f.nodes)
    const lane = f.nodes.find((n) => n.id === 'lane:p:p1')!
    const repo = f.nodes.find((n) => n.id === 'lane:r:r-api')!
    const card = f.nodes.find((n) => n.id === 's:a')!
    expect(rects.get('s:a')).toMatchObject({
      x: lane.position.x + repo.position.x + card.position.x,
      y: lane.position.y + repo.position.y + card.position.y,
      w: card.width,
    })
    expect(tops).toHaveLength(1)
  })
})
