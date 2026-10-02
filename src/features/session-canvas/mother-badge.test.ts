import { describe, expect, it } from 'vitest'
import type { SessionGraphNode } from '../../../shared/types/session-graph'
import { compensatedPx } from './card-display'
import {
  motherResizable,
  MOTHER_STRIP,
  batonChipPx,
  motherBadgePx,
  motherBadgeText,
  motherFrame,
} from './mother-badge'

const node = (over: Partial<SessionGraphNode>) => over as SessionGraphNode

describe('MotherBadge', () => {
  // Curto de propósito: "MÃE · 3 FILHAS" em caixa alta engolia o título no
  // cartão de largura fixa. A contagem por extenso fica no tooltip.
  it('texto curto; compacto é só a contagem (a coroa vem do ícone)', () => {
    expect(motherBadgeText(2)).toBe('MÃE · 2')
    expect(motherBadgeText(2, true)).toBe('2')
  })

  // Regressão: o teto de 19,2 deixava o badge com 8,6px na tela no zoom 0,45 —
  // e o brief vai de 0,45 a 0,75.
  it('badge e chip com >= 11px efetivos em toda a faixa legível (0,45 a 2)', () => {
    for (const zoom of [0.45, 0.5, 0.6, 0.7, 0.75, 1, 1.5, 2]) {
      expect(motherBadgePx(zoom) * zoom).toBeGreaterThanOrEqual(11)
      expect(batonChipPx(zoom) * zoom).toBeGreaterThanOrEqual(11)
    }
  })

  it('tamanho efetivo >= 11px de 0,6 a 2x de zoom (escala inversa até 1,6)', () => {
    for (const zoom of [0.6, 0.75, 1, 1.5, 2]) {
      const px = compensatedPx(zoom, 12, 19.2)
      expect(px * zoom).toBeGreaterThanOrEqual(11)
      expect(px).toBeLessThanOrEqual(19.2)
    }
  })

  it('mãe: faixa no topo, sem mexer no contorno (borda e outline são do estado e do foco)', () => {
    const base = { borderColor: 'x', borderWidth: 1 }
    expect(motherFrame(node({ isMother: false }), base)).toBe(base)
    const glow = { ...base, boxShadow: '0 0 14px -4px var(--color-accent)' }
    const frame = motherFrame(node({ isMother: true }), glow)
    expect(frame).toMatchObject({ borderColor: 'x', borderWidth: 1 })
    expect(frame.borderStyle).toBeUndefined()
    expect(frame.outline).toBeUndefined()
    expect(frame.boxShadow).toBe(`${MOTHER_STRIP}, ${glow.boxShadow}`)
    expect(motherFrame(node({ isMother: true }), base).boxShadow).toBe(MOTHER_STRIP)
    // Quem precisa de você mantém a cor do estado.
    expect(
      motherFrame(node({ isMother: true }), { borderColor: 'red', borderWidth: 2 }).borderColor,
    ).toBe('red')
  })
})

describe('motherResizable', () => {
  // Entre 0.55 e 0.75 a mãe ainda desenha o cartão cheio, mas a raia já está no
  // layout compacto: redimensionar ali fixaria os irmãos em coordenadas compactas.
  it('só no zoom em que o layout é o de leitura', () => {
    expect(motherResizable(0.6)).toBe(false)
    expect(motherResizable(0.7)).toBe(false)
    expect(motherResizable(0.75)).toBe(true)
    expect(motherResizable(1)).toBe(true)
  })
})
