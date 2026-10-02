import { describe, expect, it } from 'vitest'
import { Position } from '@xyflow/react'
import { borderAnchor } from './edge-anchor'
import { focusFor } from './map-focus'
import {
  MIN_READABLE_ZOOM,
  actualSizeViewport,
  boundsOf,
  noteSlot,
  overflowEdges,
  readableViewport,
} from './map-fit'

describe('borderAnchor', () => {
  const card = { x: 0, y: 0, w: 248, h: 118 }
  it('mãe e filha empilhadas na mesma coluna: borda de baixo → borda de cima', () => {
    const below = { x: 0, y: 140, w: 248, h: 118 }
    expect(borderAnchor(card, below)).toEqual({ x: 124, y: 118, position: Position.Bottom })
    expect(borderAnchor(below, card)).toEqual({ x: 124, y: 140, position: Position.Top })
  })
  it('vizinho ao lado: lateral voltada pra ele', () => {
    expect(borderAnchor(card, { x: 400, y: 30, w: 248, h: 118 }).position).toBe(Position.Right)
    expect(borderAnchor(card, { x: -400, y: 30, w: 248, h: 118 }).position).toBe(Position.Left)
  })
})

describe('focusFor', () => {
  const edges = [
    { id: 'h', source: 's:a', target: 's:b' },
    { id: 'r', source: 'lane:r:api', target: 'lane:r:web' },
    { id: 'x', source: 's:c', target: 's:d' },
  ]
  it('acende os fios do cartão e os da lane do repo dele', () => {
    const f = focusFor('s:a', 'lane:r:api', edges, true)
    expect([...f.edges].sort()).toEqual(['h', 'r'])
    expect(f.nodes.has('s:b')).toBe(true)
    expect(f.nodes.has('s:c')).toBe(false)
    expect(f.dimOthers).toBe(true)
  })
  it('sem foco não esmaece nada', () => {
    expect(focusFor(null, null, edges, false)).toMatchObject({ dimOthers: false })
  })
})

describe('readableViewport', () => {
  const view = { w: 1200, h: 800 }
  it('cabe tudo acima do mínimo: canto superior esquerdo, sem centralizar no Y', () => {
    const v = readableViewport({ visible: { x: 0, y: 0, w: 1000, h: 400 }, priority: null, view })
    expect(v!.zoom).toBeGreaterThanOrEqual(MIN_READABLE_ZOOM)
    expect(v!.zoom).toBeLessThanOrEqual(1)
    expect(v).toMatchObject({ x: 24, y: 24 })
  })
  it('tudo não cabe e a prioridade cabe a partir do começo: encosta no começo do conjunto', () => {
    const v = readableViewport({
      visible: { x: 0, y: 0, w: 9000, h: 3000 },
      priority: { x: 400, y: 200, w: 400, h: 340 },
      view,
    })
    expect(v).toEqual({ x: 24, y: 24, zoom: MIN_READABLE_ZOOM })
  })
  it('quem precisa de você está fora da tela: o canto do bbox dela vai pro canto livre', () => {
    const v = readableViewport({
      visible: { x: 0, y: 0, w: 9000, h: 6000 },
      priority: { x: 4000, y: 100, w: 900, h: 340 },
      view,
    })
    expect(v!.zoom).toBe(MIN_READABLE_ZOOM)
    // x: pan mínimo — a borda direita do bbox no fim da tela, o resto de contexto
    // à esquerda continua visível; y: cabe a partir do topo do conjunto.
    expect(v!.x + (4000 + 900) * MIN_READABLE_ZOOM).toBe(1200 - 24)
    expect(v!.y).toBe(24)
  })
  it('prioridade maior que a tela: o canto dela no canto livre', () => {
    const v = readableViewport({
      visible: { x: 0, y: 0, w: 9000, h: 6000 },
      priority: { x: 3000, y: 0, w: 3000, h: 340 },
      view,
    })
    expect(v!.x).toBe(24 - 3000 * MIN_READABLE_ZOOM)
  })
  it('desconta a barra do topo: nada nasce embaixo dela', () => {
    const lane = { x: 0, y: 0, w: 3000, h: 5000 }
    const v = readableViewport({ visible: lane, priority: null, view, insets: { top: 60 } })
    expect(v!.y).toBe(60 + 24)
  })

  it('desconta controles (esquerda) e minimapa (base): o enquadramento cabe no que sobra', () => {
    const all = { x: 0, y: 0, w: 1000, h: 560 }
    const v = readableViewport({
      visible: all,
      priority: null,
      view: { w: 1100, h: 800 },
      insets: { top: 60, left: 50, bottom: 170 },
    })
    // Zoom limitado pela altura livre (800 - 60 - 170 - 2*24), não pela janela inteira.
    expect(v!.zoom).toBeCloseTo((800 - 60 - 170 - 48) / 560)
    expect(v!.x).toBeGreaterThanOrEqual(50)
    expect(v!.y + 560 * v!.zoom).toBeLessThanOrEqual(800 - 170)
  })

  it('100%: canto superior esquerdo do conteúdo no canto livre do mapa', () => {
    expect(actualSizeViewport({ x: -40, y: 10, w: 5000, h: 3000 }, { top: 60, left: 50 })).toEqual(
      { x: 50 + 24 + 40, y: 60 + 24 - 10, zoom: 1 },
    )
  })

  it('boundsOf junta os retângulos', () => {
    expect(
      boundsOf([
        { x: 10, y: 5, w: 10, h: 10 },
        { x: -5, y: 0, w: 5, h: 50 },
      ]),
    ).toEqual({ x: -5, y: 0, w: 25, h: 50 })
  })
})


describe('readableViewport — piso 0.9 e painel da Equipe', () => {
  it('nunca abaixo de 0.9; a prioridade cabe inteira à esquerda do painel', () => {
    const view = { w: 1400, h: 800 }
    const right = 360
    const priority = { x: 2000, y: 0, w: 600, h: 300 }
    const v = readableViewport({
      visible: { x: 0, y: 0, w: 3000, h: 600 },
      priority,
      view,
      insets: { right },
    })!
    expect(MIN_READABLE_ZOOM).toBe(0.9)
    expect(v.zoom).toBe(0.9)
    const screenRight = v.x + (priority.x + priority.w) * v.zoom
    expect(screenRight).toBeLessThanOrEqual(view.w - right)
  })
})

describe('overflowEdges — dica de conteúdo além da borda', () => {
  const view = { w: 1000, h: 600 }
  it('nada além: nenhuma borda acende', () => {
    expect(overflowEdges({ x: 0, y: 0, w: 800, h: 400 }, { x: 24, y: 24, zoom: 1 }, view)).toEqual({
      top: false,
      right: false,
      bottom: false,
      left: false,
    })
  })
  it('painel aberto à direita: o que está embaixo dele conta como transbordo', () => {
    const e = overflowEdges({ x: 0, y: 0, w: 800, h: 400 }, { x: 24, y: 24, zoom: 1 }, view, {
      right: 420,
    })
    expect(e.right).toBe(true)
    expect(e.left).toBe(false)
  })
  it('conteúdo deslocado pra cima/esquerda acende essas bordas', () => {
    const e = overflowEdges({ x: 0, y: 0, w: 800, h: 400 }, { x: -200, y: -100, zoom: 1 }, view)
    expect(e.left && e.top).toBe(true)
  })
})

describe('noteSlot — nota nova ao lado da seleção', () => {
  const size = { w: 220, h: 132 }
  const feature = { x: 0, y: 0, w: 900, h: 400 }
  it('à direita do card quando há espaço', () => {
    expect(noteSlot(feature, [feature], size)).toEqual({ x: 924, y: 0 })
  })
  it('vizinho colado à direita: vai para baixo', () => {
    const next = { x: 948, y: 0, w: 500, h: 400 }
    expect(noteSlot(feature, [feature, next], size)).toEqual({ x: 0, y: 424 })
  })
})
