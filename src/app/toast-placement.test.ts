import { describe, expect, it } from 'vitest'
import { PEEK_HEADER_HEIGHT, TOAST_MARGIN, toastStackPlacement } from './toast-placement'

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
})
