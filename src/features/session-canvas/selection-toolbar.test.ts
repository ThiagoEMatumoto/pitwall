import { describe, expect, it, vi } from 'vitest'

// MapChrome puxa os comandos do mapa, que falam com o main.
vi.mock('@/lib/ipc', () => ({}))

import { Position } from '@xyflow/react'
import { toolbarPositionFor } from './MapChrome'
import { LANE_HEADER_H } from './graph-to-flow'

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
