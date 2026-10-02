import { describe, expect, it } from 'vitest'
import {
  MAP_MAX_VISIBLE,
  barPillPadding,
  TOAST_COLUMN_W,
  TOAST_EST_H,
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

  it('sem faixa embaixo da modal, o "+N" não sobe para a barra de título', () => {
    const peek = { ...liftAt(1280, 720), top: 60 }
    peek.height = 720 - peek.top - 2
    const p = toastStackPlacement({
      dockWidth: 0,
      peek,
      viewportWidth: 1280,
      viewportHeight: 720,
      lift: true,
    })
    expect(p.hidden).toBe(true)
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

// Coluna real da pilha (max-w-xs) e altura de 2 toasts do mapa: a caixa que não
// pode encostar no cartão da mãe nem na coluna fixada.
function mapStackBox(p: ToastPlacement, vw: number, vh: number): PeekBox {
  const width = p.maxWidth ?? TOAST_COLUMN_W
  const height = p.maxVisible === 1 ? TOAST_EST_H : MAP_MAX_VISIBLE * TOAST_EST_H
  const left = vw - p.right - width
  const top = p.top !== undefined ? p.top : vh - (p.bottom ?? 0) - height
  return { left, top, width, height }
}

describe('toastStackPlacement — cartão da mãe e coluna fixada', () => {
  const vw = 1600
  const vh = 925
  const base = { dockWidth: 0, peek: null, viewportWidth: vw, viewportHeight: vh, onMap: true }

  it('mãe embaixo à direita: a pilha sobe para cima do cartão', () => {
    const mother = { left: 1000, top: 420, width: 576, height: 400 }
    const p = toastStackPlacement({ ...base, obstacles: [mother] })
    expect(overlaps(mapStackBox(p, vw, vh), mother)).toBe(false)
    expect(p.bottom).toBe(vh - mother.top + TOAST_MARGIN)
  })

  it('mãe no alto à direita: a pilha fica no canto, embaixo dela (subir sairia da tela)', () => {
    const mother = { left: 1000, top: 40, width: 576, height: 420 }
    const p = toastStackPlacement({ ...base, obstacles: [mother] })
    expect(p.bottom).toBe(TOAST_MARGIN)
    expect(overlaps(mapStackBox(p, vw, vh), mother)).toBe(false)
  })

  it('mãe no meio e minimapa no canto: a pilha cabe no vão entre os dois', () => {
    const mother = { left: 1100, top: 60, width: 480, height: 380 }
    const minimap = { left: 1380, top: 760, width: 200, height: 150 }
    const p = toastStackPlacement({ ...base, obstacles: [mother], minimap })
    const box = mapStackBox(p, vw, vh)
    expect(overlaps(box, mother)).toBe(false)
    expect(overlaps(box, minimap)).toBe(false)
    expect(p.bottom).toBe(vh - minimap.top + TOAST_MARGIN)
  })

  it('mãe ocupa a coluna de cima a baixo: a pilha vai para a esquerda dela', () => {
    const mother = { left: 900, top: 10, width: 680, height: 900 }
    const p = toastStackPlacement({ ...base, obstacles: [mother] })
    const box = mapStackBox(p, vw, vh)
    expect(overlaps(box, mother)).toBe(false)
    expect(box.left).toBeGreaterThanOrEqual(0)
  })

  it('a pilha não cobre a barra de ações nem o composer da mãe (o cartão inteiro é obstáculo)', () => {
    // Cartão da mãe que encosta só pela borda esquerda na coluna da pilha.
    const mother = { left: vw - 16 - 330, top: 500, width: 700, height: 420 }
    const p = toastStackPlacement({ ...base, obstacles: [mother] })
    expect(overlaps(mapStackBox(p, vw, vh), mother)).toBe(false)
  })

  it('coluna da mãe fixada (janela estreita, dock até a coluna da pilha): a pilha sai de cima', () => {
    const narrow = 760
    const dock = { left: 0, top: 40, width: 460, height: vh - 40 }
    const p = toastStackPlacement({ ...base, viewportWidth: narrow, obstacles: [dock] })
    expect(overlaps(mapStackBox(p, narrow, vh), dock)).toBe(false)
  })

  it('obstáculo à direita da coluna (sob o Crew Dock) não empurra a pilha', () => {
    const under = { left: 1500, top: 600, width: 100, height: 300 }
    const p = toastStackPlacement({ ...base, dockWidth: 120, obstacles: [under] })
    expect(p.bottom).toBe(TOAST_MARGIN)
  })
})

// Mapa estreito (painel da mãe/da feature aberto): print 03 da rodada 3, os dois
// avisos de despacho cobriam o cartão da filha enquadrada. Aí os cartões são
// obstáculos e nada pode ser coberto: sem vão, a pilha vira o "+N avisos" na barra.
describe('toastStackPlacement — mapa estreito', () => {
  const vw = 2000
  const vh = 1286
  const bar = { left: 1258, top: 106, width: 685, height: 126 }
  const base = {
    dockWidth: 0,
    peek: null,
    viewportWidth: vw,
    viewportHeight: vh,
    onMap: true,
    narrowMap: true,
    mapBar: bar,
  }

  it('com vão para 2 avisos, empilha 2 nele sem cobrir cartão', () => {
    const card = { left: 1360, top: 240, width: 550, height: 500 }
    const p = toastStackPlacement({ ...base, obstacles: [card] })
    expect(p.maxVisible).toBe(MAP_MAX_VISIBLE)
    expect(overlaps(mapStackBox(p, vw, vh), card)).toBe(false)
  })

  it('com vão só para 1, mostra 1 (não vai para o lado, onde há outros cartões)', () => {
    const top = { left: 1360, top: 240, width: 550, height: 860 }
    const p = toastStackPlacement({ ...base, obstacles: [top] })
    expect(p.maxVisible).toBe(1)
    expect(overlaps(mapStackBox(p, vw, vh), top)).toBe(false)
    expect(p.right).toBe(TOAST_MARGIN)
  })

  // Com 2+ avisos o "+N" sobe junto, acima do card visível (flex-col): o vão de
  // 1 tem de comportá-lo, senão ele cai em cima do cartão de cima.
  it('vão que só cabe 1 toast sem o "+N": vai para a barra, não cobre o cartão', () => {
    const card = { left: 1360, top: 240, width: 550, height: 894 }
    const p = toastStackPlacement({ ...base, obstacles: [card] })
    expect(p.maxVisible).toBe(0)
    expect(p.expandable).toBe(true)
  })

  it('sem vão nenhum: colapsa no "+N avisos" na barra do mapa, expansível', () => {
    const card = { left: 1360, top: 240, width: 580, height: 1040 }
    const p = toastStackPlacement({ ...base, obstacles: [card] })
    expect(p.maxVisible).toBe(0)
    expect(p.expandable).toBe(true)
    expect(p.hidden).toBeFalsy()
    // Dentro da faixa da barra, encostado na borda direita dela.
    expect(p.top!).toBeGreaterThanOrEqual(bar.top)
    expect(p.top! + 28).toBeLessThanOrEqual(bar.top + bar.height)
    expect(p.right).toBe(vw - (bar.left + bar.width) + 8)
  })

  it('fora do mapa estreito, o mesmo obstáculo segue o caminho antigo (ao lado)', () => {
    const card = { left: 1360, top: 240, width: 580, height: 1040 }
    const p = toastStackPlacement({ ...base, narrowMap: false, obstacles: [card] })
    expect(p.maxVisible).not.toBe(0)
  })
})

describe('barPillPadding', () => {
  it('mapa largo: só reserva quando o "+N" está na barra', () => {
    expect(barPillPadding(false, 0)).toBeUndefined()
    expect(barPillPadding(false, 80)).toBe(96)
  })

  it('mapa estreito: a vaga é fixa, com ou sem aviso — a barra não quebra a cada aviso', () => {
    const empty = barPillPadding(true, 0)
    expect(empty).toBeGreaterThan(0)
    expect(barPillPadding(true, 62)).toBe(empty)
    expect(barPillPadding(true, 80)).toBe(empty)
  })

  it('mapa estreito com um "+N" maior que a vaga: cresce para não cobrir o último item', () => {
    expect(barPillPadding(true, 200)).toBe(216)
  })
})
