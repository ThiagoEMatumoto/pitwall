import { describe, expect, it } from 'vitest'
import {
  MIN_READABLE_ZOOM,
  OVERVIEW_MIN_ZOOM,
  PRIORITY_MIN_ZOOM,
  offscreenCards,
  planFit,
} from './map-fit'

// Formato do print 01 da rodada 1: canvas ~1490px, Equipe aberta (~390px) e a
// feature cross-project de 3 lanes com ~1900px de largura.
const view = { w: 1490, h: 1100 }
const feature = { x: 0, y: 0, w: 1900, h: 440 }
const loose = { x: 1960, y: 0, w: 640, h: 300 }
const visible = { x: 0, y: 0, w: 2600, h: 440 }
const right = 398

function screenBox(r: typeof feature, v: { x: number; y: number; zoom: number }) {
  return { l: r.x * v.zoom + v.x, r: (r.x + r.w) * v.zoom + v.x }
}

describe('planFit', () => {
  it('feature que não cabe a 0.6 ao lado da Equipe: recolhe o dock e cabe inteira', () => {
    const plan = planFit({
      visible,
      priority: feature,
      view,
      insets: { right, top: 60, left: 50 },
      dockInset: right,
      cardCount: 5,
    })!
    expect(plan.collapseDock).toBe(true)
    const b = screenBox(feature, plan.viewport)
    expect(b.l).toBeGreaterThanOrEqual(50)
    expect(b.r).toBeLessThanOrEqual(view.w)
    expect(plan.viewport.zoom).toBeGreaterThanOrEqual(PRIORITY_MIN_ZOOM)
  })

  it('feature que cabe ao lado da Equipe: desconta o dock e não o recolhe', () => {
    const small = { x: 0, y: 0, w: 900, h: 440 }
    const plan = planFit({
      visible: small,
      priority: small,
      view,
      insets: { right },
      dockInset: right,
      cardCount: 3,
    })!
    expect(plan.collapseDock).toBe(false)
    const b = screenBox(small, plan.viewport)
    expect(b.r).toBeLessThanOrEqual(view.w - right)
  })

  it('a prioridade desce o zoom abaixo de 0.9 só até 0.6', () => {
    const plan = planFit({ visible, priority: feature, view, cardCount: 5 })!
    expect(plan.viewport.zoom).toBeLessThan(MIN_READABLE_ZOOM)
    expect(plan.viewport.zoom).toBeGreaterThanOrEqual(PRIORITY_MIN_ZOOM)
    expect(screenBox(feature, plan.viewport).r).toBeLessThanOrEqual(view.w)
  })

  it('7+ cartões: o conjunto inteiro entra até 0.45, sem ninguém à esquerda do canvas', () => {
    const wide = { x: 0, y: 0, w: 3000, h: 900 }
    const plan = planFit({
      visible: wide,
      priority: { x: 2400, y: 0, w: 600, h: 300 },
      view,
      insets: { left: 50 },
      cardCount: 11,
    })!
    expect(plan.viewport.zoom).toBeGreaterThanOrEqual(OVERVIEW_MIN_ZOOM)
    expect(plan.viewport.zoom).toBeLessThan(0.5)
    expect(screenBox(wide, plan.viewport).l).toBeGreaterThanOrEqual(50)
    expect(screenBox(wide, plan.viewport).r).toBeLessThanOrEqual(view.w)
  })

  it('7+ cartões que não cabem a 0.45 ao lado da Equipe: recolhe o dock', () => {
    const plan = planFit({
      visible: { x: 0, y: 0, w: 2800, h: 600 },
      priority: { x: 0, y: 0, w: 900, h: 300 },
      view,
      insets: { right },
      dockInset: right,
      cardCount: 11,
    })!
    expect(plan.collapseDock).toBe(true)
  })

  it('com alguém precisando de você, nada de visão geral: piso 0.9 e o cartão dele inteiro', () => {
    const urgent = { x: 2400, y: 0, w: 400, h: 300 }
    const plan = planFit({
      visible: { x: 0, y: 0, w: 3000, h: 900 },
      priority: urgent,
      view,
      cardCount: 11,
      needsYou: true,
    })!
    expect(plan.viewport.zoom).toBe(MIN_READABLE_ZOOM)
    const b = screenBox(urgent as typeof feature, plan.viewport)
    expect(b.l).toBeGreaterThanOrEqual(0)
    expect(b.r).toBeLessThanOrEqual(view.w)
  })

  it('6 cartões ou menos mantêm o piso legível de 0.9', () => {
    const plan = planFit({ visible: { x: 0, y: 0, w: 9000, h: 900 }, priority: null, view, cardCount: 6 })!
    expect(plan.viewport.zoom).toBe(MIN_READABLE_ZOOM)
    expect(plan.collapseDock).toBe(false)
  })

  it('sem conteúdo: nada a enquadrar', () => {
    expect(planFit({ visible: null, priority: null, view, cardCount: 0 })).toBeNull()
  })
})

describe('offscreenCards', () => {
  it('conta os cartões fora da área livre e diz de que lado está a maioria', () => {
    const v = { x: 0, y: 0, zoom: 1 }
    const cards = [
      { x: 10, y: 10, w: 200, h: 100 },
      { x: -400, y: 10, w: 200, h: 100 },
      { x: -700, y: 10, w: 200, h: 100 },
      { x: 2000, y: 10, w: 200, h: 100 },
    ]
    expect(offscreenCards(cards, v, view)).toEqual({
      count: 3,
      side: 'left',
      sides: { left: 2, right: 1, top: 0, bottom: 0 },
    })
  })
  it('cartão embaixo do dock conta como fora', () => {
    const v = { x: 0, y: 0, zoom: 1 }
    expect(offscreenCards([{ x: 1200, y: 0, w: 280, h: 100 }], v, view, { right })).toMatchObject({
      count: 1,
      side: 'right',
    })
  })
  it('cartão com mais de 30% sob o dock conta, mesmo com o meio à vista', () => {
    const v = { x: 0, y: 0, zoom: 1 }
    const free = view.w - right
    // 35% do cartão além da borda livre: o meio (65%) ainda está dentro.
    const card = { x: free - 0.65 * 300, y: 0, w: 300, h: 100 }
    expect(offscreenCards([card], v, view, { right })).toMatchObject({
      count: 1,
      side: 'right',
      sides: { right: 1 },
    })
    // 20% fora: ainda é "à vista".
    const near = { x: free - 0.8 * 300, y: 0, w: 300, h: 100 }
    expect(offscreenCards([near], v, view, { right }).count).toBe(0)
  })
  it('tudo à vista: zero', () => {
    expect(offscreenCards([{ x: 0, y: 0, w: 10, h: 10 }], { x: 0, y: 0, zoom: 1 }, view)).toMatchObject({
      count: 0,
      side: null,
    })
  })
})

describe('quebra e minimapa', async () => {
  const { minimapSize, planFit, wrapRowWidth } = await import('./map-fit')
  it('2º passe no resumo: maxZoom segura abaixo do detalhe cheio', () => {
    const plan = planFit({
      visible: { x: 0, y: 0, w: 400, h: 300 },
      priority: null,
      view: { w: 1600, h: 1000 },
      cardCount: 9,
      maxZoom: 0.74,
    })
    expect(plan!.viewport.zoom).toBe(0.74)
  })
  it('a linha de cards é a área livre lida a 0.7, em degraus de 50px', () => {
    expect(wrapRowWidth(1500)).toBe(1950)
    expect(wrapRowWidth(50)).toBeUndefined()
  })
  it('minimapa na proporção do conteúdo, entre 60 e 140px de altura', () => {
    expect(minimapSize({ x: 0, y: 0, w: 2000, h: 1000 })).toEqual({ w: 200, h: 100 })
    expect(minimapSize({ x: 0, y: 0, w: 4000, h: 200 })).toEqual({ w: 200, h: 60 })
    expect(minimapSize({ x: 0, y: 0, w: 500, h: 2000 })).toEqual({ w: 200, h: 140 })
  })
})

describe('piso do painel', () => {
  it('com priorityFloor 0.5 o card da feature desce até caber ao lado do painel', async () => {
    const { planFit } = await import('./map-fit')
    const args = {
      visible: { x: 0, y: 0, w: 1800, h: 200 },
      priority: { x: 0, y: 0, w: 1800, h: 200 },
      view: { w: 1500, h: 1000 },
      insets: { left: 70, right: 400 },
      cardCount: 5,
    }
    expect(planFit(args)!.viewport.zoom).toBe(0.6)
    // Cabe a (1500-470-48)/1800 ≈ 0.546: o piso do painel deixa chegar lá.
    expect(planFit({ ...args, priorityFloor: 0.5 })!.viewport.zoom).toBeCloseTo(982 / 1800, 5)
  })
})

describe('enquadrar com poucas sessões', () => {
  it('sobrando mais de 30% de altura, centraliza na vertical', async () => {
    const { planFit } = await import('./map-fit')
    const plan = planFit({
      visible: { x: 0, y: 0, w: 1000, h: 300 },
      priority: null,
      view: { w: 1600, h: 1000 },
      insets: { top: 60 },
      cardCount: 5,
    })!
    const free = 1000 - 60
    const h = 300 * plan.viewport.zoom
    expect(plan.viewport.y).toBeCloseTo(60 + (free - h) / 2, 5)
  })
  it('conteúdo alto: continua encostado no topo', async () => {
    const { planFit } = await import('./map-fit')
    const plan = planFit({
      visible: { x: 0, y: 0, w: 1000, h: 800 },
      priority: null,
      view: { w: 1600, h: 1000 },
      cardCount: 5,
    })!
    expect(plan.viewport.y).toBe(24)
  })
})
