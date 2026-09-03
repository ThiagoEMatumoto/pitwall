// Pure planning for the offscreen capture: how a (width × height) artboard at
// a given scale is sliced into tiles, and whether the whole raster fits the
// pixel budget. No electron, no Buffer: the renderer uses it to disable export
// buttons before asking the main process.

import { CAPTURE_TILE_MAX_PX, MAX_CAPTURE_PIXELS } from './safety'

export interface CaptureTile {
  // Offset and height of the slice, in css px of the captured rect.
  y: number
  h: number
}

export interface CapturePlanInput {
  width: number
  height: number
  scale: number
  // Tallest slice, css px. Defaults to CAPTURE_TILE_MAX_PX.
  tileMax?: number
}

export interface CapturePlan {
  tiles: CaptureTile[]
  // Output raster size, device px.
  outW: number
  outH: number
  pixels: number
}

export function planCaptureTiles(input: CapturePlanInput): CapturePlan {
  const width = Math.max(1, Math.ceil(input.width))
  const height = Math.max(1, Math.ceil(input.height))
  const tileMax = Math.max(1, Math.floor(input.tileMax ?? CAPTURE_TILE_MAX_PX))
  const tiles: CaptureTile[] = []
  for (let y = 0; y < height; y += tileMax) {
    tiles.push({ y, h: Math.min(tileMax, height - y) })
  }
  const outW = Math.round(width * input.scale)
  const outH = Math.round(height * input.scale)
  return { tiles, outW, outH, pixels: outW * outH }
}

export function exceedsCaptureBudget(plan: Pick<CapturePlan, 'pixels'>): boolean {
  return plan.pixels > MAX_CAPTURE_PIXELS
}

export function captureBudgetMessage(input: CapturePlanInput, plan: CapturePlan): string {
  const mpx = (plan.pixels / 1_000_000).toFixed(0)
  const budgetMpx = (MAX_CAPTURE_PIXELS / 1_000_000).toFixed(0)
  return `capture of ${input.width}x${input.height} at scale ${input.scale} is ${mpx} Mpx, above the ${budgetMpx} Mpx budget; use a smaller scale or artboard`
}

export function assertCaptureBudget(input: CapturePlanInput, plan: CapturePlan): void {
  if (exceedsCaptureBudget(plan)) throw new Error(captureBudgetMessage(input, plan))
}

const CAPTURE_BASE_TIMEOUT_MS = 10_000
const CAPTURE_PER_TILE_MS = 2_000

// Load + fonts get the base; each tile is one more CDP round trip and decode.
export function captureTimeoutMs(tiles: number): number {
  return CAPTURE_BASE_TIMEOUT_MS + CAPTURE_PER_TILE_MS * Math.max(0, tiles)
}
