import { describe, expect, it } from 'vitest'
import {
  MOTHER_EST_H,
  MOTHER_W,
  OPEN_W,
  cardSize,
  graphToFlow,
  layoutRects,
  sessionNodeId,
  type MapInput,
  type SessionCardData,
} from './graph-to-flow'
import { tidyPositions } from './tidy'
import { MOTHER_READ_ZOOM, PANEL_MIN_ZOOM, planFit } from './map-fit'
import { motherDetail, MOTHER_TAIL_PX } from './mother-badge'
import type { SessionGraph, SessionGraphNode } from '../../../shared/types/session-graph'

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
    featureId: 'f1',
    ...patch,
  }
}

// Card da feature como o buildLanes do main devolve: repos de colunas.
function featureGraph(nodes: SessionGraphNode[], edges: SessionGraph['edges']): SessionGraph {
  const repos: Array<{ repoId: string | null; label: string; sessionIds: string[] }> = []
  for (const n of nodes) {
    let r = repos.find((x) => x.repoId === n.repoId)
    if (!r) {
      r = { repoId: n.repoId, label: n.repoLabel ?? '', sessionIds: [] }
      repos.push(r)
    }
    r.sessionIds.push(n.sessionId)
  }
  return {
    nodes,
    edges,
    lanes: [
      {
        kind: 'feature',
        featureId: 'f1',
        name: 'Checkout E2E',
        color: null,
        projectId: 'p1',
        pulse: null,
        status: 'in-progress',
        pinned: false,
        repos,
      } as unknown as SessionGraph['lanes'][number],
    ],
  }
}

const handoff = (from: string, to: string, id: string) =>
  ({
    kind: 'handoff',
    from,
    to,
    handoffId: id,
    handoffStatus: 'running',
    currentStep: null,
  }) as unknown as SessionGraph['edges'][number]

// A mãe NÃO é a primeira do grafo nem do 1º repo: o layout é quem a põe no topo.
const nodes = [
  node('c1', { repoId: 'r-web', repoLabel: 'web', lastActivityAt: 9_000 }),
  node('c2', { lastActivityAt: 8_000 }),
  node('m', { isMother: true, childCount: 2, lastActivityAt: 1_000 }),
]
const edges = [handoff('m', 'c1', 'h1'), handoff('m', 'c2', 'h2')]
const INPUT: MapInput = {
  graph: featureGraph(nodes, edges),
  scope: 'all',
  positions: [],
  notes: [],
  groups: [],
}

function rects(input: MapInput) {
  return layoutRects(graphToFlow(input).nodes).rects
}

describe('cartão da mãe no layout', () => {
  it('a mãe ocupa ~1.6x a largura de um cartão aberto e reserva mais altura', () => {
    expect(MOTHER_W / OPEN_W).toBeGreaterThanOrEqual(1.5)
    const m = cardSize('open', undefined, false, true)
    const c = cardSize('open', undefined, false, false)
    expect(m.w).toBe(MOTHER_W)
    expect(m.h).toBeGreaterThan(c.h)
    expect(m.h).toBe(MOTHER_EST_H)
  })

  it('não encolhe no resumo nem quando o usuário a recolheu', () => {
    expect(cardSize('open', 480, true, true)).toEqual({ w: MOTHER_W, h: 480 })
    expect(cardSize('collapsed', undefined, false, true).w).toBe(MOTHER_W)
    const flow = graphToFlow({ ...INPUT, compact: true, views: { m: 'collapsed' } })
    const card = flow.nodes.find((n) => n.id === sessionNodeId('m'))!
    expect(card.width).toBe(MOTHER_W)
    expect((card.data as SessionCardData).view).toBe('open')
  })

  it('a mãe fica no topo à esquerda do card da feature', () => {
    const r = rects(INPUT)
    const m = r.get(sessionNodeId('m'))!
    for (const id of ['c1', 'c2']) {
      const c = r.get(sessionNodeId(id))!
      expect(m.x).toBeLessThanOrEqual(c.x)
      expect(m.y).toBeLessThanOrEqual(c.y)
    }
  })

  it('as filhas não sobrepõem a mãe nem umas às outras', () => {
    const r = rects(INPUT)
    const cards = ['m', 'c1', 'c2'].map((id) => r.get(sessionNodeId(id))!)
    for (let i = 0; i < cards.length; i++)
      for (let j = i + 1; j < cards.length; j++) {
        const a = cards[i]
        const b = cards[j]
        const hit = a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
        expect(hit).toBe(false)
      }
  })

  it('é determinístico: o Organizar grava o mesmo layout duas vezes', () => {
    expect(tidyPositions(INPUT)).toEqual(tidyPositions(INPUT))
    const saved = tidyPositions(INPUT).find((p) => p.entityId === 'm')!
    const again = tidyPositions({ ...INPUT, graph: featureGraph([...nodes].reverse(), edges) })
    expect(again.find((p) => p.entityId === 'm')).toEqual(saved)
  })
})

describe('mãe aninhada (filha que delegou um neto)', () => {
  const lineage = [
    node('m', { isMother: true, childCount: 2 }),
    node('c1', { isMother: true, childCount: 1, repoId: 'r-web', repoLabel: 'web' }),
    node('c2'),
    node('neto', { repoId: 'r-web', repoLabel: 'web' }),
  ]
  const lineageEdges = [handoff('m', 'c1', 'h1'), handoff('m', 'c2', 'h2'), handoff('c1', 'neto', 'h3')]
  const input = (graphNodes: SessionGraphNode[]): MapInput => ({
    ...INPUT,
    graph: featureGraph(graphNodes, lineageEdges),
  })
  const card = (i: MapInput, id: string) =>
    graphToFlow(i).nodes.find((n) => n.id === sessionNodeId(id))!

  it('só a mãe do topo vira o cartão grande; a intermediária fica no comum', () => {
    const i = input(lineage)
    expect((card(i, 'm').data as SessionCardData).prominentMother).toBe(true)
    expect(card(i, 'm').width).toBe(MOTHER_W)
    const c1 = card(i, 'c1')
    expect((c1.data as SessionCardData).prominentMother).toBe(false)
    expect((c1.data as SessionCardData).node.isMother).toBe(true)
    expect(c1.width).toBeLessThan(MOTHER_W)
  })

  it('com a mãe do topo encerrada, a intermediária passa a ser o topo', () => {
    const i = input(lineage.map((n) => (n.sessionId === 'm' ? { ...n, status: 'ended' } : n)))
    expect((card(i, 'c1').data as SessionCardData).prominentMother).toBe(true)
  })
})

describe('legibilidade da mãe', () => {
  it('a saída ao vivo dá >= 12px efetivos no zoom de leitura do enquadrar', () => {
    expect(MOTHER_TAIL_PX * MOTHER_READ_ZOOM).toBeGreaterThanOrEqual(12)
  })

  it('fica no cartão cheio até um zoom bem baixo; abaixo, o mini (nome, selo, status, composer)', () => {
    expect(motherDetail(0.9)).toBe('full')
    expect(motherDetail(0.6)).toBe('full')
    expect(motherDetail(0.5)).toBe('mini')
  })
})

describe('enquadrar prioriza a mãe', () => {
  const view = { w: 1400, h: 900 }
  const mother = { x: 12, y: 110, w: MOTHER_W, h: MOTHER_EST_H }

  // A prioridade da mãe é sobre as filhas, não sobre as outras features: na visão
  // geral (7+ cartões) o piso de 0.88 dela mostrava só a feature dela. Ela fica
  // só como âncora (inteira na vista) e o zoom é o da visão geral.
  it('com a visão geral (7+ cartões) mantém o zoom da visão geral, com a mãe inteira', () => {
    const visible = { x: 0, y: 0, w: 4200, h: 1600 }
    const plan = planFit({ visible, priority: null, mother, view, cardCount: 9 })!
    expect(plan.viewport.zoom).toBeLessThan(MOTHER_READ_ZOOM)
    const l = mother.x * plan.viewport.zoom + plan.viewport.x
    const r = (mother.x + mother.w) * plan.viewport.zoom + plan.viewport.x
    const t = mother.y * plan.viewport.zoom + plan.viewport.y
    const b = (mother.y + mother.h) * plan.viewport.zoom + plan.viewport.y
    expect(l).toBeGreaterThanOrEqual(0)
    expect(r).toBeLessThanOrEqual(view.w)
    expect(t).toBeGreaterThanOrEqual(0)
    expect(b).toBeLessThanOrEqual(view.h)
  })

  it('mãe longe do começo do conjunto: a vista desloca até ela caber inteira', () => {
    const visible = { x: 0, y: 0, w: 3000, h: 700 }
    const far = { ...mother, x: 2200 }
    const plan = planFit({ visible, priority: null, mother: far, view, cardCount: 4 })!
    const r = (far.x + far.w) * plan.viewport.zoom + plan.viewport.x
    expect(r).toBeLessThanOrEqual(view.w)
    expect(far.x * plan.viewport.zoom + plan.viewport.x).toBeGreaterThanOrEqual(0)
  })

  it('a coluna fixada à esquerda (inset) é descontada', () => {
    const visible = { x: 0, y: 0, w: 1200, h: 700 }
    const plan = planFit({
      visible,
      priority: null,
      mother,
      view,
      insets: { left: 420 },
      cardCount: 3,
    })!
    expect(mother.x * plan.viewport.zoom + plan.viewport.x).toBeGreaterThanOrEqual(420)
  })

  it('alguém precisa de você longe da mãe: o cartão dele fica inteiro na vista', () => {
    const visible = { x: 0, y: 0, w: 3000, h: 700 }
    const needs = { x: 2400, y: 40, w: 400, h: 260 }
    const plan = planFit({
      visible,
      priority: needs,
      mother,
      view,
      cardCount: 5,
      needsYou: true,
    })!
    const l = needs.x * plan.viewport.zoom + plan.viewport.x
    const r = (needs.x + needs.w) * plan.viewport.zoom + plan.viewport.x
    expect(l).toBeGreaterThanOrEqual(0)
    expect(r).toBeLessThanOrEqual(view.w)
    expect(plan.priorityFits).toBe(true)
  })

  it('painel da feature aberto: a feature inteira ganha do piso de leitura da mãe', () => {
    const visible = { x: 0, y: 0, w: 2400, h: 900 }
    const feature = { x: 0, y: 0, w: 1300, h: 700 }
    const plan = planFit({
      visible,
      priority: feature,
      mother,
      view,
      insets: { right: 400 },
      cardCount: 5,
      priorityFloor: PANEL_MIN_ZOOM,
      alignTop: true,
    })!
    expect(plan.priorityFits).toBe(true)
    expect(plan.viewport.zoom).toBeLessThan(MOTHER_READ_ZOOM)
  })

  it('janela pequena demais: a mãe ainda cabe inteira (o zoom desce só por ela)', () => {
    const small = { w: 700, h: 500 }
    const visible = { x: 0, y: 0, w: 2000, h: 700 }
    const plan = planFit({ visible, priority: null, mother, view: small, cardCount: 3 })!
    const r = (mother.x + mother.w) * plan.viewport.zoom + plan.viewport.x
    expect(r).toBeLessThanOrEqual(small.w)
  })
})
