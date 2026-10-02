import { describe, expect, it } from 'vitest'
import {
  MIN_READABLE_ZOOM,
  MOTHER_READ_ZOOM,
  OVERVIEW_MIN_ZOOM,
  PRIORITY_MIN_ZOOM,
  followBarHeight,
  offscreenCards,
  pillSpot,
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
    const plan = planFit({
      visible: { x: 0, y: 0, w: 9000, h: 900 },
      priority: null,
      view,
      cardCount: 6,
    })!
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
      hidden: [
        { index: 1, side: 'left' },
        { index: 2, side: 'left' },
        { index: 3, side: 'right' },
      ],
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
  it('minimapa é obstáculo de canto, não faixa: cartão ao lado dele, à vista, não conta', () => {
    const v = { x: 0, y: 0, zoom: 1 }
    // Print 08 da rodada 4: o cartão da base à esquerda, minimapa no canto direito.
    const minimap = { x: 1250, y: 940, w: 220, h: 150 }
    const beside = { x: 100, y: 960, w: 330, h: 80 }
    expect(offscreenCards([beside], v, view, {}, [minimap]).count).toBe(0)
    // O mesmo cartão embaixo do minimapa conta.
    const under = { x: 1200, y: 960, w: 260, h: 80 }
    expect(offscreenCards([under], v, view, {}, [minimap])).toMatchObject({ count: 1 })
  })
  it('tudo à vista: zero', () => {
    expect(
      offscreenCards([{ x: 0, y: 0, w: 10, h: 10 }], { x: 0, y: 0, zoom: 1 }, view),
    ).toMatchObject({
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
  it('com o piso do painel (0.7) o card não desce ao zoom ilegível nem centraliza', async () => {
    const { planFit, PANEL_MIN_ZOOM } = await import('./map-fit')
    expect(PANEL_MIN_ZOOM).toBe(0.7)
    const plan = planFit({
      visible: { x: 0, y: 0, w: 1800, h: 400 },
      priority: { x: 0, y: 0, w: 1800, h: 200 },
      view: { w: 1500, h: 1000 },
      insets: { top: 60, left: 70, right: 400 },
      cardCount: 5,
      priorityFloor: PANEL_MIN_ZOOM,
      alignTop: true,
    })!
    expect(plan.viewport.zoom).toBe(0.7)
    // Encostado no topo (60 da barra + 24 de respiro), não no meio da altura.
    expect(plan.viewport.y).toBe(84)
    // O canto do card da feature no canto livre (a esquerda dele à vista).
    expect(plan.viewport.x).toBe(70 + 24)
  })
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
  it('priorityFits diz se a feature coube: falso no piso 0.7, verdadeiro no piso do resumo', async () => {
    const { planFit, PANEL_MIN_ZOOM, PANEL_COMPACT_MIN_ZOOM } = await import('./map-fit')
    // Print 07 da rodada 2: a feature em resumo tem ~1090px e sobram ~600px ao lado do painel.
    const args = {
      visible: { x: 0, y: 0, w: 1090, h: 500 },
      priority: { x: 0, y: 0, w: 1090, h: 250 },
      view: { w: 667, h: 1100 },
      insets: { top: 60, left: 55, right: 8 },
      cardCount: 5,
      maxZoom: 0.72,
      alignTop: true,
    }
    expect(planFit({ ...args, priorityFloor: PANEL_MIN_ZOOM })!.priorityFits).toBe(false)
    const low = planFit({ ...args, priorityFloor: PANEL_COMPACT_MIN_ZOOM })!
    expect(low.priorityFits).toBe(true)
    expect(low.viewport.zoom).toBeGreaterThanOrEqual(PANEL_COMPACT_MIN_ZOOM)
    expect(low.viewport.zoom).toBeLessThan(PANEL_MIN_ZOOM)
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
  // Rodada 2 (prints 05/06): a feature larga de 3 raias, limitada pela largura,
  // nascia no meio da altura com ~385px vazios em cima. A barra termina em
  // insets.top - 8 (INSET_GAP do SessionMap): o conteúdo tem de começar 32px abaixo.
  const INSET_GAP = 8
  const wideFeature = { x: 0, y: 0, w: 1900, h: 440 }
  const toolbarBottom = 52
  const contentTop = (v: { y: number; zoom: number }) => wideFeature.y * v.zoom + v.y
  it('limitado pela largura (Enquadrar): encosta 32px abaixo da barra, sem centralizar', async () => {
    const { planFit } = await import('./map-fit')
    const plan = planFit({
      visible: wideFeature,
      priority: wideFeature,
      view: { w: 1700, h: 1100 },
      insets: { top: toolbarBottom + INSET_GAP, left: 70 },
      cardCount: 5,
    })!
    expect(contentTop(plan.viewport) - toolbarBottom).toBe(32)
  })
  it('limitado pela largura com a Equipe aberta (enquadrar automático): também no topo', async () => {
    const { planFit } = await import('./map-fit')
    const plan = planFit({
      visible: wideFeature,
      priority: wideFeature,
      view: { w: 1700, h: 1100 },
      insets: { top: toolbarBottom + INSET_GAP, left: 70, right: 400 },
      dockInset: 0,
      cardCount: 5,
    })!
    expect(plan.collapseDock).toBe(false)
    expect(contentTop(plan.viewport) - toolbarBottom).toBe(32)
  })
  it('no teto do resumo (maxZoom 0.72) também encosta no topo', async () => {
    const { planFit } = await import('./map-fit')
    const plan = planFit({
      visible: { x: 0, y: 0, w: 1000, h: 300 },
      priority: null,
      view: { w: 1600, h: 1000 },
      insets: { top: toolbarBottom + INSET_GAP },
      cardCount: 5,
      maxZoom: 0.72,
    })!
    expect(plan.viewport.zoom).toBe(0.72)
    expect(plan.viewport.y - toolbarBottom).toBe(32)
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

describe('pillSpot', () => {
  const box = { l: 70, t: 60, r: 1490, b: 1100 }
  const size = { w: 200, h: 24 }
  it('colado na borda do lado, no meio dela quando não cruza nenhum frame', () => {
    const p = pillSpot('right', box, [], size)!
    expect(p.x).toBe(1490 - 12 - 200)
    expect(p.y).toBe(60 + 0.5 * 1040 - 12)
  })
  it('desvia da borda de um frame (print 01 da rodada 4: a borda da feature no meio)', () => {
    // Frame cuja borda de baixo passa no meio da altura livre.
    const feature = { x: 100, y: 100, w: 1500, h: 480 }
    const p = pillSpot('right', box, [feature], size)!
    const pill = { t: p.y, b: p.y + size.h }
    // Nem encosta na borda de baixo (580) nem na de cima (100).
    expect(pill.b < 100 - 8 || pill.t > 580 + 8 || (pill.t > 108 && pill.b < 572)).toBe(true)
    expect(p.y).not.toBe(60 + 0.5 * 1040 - 12)
  })
  it('com alvo: na faixa do cartão oculto, colado à borda livre a 12px', () => {
    // Print 07: o cartão cortado sob o painel em y~405; o pill flutuava em y~765.
    const hidden = { x: 1400, y: 380, w: 300, h: 50 }
    const p = pillSpot('right', box, [{ x: 100, y: 100, w: 1500, h: 480 }], size, hidden)!
    expect(p.x).toBe(1490 - 12 - 200)
    // Colado logo acima ou abaixo da parte visível dele, sem cobri-la (rodada 2 do
    // pulso: o pill na faixa escondia "Inclui os e2e?" da marina, meio à vista).
    const pill = { t: p.y, b: p.y + size.h }
    expect(pill.b <= hidden.y || pill.t >= hidden.y + hidden.h).toBe(true)
    expect(Math.min(Math.abs(pill.b - hidden.y), Math.abs(pill.t - hidden.y - hidden.h))).toBeLessThanOrEqual(12)
  })
  it('com alvo e um cartão à vista na faixa dele: vai para o ponto livre mais perto, sem cobrir o nome', () => {
    // Print 07 da rodada 2: o pill na faixa da marina cobria o título do otavio.
    const hidden = { x: 1400, y: 380, w: 300, h: 50 }
    const otavio = { x: 1100, y: 380, w: 300, h: 50 }
    const header = { x: 100, y: 330, w: 1500, h: 40 }
    const p = pillSpot('right', box, [], size, hidden, [otavio, header])!
    const pill = { l: p.x, t: p.y, r: p.x + size.w, b: p.y + size.h }
    for (const o of [otavio, header])
      expect(pill.l < o.x + o.w && pill.r > o.x && pill.t < o.y + o.h && pill.b > o.y).toBe(false)
    expect(p.x).toBe(1490 - 12 - 200)
    // A faixa livre logo abaixo do cartão (430 + 4 de folga), não o fim da tela.
    expect(p.y).toBeGreaterThanOrEqual(434)
    expect(p.y).toBeLessThan(450)
  })
  it('com alvo e nenhum ponto livre na borda: fica na faixa do alvo', () => {
    const hidden = { x: 1400, y: 380, w: 300, h: 50 }
    const wall = { x: 1200, y: 0, w: 300, h: 2000 }
    const p = pillSpot('right', box, [], size, hidden, [wall])!
    expect(p.y + size.h / 2).toBe(405)
  })
  it('com alvo fora da faixa útil: preso à área livre', () => {
    const p = pillSpot('right', box, [], size, { x: 1600, y: -300, w: 300, h: 100 })!
    expect(p.y).toBe(60 + 12)
  })
  it('topo: centrado na horizontal, logo abaixo da barra', () => {
    expect(pillSpot('top', box, [], size)).toEqual({ x: 70 + 0.5 * 1420 - 100, y: 72 })
  })

  // Print 03 do F (rodada 3): sem ponto livre na borda, o pill caía em cima do
  // cartão que o F acabara de enquadrar.
  const framed = { x: 300, y: 100, w: 1170, h: 900 }
  const overlapsFramed = (p: { x: number; y: number }) =>
    p.x < framed.x + framed.w &&
    p.x + size.w > framed.x &&
    p.y < framed.y + framed.h &&
    p.y + size.h > framed.y
  it('cartão enquadrado pelo F: com alvo, o pill sai do retângulo dele', () => {
    const hidden = { x: 1400, y: 380, w: 300, h: 50 }
    const p = pillSpot('right', box, [], size, hidden, [framed], framed)!
    expect(overlapsFramed(p)).toBe(false)
    expect(p.x).toBe(1490 - 12 - 200)
  })
  it('cartão enquadrado pelo F: sem alvo, idem', () => {
    const p = pillSpot('right', box, [], size, null, [], framed)!
    expect(overlapsFramed(p)).toBe(false)
  })
  it('o cartão enquadrado toma a borda inteira do lado, mas sobra área livre: o pill vai para ela', () => {
    // O F enche a altura do mapa: a borda direita inteira é cartão. Sem cair fora
    // dela, o aviso de "fora da vista" sumia justo com o zoom no cartão.
    const tall = { x: 400, y: 0, w: 1200, h: 1200 }
    for (const target of [{ x: 1600, y: 380, w: 300, h: 50 }, null]) {
      const p = pillSpot('right', box, [], size, target, [], tall)!
      expect(p).not.toBeNull()
      expect(
        p.x < tall.x + tall.w &&
          p.x + size.w > tall.x &&
          p.y < tall.y + tall.h &&
          p.y + size.h > tall.y,
      ).toBe(false)
      expect(p.x + size.w).toBeLessThanOrEqual(box.r)
      expect(p.y + size.h).toBeLessThanOrEqual(box.b)
    }
  })
  it('o cartão enquadrado cobre a área livre inteira: sem pill (null), nunca por cima', () => {
    const wall = { x: 100, y: 0, w: 1500, h: 1200 }
    expect(pillSpot('right', box, [], size, { x: 1600, y: 380, w: 300, h: 50 }, [], wall)).toBeNull()
    expect(pillSpot('right', box, [], size, null, [], wall)).toBeNull()
  })
})

describe('contentInView', async () => {
  const { contentInView } = await import('./map-fit')
  const size = { width: 1400, height: 1000 }
  it('tudo dentro da tela: true (o minimapa some)', () => {
    expect(contentInView({ x: 0, y: 0, w: 1000, h: 700 }, [100, 50, 1], size)).toBe(true)
    expect(contentInView({ x: 0, y: 0, w: 2000, h: 1400 }, [0, 0, 0.6], size)).toBe(true)
  })
  it('algo fora (zoom maior ou pan): false', () => {
    expect(contentInView({ x: 0, y: 0, w: 2000, h: 1400 }, [0, 0, 1], size)).toBe(false)
    expect(contentInView({ x: 0, y: 0, w: 1000, h: 700 }, [-50, 0, 1], size)).toBe(false)
  })
  it('sem conteúdo ou sem medida: true', () => {
    expect(contentInView(null, [0, 0, 1], size)).toBe(true)
    expect(contentInView({ x: 0, y: 0, w: 10, h: 10 }, [0, 0, 1], { width: 0, height: 0 })).toBe(true)
  })
})

// Visão geral (7+ cartões) com uma mãe: o piso de leitura dela (0.88) não pode
// vencer o da visão geral, senão o Enquadrar mostra só a feature dela.
describe('planFit com mãe em visão geral', () => {
  const view = { w: 1400, h: 900 }
  const cards = [0, 1, 2, 3].map((i) => ({ x: i * 900, y: 0, w: 860, h: 700 }))
  const visible = { x: 0, y: 0, w: 4 * 900 - 40, h: 700 }
  const mother = { x: 20, y: 20, w: 520, h: 420 }

  it('com 7+ cartões mantém o zoom da visão geral e a mãe dentro da vista', () => {
    const plan = planFit({ visible, priority: cards[0], view, cardCount: 15, mother })!
    expect(plan.viewport.zoom).toBeLessThan(0.6)
    expect(plan.viewport.zoom).toBeGreaterThanOrEqual(OVERVIEW_MIN_ZOOM)
    const l = mother.x * plan.viewport.zoom + plan.viewport.x
    const r = (mother.x + mother.w) * plan.viewport.zoom + plan.viewport.x
    expect(l).toBeGreaterThanOrEqual(0)
    expect(r).toBeLessThanOrEqual(view.w)
  })

  it('com poucos cartões a mãe continua com o piso de leitura', () => {
    const plan = planFit({ visible, priority: cards[0], view, cardCount: 4, mother })!
    expect(plan.viewport.zoom).toBeGreaterThanOrEqual(0.88 - 1e-6)
  })
})

// Mãe no painel ao lado do mapa: o mapa mede só o que sobra (o painel é um irmão
// no flex) e o enquadrar não recebe a mãe — o piso de leitura dela (0.88) deixava
// a feature cortada na faixa estreita que sobra ao lado do painel.
describe('planFit com a mãe no painel', () => {
  const row = 2000
  const panel = Math.round(row * 0.55)
  const view = { w: row - panel, h: 900 }
  const feature = { x: 0, y: 0, w: 1600, h: 500 }
  const mother = { x: 20, y: 40, w: 640, h: 420 }

  it('sem a mãe (ela está no painel), a feature desce até o piso da prioridade', () => {
    const plan = planFit({ visible: feature, priority: feature, view, cardCount: 4, mother: null })!
    expect(plan.viewport.zoom).toBeLessThan(MOTHER_READ_ZOOM)
    expect(plan.viewport.zoom).toBeGreaterThanOrEqual(PRIORITY_MIN_ZOOM)
  })

  it('com a mãe no mapa, o piso dela seguraria o zoom', () => {
    const plan = planFit({ visible: feature, priority: feature, view, cardCount: 4, mother })!
    expect(plan.viewport.zoom).toBeGreaterThanOrEqual(MOTHER_READ_ZOOM - 1e-6)
  })
})

// Com outra feature acima do card em foco, o enquadrar que desce até a mãe dele
// não pode deixar o cabeçalho do card (nome da feature) atrás da barra do topo.
describe('planFit com a mãe no card em foco: o cabeçalho do card fica à vista', () => {
  // Outra feature acima do card em foco: o enquadrar desce até a mãe dele.
  const view = { w: 760, h: 1000 }
  const insets = { top: 120, left: 50 }
  const visible = { x: 0, y: 0, w: 1400, h: 2600 }
  const card = { x: 0, y: 900, w: 1400, h: 1600 }
  const mother = { x: 20, y: 970, w: 640, h: 420 }

  it('a borda de cima do card fica abaixo do inset superior', () => {
    const plan = planFit({ visible, priority: card, view, insets, cardCount: 4, mother })!
    const { y, zoom } = plan.viewport
    expect(card.y * zoom + y).toBeGreaterThanOrEqual(insets.top)
    // A mãe segue inteira na vista.
    expect((mother.y + mother.h) * zoom + y).toBeLessThanOrEqual(view.h)
  })
})

// O "+N avisos" entra na barra segundos depois do enquadrar: ela quebra em 2
// linhas e cobria o cabeçalho do cartão enquadrado. O conteúdo acompanha a borda
// de baixo da barra.
describe('followBarHeight', () => {
  const vp = { x: 10, y: 50, zoom: 0.8 }
  it('barra cresce/encolhe: desloca o y pelo mesmo tanto', () => {
    expect(followBarHeight(vp, 44, 84)).toEqual({ x: 10, y: 90, zoom: 0.8 })
    expect(followBarHeight(vp, 84, 44)).toEqual({ x: 10, y: 10, zoom: 0.8 })
  })
  it('sem altura anterior ou sem mudança, não mexe', () => {
    expect(followBarHeight(vp, null, 84)).toBeNull()
    expect(followBarHeight(vp, 44, 44)).toBeNull()
  })
})
