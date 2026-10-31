import { pointerWithin, type CollisionDetection, type Modifier } from '@dnd-kit/core'
import { getEventCoordinates } from '@dnd-kit/utilities'

// The drop target is whatever folder the pointer is over. The default
// (rectIntersection) tests the overlay rect instead, and a chip much smaller
// than the card it was lifted from never reaches the sidebar when the card was
// grabbed by the middle.
export const hubCollisionDetection: CollisionDetection = pointerWithin

// Just below-right of the pointer, so the chip doesn't hide the row it targets.
export const CHIP_CURSOR_OFFSET_PX = 12

// The overlay starts at the card's top-left corner, wherever the card was
// grabbed; this pins the chip's corner to the pointer instead.
export const chipFollowsCursor: Modifier = ({ activatorEvent, draggingNodeRect, transform }) => {
  if (!activatorEvent || !draggingNodeRect) return transform
  const pointer = getEventCoordinates(activatorEvent)
  if (!pointer) return transform
  return {
    ...transform,
    x: transform.x + pointer.x - draggingNodeRect.left + CHIP_CURSOR_OFFSET_PX,
    y: transform.y + pointer.y - draggingNodeRect.top + CHIP_CURSOR_OFFSET_PX,
  }
}
