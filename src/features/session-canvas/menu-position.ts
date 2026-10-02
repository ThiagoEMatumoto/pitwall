const MARGIN = 8

type Point = { x: number; y: number }
type Size = { width: number; height: number }

// Clique perto da borda: o menu abre para o lado que cabe, em vez de sair da tela.
export function clampMenuPosition(at: Point, size: Size, viewport: Size): Point {
  const flip = (start: number, extent: number, room: number) => {
    if (start + extent + MARGIN <= room) return start
    return Math.max(MARGIN, Math.min(start - extent, room - extent - MARGIN))
  }
  return { x: flip(at.x, size.width, viewport.width), y: flip(at.y, size.height, viewport.height) }
}
