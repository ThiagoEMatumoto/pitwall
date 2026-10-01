import { describe, expect, it } from 'vitest'
import type { SessionGraphNode } from '../../../shared/types/session-graph'
import { compensatedPx } from './card-display'
import { batonChipPx, motherBadgePx, motherBadgeText, motherFrame } from './mother-badge'

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

  it('moldura dupla só na mãe; needs-you mantém a cor do estado', () => {
    const base = { borderColor: 'x', borderWidth: 1 }
    expect(motherFrame(node({ isMother: false }), base)).toBe(base)
    expect(motherFrame(node({ isMother: true }), base)).toMatchObject({
      borderStyle: 'double',
      borderWidth: 4,
      borderColor: 'var(--color-accent)',
    })
    expect(
      motherFrame(node({ isMother: true }), { borderColor: 'red', borderWidth: 2 }).borderColor,
    ).toBe('red')
  })
})
