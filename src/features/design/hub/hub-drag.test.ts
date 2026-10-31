import { rectIntersection, type ClientRect, type CollisionDetection } from '@dnd-kit/core'
import { describe, expect, it } from 'vitest'
import { CHIP_CURSOR_OFFSET_PX, chipFollowsCursor, hubCollisionDetection } from './hub-drag'

const rect = (left: number, top: number, width: number, height: number): ClientRect => ({
  left,
  top,
  width,
  height,
  right: left + width,
  bottom: top + height,
})

// The hub at 1600px: folder row in the 256px sidebar; a card in the grid,
// grabbed by its middle (x≈560) and dragged until the pointer is on the row.
const folderRect = rect(8, 300, 240, 30)
const pointer = { x: 128, y: 315 }
// The 224px chip trails the pointer by the grab offset (~260px to the right).
const chipRect = rect(pointer.x + 260 - 112, 280, 224, 64)

function detect(fn: CollisionDetection) {
  const container = { id: 'folder:f1', key: 'folder:f1', data: { current: {} }, disabled: false }
  return fn({
    active: { id: 'd1' } as never,
    collisionRect: chipRect,
    droppableRects: new Map([['folder:f1', folderRect]]),
    droppableContainers: [container] as never,
    pointerCoordinates: pointer,
  }).map((c) => c.id)
}

describe('hub drag', () => {
  it('drops on the folder under the pointer even when the chip is elsewhere', () => {
    expect(detect(rectIntersection)).toEqual([])
    expect(detect(hubCollisionDetection)).toEqual(['folder:f1'])
  })

  it('pins the chip just below-right of the pointer, wherever the card was grabbed', () => {
    const card = rect(400, 200, 320, 260)
    const grab = new MouseEvent('pointerdown', { clientX: 560, clientY: 280 })
    const moved = chipFollowsCursor({
      activatorEvent: grab,
      draggingNodeRect: card,
      transform: { x: -400, y: 100, scaleX: 1, scaleY: 1 },
    } as never)
    // Overlay origin (card top-left) + transform + offset = pointer + gap.
    expect(card.left + moved.x).toBe(560 - 400 + CHIP_CURSOR_OFFSET_PX)
    expect(card.top + moved.y).toBe(280 + 100 + CHIP_CURSOR_OFFSET_PX)
  })

  it('leaves the transform alone without an activator event', () => {
    const t = { x: 5, y: 6, scaleX: 1, scaleY: 1 }
    expect(chipFollowsCursor({ activatorEvent: null, draggingNodeRect: null, transform: t } as never)).toBe(t)
  })
})
