// PURO: quantos chips da barra de sessões estão fora (ainda que em parte) da
// faixa visível. Vira o "+N" que abre o seletor — com 11 sessões a barra rolava
// com scrollbar à mostra e a última aba ficava cortada embaixo do ⤢.
export function clippedCount(
  bounds: { left: number; right: number },
  chips: { left: number; right: number }[],
): { left: number; right: number } {
  let left = 0
  let right = 0
  for (const c of chips) {
    if (c.right > bounds.right + 1) right++
    else if (c.left < bounds.left - 1) left++
  }
  return { left, right }
}
