import { describe, expect, it } from 'vitest'
import {
  CARD_RESIZE_LIMITS,
  CARD_GAP,
  CARD_H,
  CARD_W,
  BRIEF_H,
  BRIEF_W,
  MOTHER_W,
  OPEN_W,
  cardSizesOf,
  pinUnsavedSiblings,
  cardTailLines,
  clampCardSize,
  graphToFlow,
  layoutRects,
  type MapInput,
  type SessionCardData,
} from './graph-to-flow'
import { tidyPositions } from './tidy'
import type { SessionGraph, SessionGraphNode } from '../../../shared/types/session-graph'
import type { CanvasPosition } from '../../../shared/types/canvas'

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

function featureGraph(nodes: SessionGraphNode[], edges: SessionGraph['edges'] = []): SessionGraph {
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
        name: 'Checkout',
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

const pos = (entityId: string, p: Partial<CanvasPosition>): CanvasPosition => ({
  scope: 'all',
  kind: 'session',
  entityId,
  x: 12,
  y: 30,
  w: null,
  h: null,
  ...p,
})

function input(patch: Partial<MapInput> & Pick<MapInput, 'graph'>): MapInput {
  return { scope: 'all', positions: [], notes: [], groups: [], ...patch }
}

const sessionNode = (nodes: ReturnType<typeof graphToFlow>['nodes'], id: string) =>
  nodes.find((n) => n.id === `s:${id}`)!

describe('clampCardSize', () => {
  it('prende o cartão comum aos limites dele', () => {
    const { card } = CARD_RESIZE_LIMITS
    expect(clampCardSize({ w: 10, h: 10 }, false)).toEqual({ w: card.minW, h: card.minH })
    expect(clampCardSize({ w: 9999, h: 9999 }, false)).toEqual({ w: card.maxW, h: card.maxH })
  })

  it('a mãe tem limites próprios, maiores', () => {
    const { mother } = CARD_RESIZE_LIMITS
    expect(clampCardSize({ w: 10, h: 10 }, true)).toEqual({ w: mother.minW, h: mother.minH })
    expect(mother.minW).toBeGreaterThan(CARD_RESIZE_LIMITS.card.minW)
    expect(clampCardSize({ w: 9999, h: 9999 }, true)).toEqual({ w: mother.maxW, h: mother.maxH })
  })
})

describe('cardSizesOf', () => {
  it('só sessões com w/h gravados', () => {
    expect(
      cardSizesOf([
        pos('a', { w: 500, h: 260 }),
        pos('b', {}),
        { ...pos('n1', { w: 220, h: 132 }), kind: 'note' },
      ]),
    ).toEqual({ a: { w: 500, h: 260 } })
  })

  it('tamanho guardado sem posição (trocou de feature) vale; o da posição tem prioridade', () => {
    expect(
      cardSizesOf(
        [pos('a', { w: 500, h: 260 })],
        [
          { sessionId: 'a', w: 900, h: 900 },
          { sessionId: 'g', w: 600, h: 500 },
        ],
      ),
    ).toEqual({ a: { w: 500, h: 260 }, g: { w: 600, h: 500 } })
  })
})

describe('graphToFlow — tamanho salvo do cartão', () => {
  const g = featureGraph([node('a'), node('b')])

  it('cartão aberto com w/h salvos usa o tamanho do usuário (preso aos limites)', () => {
    const { nodes } = graphToFlow(input({ graph: g, positions: [pos('a', { w: 520, h: 420 })] }))
    const a = sessionNode(nodes, 'a')
    expect([a.width, a.height]).toEqual([520, 420])
    expect((a.data as SessionCardData).sized).toBe(true)
    const b = sessionNode(nodes, 'b')
    expect(b.width).toBe(OPEN_W)
    expect((b.data as SessionCardData).sized).toBe(false)
  })

  it('valor salvo fora dos limites é preso', () => {
    const { nodes } = graphToFlow(input({ graph: g, positions: [pos('a', { w: 5000, h: 20 })] }))
    const a = sessionNode(nodes, 'a')
    expect([a.width, a.height]).toEqual([
      CARD_RESIZE_LIMITS.card.maxW,
      CARD_RESIZE_LIMITS.card.minH,
    ])
  })

  it('recolhido e o resumo (zoom baixo) ignoram o tamanho salvo', () => {
    const positions = [pos('a', { w: 520, h: 420 })]
    const collapsed = graphToFlow(input({ graph: g, positions, views: { a: 'collapsed' } }))
    expect([
      sessionNode(collapsed.nodes, 'a').width,
      sessionNode(collapsed.nodes, 'a').height,
    ]).toEqual([CARD_W, CARD_H])
    const compact = graphToFlow(input({ graph: g, positions, compact: true }))
    expect([sessionNode(compact.nodes, 'a').width, sessionNode(compact.nodes, 'a').height]).toEqual(
      [BRIEF_W, BRIEF_H],
    )
  })

  it('a mãe redimensionada mantém o tamanho também no resumo (ela não vira resumo)', () => {
    const mg = featureGraph(
      [node('m', { isMother: true, childCount: 1 }), node('c', { repoId: 'r-web' })],
      [handoff('m', 'c', 'h1')],
    )
    const positions = [pos('m', { w: 900, h: 640 })]
    for (const compact of [false, true]) {
      const m = sessionNode(graphToFlow(input({ graph: mg, positions, compact })).nodes, 'm')
      expect([m.width, m.height]).toEqual([900, 640])
    }
    const plain = sessionNode(graphToFlow(input({ graph: mg })).nodes, 'm')
    expect(plain.width).toBe(MOTHER_W)
  })

  it('a mãe aberta no painel ignora o tamanho salvo: no mapa ela só mostra o aviso curto', () => {
    const mg = featureGraph(
      [node('m', { isMother: true, childCount: 1 }), node('c', { repoId: 'r-web' })],
      [handoff('m', 'c', 'h1')],
    )
    const positions = [pos('m', { w: 1100, h: 800 })]
    const m = sessionNode(
      graphToFlow(input({ graph: mg, positions, inPanel: 'm', cardHeights: { m: 180 } })).nodes,
      'm',
    )
    expect([m.width, m.height]).toEqual([MOTHER_W, 180])
    expect((m.data as SessionCardData).sized).toBeFalsy()
  })

  it('cartão mais alto: o tail ao vivo mostra mais linhas; sem tamanho salvo, o padrão', () => {
    const short = sessionNode(
      graphToFlow(input({ graph: g, positions: [pos('a', { w: 400, h: 200 })] })).nodes,
      'a',
    )
    const tall = sessionNode(
      graphToFlow(input({ graph: g, positions: [pos('a', { w: 400, h: 600 })] })).nodes,
      'a',
    )
    const ls = (short.data as SessionCardData).tail!
    const lt = (tall.data as SessionCardData).tail!
    expect(lt.lines).toBeGreaterThan(ls.lines)
    expect(lt.window).toBeGreaterThanOrEqual(lt.lines)
    const plain = sessionNode(graphToFlow(input({ graph: g })).nodes, 'b')
    expect((plain.data as SessionCardData).tail).toBeNull()
  })

  it('cartão maior empurra o vizinho de baixo (sem posição salva) — sem sobreposição', () => {
    const { nodes } = graphToFlow(
      input({ graph: g, positions: [pos('a', { x: 12, y: 30, w: 400, h: 600 })] }),
    )
    const { rects } = layoutRects(nodes)
    const a = rects.get('s:a')!
    const b = rects.get('s:b')!
    expect(b.y).toBeGreaterThanOrEqual(a.y + a.h)
  })

  it('dois salvos: o de cima cresceu sobre o de baixo → o de baixo desce', () => {
    const { nodes } = graphToFlow(
      input({
        graph: g,
        positions: [pos('a', { x: 12, y: 30, w: 400, h: 600 }), pos('b', { x: 12, y: 260 })],
      }),
    )
    const { rects } = layoutRects(nodes)
    const a = rects.get('s:a')!
    const b = rects.get('s:b')!
    expect(b.y).toBeGreaterThanOrEqual(a.y + a.h)
    // Lado a lado sem cobrir: ninguém mexe.
    const side = graphToFlow(
      input({
        graph: g,
        positions: [pos('a', { x: 12, y: 30, w: 400, h: 600 }), pos('b', { x: 500, y: 60 })],
      }),
    )
    expect(sessionNode(side.nodes, 'b').position).toEqual({ x: 500, y: 60 })
  })

  it('a raia cresce para caber o cartão redimensionado', () => {
    const { nodes } = graphToFlow(
      input({ graph: g, positions: [pos('a', { x: 12, y: 30, w: 900, h: 600 })] }),
    )
    const { rects } = layoutRects(nodes)
    const a = rects.get('s:a')!
    const lane = [...rects.entries()].find(([id]) => id.includes(':r:'))![1]
    expect(lane.x + lane.w).toBeGreaterThanOrEqual(a.x + a.w)
    expect(lane.y + lane.h).toBeGreaterThanOrEqual(a.y + a.h)
  })
})

describe('cardTailLines', () => {
  it('cresce com a altura, entre o mínimo e o que o main manda (20)', () => {
    const small = cardTailLines(150, false)
    const big = cardTailLines(2000, false)
    expect(small.lines).toBeGreaterThanOrEqual(1)
    expect(big.lines).toBe(20)
    expect(big.window).toBe(20)
    expect(cardTailLines(500, false).lines).toBeGreaterThan(small.lines)
    expect(cardTailLines(900, true).lines).toBeGreaterThan(cardTailLines(400, true).lines)
  })
})

describe('tidy — Organizar respeita o tamanho salvo', () => {
  it('mantém w/h dos cartões redimensionados e não sobrepõe', () => {
    const g = featureGraph([node('a'), node('b')])
    const items = tidyPositions(
      input({ graph: g, positions: [pos('a', { x: 300, y: 500, w: 600, h: 500 })] }),
    )
    const a = items.find((i) => i.entityId === 'a')!
    const b = items.find((i) => i.entityId === 'b')!
    expect([a.w, a.h]).toEqual([600, 500])
    expect(b.w ?? null).toBeNull()
    // Re-layout a partir do que o tidy grava: b embaixo de a, sem cobrir.
    const { nodes } = graphToFlow(
      input({
        graph: g,
        positions: items.map((i) => ({ scope: 'all', w: null, h: null, ...i }) as CanvasPosition),
      }),
    )
    const { rects } = layoutRects(nodes)
    const ra = rects.get('s:a')!
    const rb = rects.get('s:b')!
    const overlap =
      ra.x < rb.x + rb.w && ra.x + ra.w > rb.x && ra.y < rb.y + rb.h && ra.y + ra.h > rb.y
    expect(overlap).toBe(false)
  })
})

describe('pinUnsavedSiblings', () => {
  const node = (id: string, parentId: string, x: number, y: number, type = 'session') => ({
    id,
    type,
    parentId,
    position: { x, y },
  })
  const saved = (entityId: string): CanvasPosition =>
    ({ kind: 'session', entityId, x: 0, y: 0 }) as CanvasPosition

  it('fixa só os irmãos sem posição salva acima do cartão (e na mesma linha)', () => {
    const nodes = [
      node('s:M', 'lane:r', 12, 40),
      node('s:G', 'lane:r', 12, 620),
      node('s:P', 'lane:r', 420, 620),
      node('s:F', 'lane:r', 12, 900),
      node('s:X', 'lane:other', 12, 40),
    ]
    expect(pinUnsavedSiblings('G', nodes, [])).toEqual([
      { kind: 'session', entityId: 'M', x: 12, y: 40 },
      { kind: 'session', entityId: 'P', x: 420, y: 620 },
    ])
  })

  it('não mexe em quem já tem posição salva nem em nós que não são sessão', () => {
    const nodes = [
      node('s:M', 'lane:r', 12, 40),
      node('s:G', 'lane:r', 12, 620),
      node('n:N', 'lane:r', 300, 40, 'note'),
    ]
    expect(pinUnsavedSiblings('G', nodes, [saved('M')])).toEqual([])
  })
})

describe('redimensionar um cartão no meio da coluna', () => {
  it('os de baixo seguem no layout automático: recolher um deles não deixa vão', () => {
    // M em cima, G redimensionado, F e H abaixo. Só M é fixada junto com G; F e H
    // continuam empilhando abaixo de G e acompanham quando F recolhe.
    const graph = featureGraph([node('M'), node('G'), node('F'), node('H')])
    const before = graphToFlow(input({ graph }))
    const ys = ['M', 'G', 'F', 'H'].map((id) => sessionNode(before.nodes, id).position.y)
    expect([...ys].sort((a, b) => a - b)).toEqual(ys)
    const pins = pinUnsavedSiblings('G', before.nodes, [])
    expect(pins.map((p) => p.entityId)).toEqual(['M'])
    const g = sessionNode(before.nodes, 'G')
    const positions = [
      ...pins.map((p) => pos(p.entityId, p)),
      pos('G', { x: g.position.x, y: g.position.y, w: 560, h: 472 }),
    ]
    const open = graphToFlow(input({ graph, positions, views: { F: 'open' } }))
    const collapsed = graphToFlow(input({ graph, positions, views: { F: 'collapsed' } }))
    for (const flow of [open, collapsed]) {
      const gN = sessionNode(flow.nodes, 'G')
      const f = sessionNode(flow.nodes, 'F')
      const h = sessionNode(flow.nodes, 'H')
      expect(sessionNode(flow.nodes, 'M').position.y).toBe(ys[0])
      expect(f.position.y).toBe(gN.position.y + gN.height! + CARD_GAP)
      expect(h.position.y).toBe(f.position.y + f.height! + CARD_GAP)
    }
    expect(sessionNode(collapsed.nodes, 'H').position.y).toBeLessThan(
      sessionNode(open.nodes, 'H').position.y,
    )
  })
})
