// PURO: quantos chips da barra de sessões estão fora (ainda que em parte) da
// faixa visível. Vira o "+N" que abre o seletor — com 11 sessões a barra rolava
// com scrollbar à mostra e a última aba ficava cortada embaixo do ⤢.
// Um chip cortado do qual sobra menos que ícone + ~4 letras some inteiro
// (`hidden`, índices): sobrava só o spinner e o ponto colados no "+N".
export const MIN_VISIBLE_CHIP_PX = 64

export function clippedCount(
  bounds: { left: number; right: number },
  chips: { left: number; right: number }[],
): { left: number; right: number; hidden: number[] } {
  let left = 0
  let right = 0
  const hidden: number[] = []
  chips.forEach((c, i) => {
    const visible = Math.min(c.right, bounds.right) - Math.max(c.left, bounds.left)
    const cut = c.right > bounds.right + 1 || c.left < bounds.left - 1
    if (!cut) return
    if (c.right > bounds.right + 1) right++
    else left++
    if (visible < MIN_VISIBLE_CHIP_PX) hidden.push(i)
  })
  return { left, right, hidden }
}

// O chip agregado "↳ N em 2º plano" cortado: as N filhas dele estão tão fora da
// barra quanto um chip de sessão cortado, e entram no "+N" do mesmo lado.
export function clippedBackgroundCount(
  bounds: { left: number; right: number },
  groups: { left: number; right: number; count: number }[],
): { left: number; right: number } {
  let left = 0
  let right = 0
  for (const g of groups) {
    if (g.right > bounds.right + 1) right += g.count
    else if (g.left < bounds.left - 1) left += g.count
  }
  return { left, right }
}
