import { describe, expect, it } from 'vitest'
import { cardZoomViewport, toggleCardZoom } from './map-zoom-toggle'

const view = { w: 1200, h: 800 }

describe('cardZoomViewport', () => {
  it('cartão que cabe: zoom 1 (nunca amplia além do tamanho real) e centrado', () => {
    const vp = cardZoomViewport({ x: 100, y: 50, w: 400, h: 300 }, view)
    expect(vp.zoom).toBe(1)
    // centro do cartão no centro da tela
    expect(vp.x + (100 + 200) * vp.zoom).toBeCloseTo(600)
    expect(vp.y + (50 + 150) * vp.zoom).toBeCloseTo(400)
  })

  it('cartão maior que a tela: encolhe só o necessário para caber inteiro', () => {
    const vp = cardZoomViewport({ x: 0, y: 0, w: 600, h: 1600 }, view)
    expect(vp.zoom).toBeLessThan(1)
    expect(1600 * vp.zoom).toBeLessThanOrEqual(800)
    expect(vp.y).toBeGreaterThanOrEqual(0)
  })

  it('desconta os insets: centra na área livre, não sob a barra ou o painel', () => {
    const vp = cardZoomViewport({ x: 0, y: 0, w: 200, h: 200 }, view, { top: 100, right: 400 })
    // área livre: x 0..800, y 100..800 → centro (400, 450)
    expect(vp.x + 100 * vp.zoom).toBeCloseTo(400)
    expect(vp.y + 100 * vp.zoom).toBeCloseTo(450)
  })
})

describe('toggleCardZoom', () => {
  const current = { x: -37, y: 12.5, zoom: 0.43 }
  const target = { x: 10, y: 20, zoom: 1 }

  it('1º F: aplica o enquadre e guarda o viewport atual', () => {
    expect(toggleCardZoom(null, current, target)).toEqual({ apply: target, saved: current })
  })

  it('2º F: restaura o viewport guardado exato e esquece', () => {
    expect(toggleCardZoom(current, target, target)).toEqual({ apply: current, saved: null })
  })

  it('restaurar não precisa de cartão selecionado', () => {
    expect(toggleCardZoom(current, target, null)).toEqual({ apply: current, saved: null })
  })

  it('sem guardado e sem cartão: nada a fazer', () => {
    expect(toggleCardZoom(null, current, null)).toEqual({ apply: null, saved: null })
  })
})
