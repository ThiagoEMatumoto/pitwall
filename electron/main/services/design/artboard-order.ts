// Reading order of a document's artboards, for exports where one artboard is
// one page (PDF, PNG batch). `position` is creation order — an artboard moved
// on the canvas keeps it — so the order has to come from the geometry: rows
// top to bottom, artboards left to right inside a row.

export interface SpatialArtboard {
  x: number
  y: number
  position: number
}

// Two artboards belong to the same row when their top edges are within this
// many px: a row is rarely aligned to the pixel, but the row below is always
// farther away than a nudge.
export const ROW_BAND_PX = 64

export function orderArtboardsSpatially<T extends SpatialArtboard>(artboards: readonly T[]): T[] {
  const byTop = [...artboards].sort((a, b) => a.y - b.y || a.x - b.x || a.position - b.position)
  const rows: T[][] = []
  // Anchored on the row's first artboard, not on the previous one: a long
  // staircase of small offsets must not drag one row down the whole canvas.
  let rowTop = 0
  for (const artboard of byTop) {
    const row = rows[rows.length - 1]
    if (!row || artboard.y - rowTop > ROW_BAND_PX) {
      rows.push([artboard])
      rowTop = artboard.y
    } else {
      row.push(artboard)
    }
  }
  return rows.flatMap((row) => row.sort((a, b) => a.x - b.x || a.position - b.position))
}
