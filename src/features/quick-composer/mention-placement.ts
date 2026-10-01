// Onde o menu do @/# abre em relação ao campo do QuickComposer. Acima, ele cobria
// a prévia/lista de sessões e o cabeçalho "Enviar para"; por isso abre ABAIXO do
// campo quando cabe, e só vira pra cima (limitado ao espaço até o cabeçalho) se
// embaixo não couber nem o mínimo útil.
export const MENTION_MENU_MAX_H = 288
const MIN_USEFUL_H = 140
const MARGIN = 8

export interface MentionPlacement {
  side: 'below' | 'above'
  maxHeight: number
}

export function mentionPlacement(args: {
  fieldTop: number
  fieldBottom: number
  // Borda de baixo do cabeçalho do diálogo: o menu nunca sobe além dela.
  headerBottom: number
  viewportHeight: number
}): MentionPlacement {
  const below = args.viewportHeight - args.fieldBottom - MARGIN
  const above = args.fieldTop - args.headerBottom - MARGIN
  const cap = (h: number) => Math.max(0, Math.min(MENTION_MENU_MAX_H, Math.floor(h)))
  if (below >= Math.min(MIN_USEFUL_H, MENTION_MENU_MAX_H) || below >= above) {
    return { side: 'below', maxHeight: cap(below) }
  }
  return { side: 'above', maxHeight: cap(above) }
}
