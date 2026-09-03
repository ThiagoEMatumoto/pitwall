// Main-process half of the capture plan: the pure planning lives in shared
// (the renderer needs it too); the bitmap composition needs Buffer and stays
// here. Tiles decode to BGRA rows of the same width, so composing is a row copy.

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
  // BGRA, width * h * 4 bytes (nativeImage.toBitmap()).
  bitmap: Buffer
  // Height of this tile in device px.
  h: number
}

export interface ComposedBitmap {
  bitmap: Buffer
  width: number
  height: number
}

// One preallocated bitmap that tiles are copied into as they arrive, so a
// capture never holds every tile plus their concatenation at once. `rows` is
// the planned height; Chromium rounds each scaled clip on its own, so a few
// rows of slack absorb the rounding and the final height is what landed.
export class BitmapComposer {
  private readonly stride: number
  private readonly buf: Buffer
  private readonly rows: number
  private height = 0
  private count = 0

  constructor(
    readonly width: number,
    rows: number,
    slackRows = 0,
  ) {
    this.stride = width * 4
    this.rows = rows + slackRows
    this.buf = Buffer.allocUnsafe(this.stride * this.rows)
  }

  append(tile: BitmapTile): void {
    const bytes = tile.h * this.stride
    if (tile.bitmap.byteLength !== bytes) {
      throw new Error(
        `BitmapComposer: tile ${this.count} has ${tile.bitmap.byteLength} bytes, expected ${bytes} (${this.width}x${tile.h})`,
      )
    }
    if (this.height + tile.h > this.rows) {
      throw new Error(
        `BitmapComposer: tile ${this.count} overflows the planned ${this.rows} rows`,
      )
    }
    tile.bitmap.copy(this.buf, this.height * this.stride)
    this.height += tile.h
    this.count += 1
  }

  finish(): ComposedBitmap {
    if (this.count === 0) throw new Error('BitmapComposer: no tiles')
    return {
      bitmap: this.buf.subarray(0, this.height * this.stride),
      width: this.width,
      height: this.height,
    }
  }
}
