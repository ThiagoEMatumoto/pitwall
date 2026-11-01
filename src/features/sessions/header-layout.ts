// Como o header da sessão degrada pela largura REAL do painel (4 panes lado a
// lado caem em ~320-480px). Nada se perde: o que sai da linha vai para o menu
// "…" ou para o tooltip. Puro para ser testado nas larguras de referência.
export interface HeaderLayout {
  // "vincular a uma frente" vira só o ícone (aria-label/tooltip mantêm o texto).
  featureLinkIconOnly: boolean
  // Chips de relacionadas sem piso de largura: truncam em vez de empurrar.
  chipsShrink: boolean
  // Marcar mãe, tornar filha e bastão (fora do crítico) vão para o "…".
  secondaryInMenu: boolean
  // Toggle Chat⇄Terminal também vai para o "…".
  toggleInMenu: boolean
}

export const HEADER_COMPACT_BELOW = 720
export const HEADER_TIGHT_BELOW = 480

export function headerLayout(width: number | undefined): HeaderLayout {
  // Antes da 1ª medição (e em jsdom): a linha inteira, como sempre foi.
  const w = width ?? Number.POSITIVE_INFINITY
  const compact = w < HEADER_COMPACT_BELOW
  const tight = w < HEADER_TIGHT_BELOW
  return {
    featureLinkIconOnly: compact,
    chipsShrink: compact,
    secondaryInMenu: compact,
    toggleInMenu: tight,
  }
}
