import { describe, expect, it } from 'vitest'
import { clippedBackgroundCount, clippedCount } from './strip-overflow'

describe('clippedCount', () => {
  const bounds = { left: 0, right: 500 }
  it('conta os chips cortados de cada lado; o parcialmente visível conta', () => {
    const chips = [
      { left: -120, right: -10 },
      { left: 0, right: 120 },
      { left: 400, right: 520 },
      { left: 530, right: 640 },
    ]
    expect(clippedCount(bounds, chips)).toMatchObject({ left: 1, right: 2 })
  })
  it('tolerância de 1px de arredondamento', () => {
    expect(clippedCount(bounds, [{ left: -0.5, right: 500.5 }])).toEqual({
      left: 0,
      right: 0,
      hidden: [],
    })
  })
  it('cortado sem espaço para ícone + 4 letras some inteiro; com espaço fica (com fade)', () => {
    const chips = [
      { left: 300, right: 420 },
      { left: 380, right: 520 },
      { left: 470, right: 590 },
      { left: 600, right: 700 },
    ]
    expect(clippedCount(bounds, chips)).toEqual({ left: 0, right: 3, hidden: [2, 3] })
  })
})

describe('clippedBackgroundCount', () => {
  it('chip agregado cortado soma as filhas dele do lado cortado; inteiro na barra não soma', () => {
    const groups = [
      { left: -40, right: 50, count: 2 },
      { left: 100, right: 190, count: 5 },
      { left: 450, right: 540, count: 1 },
      { left: 560, right: 650, count: 3 },
    ]
    expect(clippedBackgroundCount({ left: 0, right: 500 }, groups)).toEqual({ left: 2, right: 4 })
  })
})
