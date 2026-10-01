import { describe, expect, it } from 'vitest'
import { MENTION_MENU_MAX_H, mentionPlacement } from './mention-placement'

describe('mentionPlacement', () => {
  it('abre abaixo do campo quando cabe (não cobre a lista nem o cabeçalho)', () => {
    const p = mentionPlacement({
      fieldTop: 300,
      fieldBottom: 372,
      headerBottom: 130,
      viewportHeight: 900,
    })
    expect(p).toEqual({ side: 'below', maxHeight: MENTION_MENU_MAX_H })
  })

  it('vira pra cima quando embaixo não cabe, limitado ao espaço até o cabeçalho', () => {
    const p = mentionPlacement({
      fieldTop: 500,
      fieldBottom: 572,
      headerBottom: 330,
      viewportHeight: 640,
    })
    expect(p.side).toBe('above')
    expect(p.maxHeight).toBe(500 - 330 - 8)
  })

  it('embaixo apertado mas maior que em cima: fica embaixo, encolhido', () => {
    const p = mentionPlacement({
      fieldTop: 150,
      fieldBottom: 222,
      headerBottom: 120,
      viewportHeight: 330,
    })
    expect(p).toEqual({ side: 'below', maxHeight: 330 - 222 - 8 })
  })
})
