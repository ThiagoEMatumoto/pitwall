// Pure part of ArtboardOverflowBadge: how far the runtime's content size
// runs past the artboard, and how the badge words it.

export interface OverflowSize {
  w: number
  h: number
}

// Sub-pixel rounding in the runtime's scroll size is not an overflow.
const OVERFLOW_TOLERANCE_PX = 1

export function overflowOf(
  content: OverflowSize,
  frame: { width: number; height: number },
): OverflowSize | null {
  const w = Math.max(0, Math.round(content.w - frame.width))
  const h = Math.max(0, Math.round(content.h - frame.height))
  if (w <= OVERFLOW_TOLERANCE_PX && h <= OVERFLOW_TOLERANCE_PX) return null
  return { w: w > OVERFLOW_TOLERANCE_PX ? w : 0, h: h > OVERFLOW_TOLERANCE_PX ? h : 0 }
}

export function overflowLabel(over: OverflowSize): string {
  const parts: string[] = []
  if (over.h) parts.push(`${over.h}px abaixo`)
  if (over.w) parts.push(`${over.w}px à direita`)
  return `Conteúdo passa ${parts.join(' e ')}`
}
