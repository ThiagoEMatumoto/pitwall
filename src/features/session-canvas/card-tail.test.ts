import { describe, expect, it } from 'vitest'
import {
  cardPreviewLines,
  cwdFooter,
  paletteColor,
  segmentColor,
  tailSubscription,
  type TailCandidate,
} from './card-tail'

function card(sessionId: string, x: number, y: number, view: TailCandidate['view'] = 'open') {
  return { sessionId, view, x, y, w: 400, h: 368 }
}

const VIEW = { x: 0, y: 0, zoom: 1, width: 1000, height: 800 }

describe('tailSubscription', () => {
  it('no zoom do resumo só a mãe (minZoom próprio) segue assinando', () => {
    const vp = { ...VIEW, zoom: 0.6 }
    const ids = tailSubscription([card('filha', 10, 10), { ...card('mae', 500, 10), minZoom: 0.55 }], vp)
    expect(ids).toEqual(['mae'])
    expect(tailSubscription([{ ...card('mae', 10, 10), minZoom: 0.55 }], { ...VIEW, zoom: 0.5 })).toEqual([])
  })

  it('só cartões abertos E visíveis no viewport assinam', () => {
    const ids = tailSubscription(
      [
        card('aberto', 10, 10),
        card('recolhido', 450, 10, 'collapsed'),
        card('terminal', 10, 400, 'terminal'),
        card('fora', 3000, 10),
      ],
      VIEW,
    )
    expect(ids).toEqual(['aberto'])
  })

  it('respeita o pan e o zoom do viewport', () => {
    // Pan de -2000px em x a zoom 1: a tela mostra x ∈ [2000, 3000].
    expect(
      tailSubscription([card('a', 10, 10), card('b', 2100, 10)], { ...VIEW, x: -2000 }),
    ).toEqual(['b'])
  })

  it('zoom ilegível (cartão em resumo) não assina nada', () => {
    expect(tailSubscription([card('a', 10, 10)], { ...VIEW, zoom: 0.6 })).toEqual([])
  })

  it('cap: ficam os mais perto do centro da tela', () => {
    const cards = Array.from({ length: 30 }, (_, i) =>
      card(`c${String(i).padStart(2, '0')}`, i * 30, 0),
    )
    const ids = tailSubscription(cards, { ...VIEW, width: 4000, zoom: 1 }, 25)
    expect(ids).toHaveLength(25)
  })

  it('a lista sai ordenada (comparação estável entre frames)', () => {
    expect(tailSubscription([card('b', 10, 10), card('a', 450, 10)], VIEW)).toEqual(['a', 'b'])
  })
})

describe('cores da saída ao vivo', () => {
  it('paleta 16, cubo 256 e cinzas; RGB passa direto', () => {
    expect(paletteColor(1)).toBe('#cd3131')
    expect(paletteColor(16)).toBe('#000000')
    expect(paletteColor(231)).toBe('#ffffff')
    expect(paletteColor(232)).toBe('#080808')
    expect(segmentColor({ t: 'x', fg: '#ff8000' })).toBe('#ff8000')
    expect(segmentColor({ t: 'x' })).toBeUndefined()
  })
})

describe('cardPreviewLines', () => {
  const line = (t: string) => [{ t }]
  it('as 4 últimas linhas não vazias, não as primeiras', () => {
    const lines = ['a', '', 'b', '   ', 'c', 'd', 'e', ''].map(line)
    expect(cardPreviewLines(lines)!.map((l) => l[0].t)).toEqual(['b', 'c', 'd', 'e'])
  })
  it('só o banner de boot: null (o cartão mostra o propósito)', () => {
    const banner = ['┌─ Fake Claude Code', '│ sessao: x', '│ cwd: /a', '└─', ''].map(line)
    expect(cardPreviewLines(banner)).toBeNull()
    expect(cardPreviewLines([])).toBeNull()
  })
  it('banner seguido de saída: mostra a saída', () => {
    const lines = ['╭─ Claude Code', '│ cwd: /a', '╰─', 'recebido: oi'].map(line)
    expect(cardPreviewLines(lines)!.at(-1)![0].t).toBe('recebido: oi')
  })
  it('cwdFooter', () => {
    expect(cwdFooter('lexter-copilot-api')).toBe('~/…/lexter-copilot-api')
    expect(cwdFooter(null)).toBeNull()
  })
})
