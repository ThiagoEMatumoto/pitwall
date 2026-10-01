import { Position } from '@xyflow/react'

// PURO: onde o fio encosta num nó. Em vez de sair sempre da direita e chegar pela
// esquerda (o que, com mãe e filha empilhadas na mesma coluna, passava o fio por
// cima dos cartões), sai do meio da borda voltada para o outro nó.
export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export interface Anchor {
  x: number
  y: number
  position: Position
}

export function borderAnchor(self: Rect, other: Rect): Anchor {
  const cx = self.x + self.w / 2
  const cy = self.y + self.h / 2
  const dx = other.x + other.w / 2 - cx
  const dy = other.y + other.h / 2 - cy
  // Compara as inclinações normalizadas pelo formato do nó: cartão é largo, então
  // um vizinho levemente abaixo e bem ao lado ainda sai pela lateral.
  if (Math.abs(dx) * self.h >= Math.abs(dy) * self.w) {
    return dx >= 0
      ? { x: self.x + self.w, y: cy, position: Position.Right }
      : { x: self.x, y: cy, position: Position.Left }
  }
  return dy >= 0
    ? { x: cx, y: self.y + self.h, position: Position.Bottom }
    : { x: cx, y: self.y, position: Position.Top }
}
