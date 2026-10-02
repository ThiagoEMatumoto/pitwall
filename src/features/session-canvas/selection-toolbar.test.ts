import { describe, expect, it, vi } from 'vitest'

// MapChrome puxa os comandos do mapa, que falam com o main.
vi.mock('@/lib/ipc', () => ({}))

import { Position } from '@xyflow/react'
import { toolbarPositionFor } from './MapChrome'
import { LANE_HEADER_H } from './graph-to-flow'
import { headerBoxes, intersects, toolbarSideAtZoom, toolbarSideAvoiding } from './selection-toolbar'

describe('toolbarPositionFor', () => {
  it('1º cartão da lane: vira pra baixo (acima mora o cabeçalho da lane)', () => {
    expect(toolbarPositionFor({ parentId: 'lane:r', position: { y: LANE_HEADER_H } })).toBe(
      Position.Bottom,
    )
  })

  it('cartão com outro acima na mesma lane: fica em cima', () => {
    expect(toolbarPositionFor({ parentId: 'lane:r', position: { y: LANE_HEADER_H + 316 } })).toBe(
      Position.Top,
    )
  })

  it('cartão solto (sem lane) e seleção vazia: em cima', () => {
    expect(toolbarPositionFor({ position: { y: 0 } })).toBe(Position.Top)
    expect(toolbarPositionFor(undefined)).toBe(Position.Top)
  })
})

describe('toolbarSideAvoiding (anti-colisão com cabeçalhos)', () => {
  const CLEAR = 44
  // Card da feature em (0,0) com cabeçalho de 30; lane de repo dentro em (12,30).
  const headers = headerBoxes(
    [
      { type: 'feature', box: { x: 0, y: 0, w: 600, h: 400 }, headerH: 56 },
      { type: 'lane', box: { x: 12, y: 56, w: 272, h: 300 } },
      { type: 'session', box: { x: 24, y: 86, w: 248, h: 40 } },
    ],
    30,
  )

  it('só nós-contêiner têm cabeçalho', () => {
    expect(headers).toHaveLength(2)
    expect(headers[0]).toEqual({ x: 0, y: 0, w: 600, h: 56 })
  })

  it('1º cartão da lane: acima colide com o cabeçalho → vai pra baixo', () => {
    const card = { x: 24, y: 86, w: 248, h: 40 }
    expect(toolbarSideAvoiding(card, headers, CLEAR)).toBe('bottom')
    const above = { x: 24, y: 86 - CLEAR, w: 248, h: CLEAR }
    expect(headers.some((h) => intersects(above, h))).toBe(true)
  })

  it('cartão mais abaixo na lane: fica em cima, sem intersectar nenhum cabeçalho', () => {
    const card = { x: 24, y: 300, w: 248, h: 40 }
    expect(toolbarSideAvoiding(card, headers, CLEAR)).toBe('top')
  })

  it('toolbar mais larga que o cartão também conta (invade a lane vizinha)', () => {
    const neighbour = headerBoxes([{ type: 'userGroup', box: { x: 300, y: 200, w: 200, h: 200 } }], 30)
    const card = { x: 40, y: 240, w: 248, h: 40 }
    expect(toolbarSideAvoiding(card, neighbour, CLEAR)).toBe('top')
    expect(toolbarSideAvoiding(card, neighbour, CLEAR, 400)).toBe('bottom')
  })

  it('o cabeçalho do próprio nó selecionado (grupo) não conta', () => {
    const group = { x: 300, y: 200, w: 200, h: 200 }
    expect(toolbarSideAvoiding(group, headerBoxes([{ type: 'userGroup', box: group }], 30), CLEAR)).toBe('top')
  })
})

describe('toolbarSideAtZoom (toolbar de tamanho fixo na tela)', () => {
  const screen = { clearance: 44, minW: 180 }
  // Cabeçalho que termina em y=100; cartão 60 unidades abaixo.
  const headers = [{ x: 0, y: 40, w: 600, h: 60 }]
  const card = { x: 24, y: 160, w: 248, h: 40 }

  it('a zoom 1 a toolbar (44) cabe no vão de 60: fica em cima', () => {
    expect(toolbarSideAtZoom(card, headers, 1, screen)).toBe('top')
  })

  it('a zoom 0,5 ela ocupa 88 unidades e cobriria o cabeçalho: vai pra baixo', () => {
    expect(toolbarSideAtZoom(card, headers, 0.5, screen)).toBe('bottom')
  })
})
