// Main-process half of the capture plan: the pure planning lives in shared
// (the renderer needs it too); the bitmap composition needs Buffer and stays
// here. Tiles decode to BGRA rows of the same width, so composing is a concat.

export {
  planCaptureTiles,
  captureTimeoutMs,
  assertCaptureBudget,
  exceedsCaptureBudget,
  type CapturePlan,
  type CapturePlanInput,
  type CaptureTile,
} from '../../../../shared/design/capture-plan'

export interface BitmapTile {
  // BGRA, outW * h * 4 bytes (nativeImage.toBitmap()).
  bitmap: Buffer
  // Height of this tile in device px.
  h: number
}

export interface ComposedBitmap {
  bitmap: Buffer
  width: number
  height: number
}

export function composeBitmapTiles(tiles: BitmapTile[], outW: number): ComposedBitmap {
  if (tiles.length === 0) throw new Error('composeBitmapTiles: no tiles')
  const stride = outW * 4
  for (const [i, tile] of tiles.entries()) {
    if (tile.bitmap.byteLength !== tile.h * stride) {
      throw new Error(
        `composeBitmapTiles: tile ${i} has ${tile.bitmap.byteLength} bytes, expected ${tile.h * stride} (${outW}x${tile.h})`,
      )
    }
  }
  const height = tiles.reduce((sum, t) => sum + t.h, 0)
  return { bitmap: Buffer.concat(tiles.map((t) => t.bitmap)), width: outW, height }
}
