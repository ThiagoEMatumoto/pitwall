import { describe, expect, it } from 'vitest'
import {
  MAP_MAX_VISIBLE,
  PEEK_HEADER_HEIGHT,
  TOAST_MARGIN,
  toastStackPlacement,
  type PeekBox,
  type ToastPlacement,
} from './toast-placement'

// Painel do peek: w-[56rem] centralizado, h-[88vh].
const peekAt = (vw: number, vh: number) => {
  const width = Math.min(896, vw * 0.92)
  const height = vh * 0.88
  return { left: (vw - width) / 2, top: (vh - height) / 2, width, height }
}

describe('toastStackPlacement', () => {
  it('sem peek: canto inferior direito, recuada pelo Crew Dock', () => {
    expect(toastStackPlacement({ dockWidth: 360, peek: null, viewportWidth: 1600 })).toEqual({
      right: 360 + TOAST_MARGIN,
      bottom: TOAST_MARGIN,
      zIndex: 50,
    })
  })

  it('peek aberto em janela larga: pilha no respiro à direita, acima do backdrop, sem invadir o painel', () => {
    const peek = peekAt(2000, 1286)
    const p = toastStackPlacement({ dockWidth: 480, peek, viewportWidth: 2000 })
    expect(p.zIndex).toBeGreaterThan(1000)
    expect(p.right).toBe(TOAST_MARGIN)
    const leftEdge = 2000 - p.right - (p.maxWidth ?? 0)
    expect(leftEdge).toBeGreaterThanOrEqual(peek.left + peek.width)
  })

  it('peek sem respiro lateral: pilha no topo do transcript, longe do input de resposta', () => {
    const peek = peekAt(1000, 800)
    const p = toastStackPlacement({ dockWidth: 360, peek, viewportWidth: 1000 })
    expect(p.bottom).toBeUndefined()
    expect(p.top).toBe(peek.top + PEEK_HEADER_HEIGHT)
    expect(p.zIndex).toBeGreaterThan(1000)
  })

  it('mapa visível: a pilha sobe pra cima do minimapa em vez de cobri-lo', () => {
    const minimap = { left: 1020, top: 760, width: 200, height: 150 }
    expect(
      toastStackPlacement({
        dockWidth: 360,
        peek: null,
        viewportWidth: 1600,
        viewportHeight: 925,
        minimap,
      }),
    ).toEqual({ right: 360 + TOAST_MARGIN, bottom: 925 - 760 + TOAST_MARGIN, zIndex: 50 })
  })

  it('minimapa longe da coluna da pilha não muda nada', () => {
    const minimap = { left: 10, top: 760, width: 200, height: 150 }
    expect(
      toastStackPlacement({
        dockWidth: 0,
        peek: null,
        viewportWidth: 1600,
        viewportHeight: 925,
        minimap,
      }).bottom,
    ).toBe(TOAST_MARGIN)
  })

  it('vista Terminais: a pilha sobe pra cima do composer dock em vez de cobrir o campo', () => {
    const composer = { left: 460, top: 1080, width: 1150, height: 200 }
    expect(
      toastStackPlacement({
        dockWidth: 390,
        peek: null,
        viewportWidth: 2000,
        viewportHeight: 1286,
        obstacles: [composer],
      }).bottom,
    ).toBe(1286 - 1080 + TOAST_MARGIN)
  })
})

// Caixa que a pilha ocupa na tela (aprox.: coluna de 320px, 1 toast de 64px ou
// só o "+N" de 28px), pra assertar interseção com a modal.
function stackBox(p: ToastPlacement, vw: number, vh: number): PeekBox {
  const width = p.maxWidth ?? 320
  const height = p.maxVisible === 0 ? 28 : 64
  const left = vw - p.right - width
  const top = p.top !== undefined ? p.top : vh - (p.bottom ?? 0) - height
  return { left, top, width, height }
}
const overlaps = (a: PeekBox, b: PeekBox) =>
  a.left < b.left + b.width &&
  b.left < a.left + a.width &&
  a.top < b.top + b.height &&
  b.top < a.top + a.height

// Modal do mapa: até 1400px × 90vh, centralizada.
const liftAt = (vw: number, vh: number) => {
  const width = Math.min(1400, vw * 0.94)
  const height = vh * 0.9
  return { left: (vw - width) / 2, top: (vh - height) / 2, width, height }
}

describe('toastStackPlacement — modal do terminal e mapa', () => {
  it.each([
    [2400, 1300],
    [1600, 900],
    [1280, 720],
    [1000, 560],
  ])('modal aberta em %ix%i: a pilha nunca intersecta a modal', (vw, vh) => {
    const peek = liftAt(vw, vh)
    const p = toastStackPlacement({
      dockWidth: 360,
      peek,
      viewportWidth: vw,
      viewportHeight: vh,
      lift: true,
      onMap: true,
    })
    expect(p.zIndex).toBeGreaterThan(1000)
    expect(p.hidden || !overlaps(stackBox(p, vw, vh), peek)).toBe(true)
  })

  it('modal sem respiro lateral: só o "+N"', () => {
    const p = toastStackPlacement({
      dockWidth: 0,
      peek: liftAt(1280, 720),
      viewportWidth: 1280,
      viewportHeight: 720,
      lift: true,
    })
    expect(p.maxVisible).toBe(0)
  })

  it('o "+N" vai pra faixa ABAIXO da modal: a de cima é a barra de título (fechar/maximizar)', () => {
    const p = toastStackPlacement({
      dockWidth: 0,
      peek: liftAt(1280, 720),
      viewportWidth: 1280,
      viewportHeight: 720,
      lift: true,
    })
    expect(p.top).toBeUndefined()
    expect(p.bottom).toBeGreaterThan(0)
  })

  it('janela pequena em que nem o "+N" cabe fora da modal: pilha escondida', () => {
    const p = toastStackPlacement({
      dockWidth: 0,
      peek: liftAt(1000, 560),
      viewportWidth: 1000,
      viewportHeight: 560,
      lift: true,
    })
    expect(p.hidden).toBe(true)
  })

  it('no mapa empilha no máximo 2', () => {
    const p = toastStackPlacement({ dockWidth: 0, peek: null, viewportWidth: 1600, onMap: true })
    expect(p.maxVisible).toBe(MAP_MAX_VISIBLE)
    expect(MAP_MAX_VISIBLE).toBe(2)
  })

  it('painel da feature aberto à direita: a pilha sai da frente dele', () => {
    const panel = { left: 1600 - 420, top: 40, width: 420, height: 860 }
    const p = toastStackPlacement({
      dockWidth: 0,
      peek: null,
      viewportWidth: 1600,
      rightPanel: panel,
    })
    expect(p.right).toBe(420 + TOAST_MARGIN)
  })
})
