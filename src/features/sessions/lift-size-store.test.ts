import { beforeEach, describe, expect, it } from 'vitest'
import {
  LIFT_MAX_SAVED,
  LIFT_MIN,
  LIFT_PAD,
  clampLiftSize,
  defaultLiftSize,
  liftSizeOf,
  readLiftSizes,
  resizeLift,
  rememberLiftSize,
  forgetLiftSize,
  LIFT_SIZES_KEY,
} from './lift-size-store'

const VIEW = { w: 1600, h: 1000 }

describe('defaultLiftSize', () => {
  it('é o tamanho de antes: até 1400 de largura (94vw) e 90vh', () => {
    expect(defaultLiftSize(VIEW)).toEqual({ w: 1400, h: 900 })
    expect(defaultLiftSize({ w: 1000, h: 800 })).toEqual({ w: 940, h: 720 })
  })

  it('nunca abaixo do mínimo, nem acima da área útil', () => {
    expect(defaultLiftSize({ w: 500, h: 300 })).toEqual({
      w: 500 - 2 * LIFT_PAD,
      h: 300 - 2 * LIFT_PAD,
    })
  })
})

describe('clampLiftSize', () => {
  it('prende ao mínimo de ~520x320', () => {
    expect(clampLiftSize({ w: 100, h: 50 }, VIEW)).toEqual(LIFT_MIN)
  })

  it('prende à área útil (janela menos o respiro do backdrop)', () => {
    expect(clampLiftSize({ w: 5000, h: 5000 }, VIEW)).toEqual({
      w: VIEW.w - 2 * LIFT_PAD,
      h: VIEW.h - 2 * LIFT_PAD,
    })
  })

  it('arredonda para px inteiros', () => {
    expect(clampLiftSize({ w: 800.6, h: 600.2 }, VIEW)).toEqual({ w: 801, h: 600 })
  })
})

describe('resizeLift', () => {
  const start = { w: 1000, h: 700 }

  it('centrada: puxar a borda direita cresce dos dois lados (a borda segue o ponteiro)', () => {
    expect(resizeLift(start, 'e', 50, 0, VIEW)).toEqual({ w: 1100, h: 700 })
    expect(resizeLift(start, 'w', 50, 0, VIEW)).toEqual({ w: 900, h: 700 })
  })

  it('cantos mexem nos dois eixos', () => {
    expect(resizeLift(start, 'se', 20, 30, VIEW)).toEqual({ w: 1040, h: 760 })
    expect(resizeLift(start, 'nw', 20, 30, VIEW)).toEqual({ w: 960, h: 640 })
    expect(resizeLift(start, 'ne', 20, 30, VIEW)).toEqual({ w: 1040, h: 640 })
    expect(resizeLift(start, 'sw', 20, 30, VIEW)).toEqual({ w: 960, h: 760 })
  })

  it('bordas de um eixo ignoram o outro', () => {
    expect(resizeLift(start, 'n', 99, -10, VIEW)).toEqual({ w: 1000, h: 720 })
    expect(resizeLift(start, 's', 99, 10, VIEW)).toEqual({ w: 1000, h: 720 })
  })

  it('respeita mínimo e máximo', () => {
    expect(resizeLift(start, 'se', -2000, -2000, VIEW)).toEqual(LIFT_MIN)
    expect(resizeLift(start, 'se', 2000, 2000, VIEW)).toEqual({
      w: VIEW.w - 2 * LIFT_PAD,
      h: VIEW.h - 2 * LIFT_PAD,
    })
  })
})

describe('tamanho lembrado por sessão', () => {
  beforeEach(() => localStorage.clear())

  it('sem nada salvo, a sessão abre no padrão', () => {
    expect(liftSizeOf('s1', VIEW)).toEqual(defaultLiftSize(VIEW))
  })

  it('lembra por sessão e outra sessão segue no padrão', () => {
    rememberLiftSize('s1', { w: 800, h: 500 })
    expect(liftSizeOf('s1', VIEW)).toEqual({ w: 800, h: 500 })
    expect(liftSizeOf('s2', VIEW)).toEqual(defaultLiftSize(VIEW))
  })

  it('o salvo é preso à janela atual (monitor menor)', () => {
    rememberLiftSize('s1', { w: 1500, h: 950 })
    expect(liftSizeOf('s1', { w: 1000, h: 700 })).toEqual({
      w: 1000 - 2 * LIFT_PAD,
      h: 700 - 2 * LIFT_PAD,
    })
  })

  it('"Tamanho padrão" esquece a sessão', () => {
    rememberLiftSize('s1', { w: 800, h: 500 })
    forgetLiftSize('s1')
    expect(readLiftSizes()).toEqual({})
    expect(liftSizeOf('s1', VIEW)).toEqual(defaultLiftSize(VIEW))
  })

  it('JSON corrompido ou entradas inválidas = nada salvo', () => {
    localStorage.setItem(LIFT_SIZES_KEY, '{nope')
    expect(readLiftSizes()).toEqual({})
    localStorage.setItem(
      LIFT_SIZES_KEY,
      JSON.stringify({ a: { w: 'x', h: 1 }, b: { w: 700, h: 400 }, c: null }),
    )
    expect(readLiftSizes()).toEqual({ b: { w: 700, h: 400 } })
  })

  it('guarda só as últimas LIFT_MAX_SAVED sessões (a mais recente fica)', () => {
    for (let i = 0; i < LIFT_MAX_SAVED + 5; i++) rememberLiftSize(`s${i}`, { w: 600, h: 400 })
    const saved = readLiftSizes()
    expect(Object.keys(saved)).toHaveLength(LIFT_MAX_SAVED)
    expect(saved[`s${LIFT_MAX_SAVED + 4}`]).toBeDefined()
    expect(saved.s0).toBeUndefined()
  })

  it('re-salvar move a sessão para o fim (não é podada primeiro)', () => {
    for (let i = 0; i < LIFT_MAX_SAVED; i++) rememberLiftSize(`s${i}`, { w: 600, h: 400 })
    rememberLiftSize('s0', { w: 700, h: 400 })
    rememberLiftSize('novo', { w: 600, h: 400 })
    const saved = readLiftSizes()
    expect(saved.s0).toEqual({ w: 700, h: 400 })
    expect(saved.s1).toBeUndefined()
  })
})
