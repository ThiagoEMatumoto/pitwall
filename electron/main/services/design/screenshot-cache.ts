import type { CaptureArtboardInput, CaptureArtboardResult } from './screenshot'

// LRU of finished captures keyed by everything that changes the pixels. Bounded
// by PNG bytes, not entries: a handful of 4K exports weighs more than a
// hundred thumbnails.

// PNG bytes kept across calls, whatever the entry count.
const CACHE_MAX_BYTES = 64 * 1024 * 1024

const cache = new Map<string, CaptureArtboardResult>()
let cacheBytes = 0

export function captureCacheKey(input: CaptureArtboardInput): string | null {
  if (input.version == null) return null
  return [
    input.artboardId,
    input.version,
    input.docUpdatedAt ?? '',
    input.scale,
    input.motion ?? 'final',
    input.nodeId ?? '',
  ].join(':')
}

function forget(key: string): void {
  const gone = cache.get(key)
  if (!gone) return
  cache.delete(key)
  cacheBytes -= gone.png.byteLength
}

export function rememberCapture(key: string, result: CaptureArtboardResult): void {
  forget(key)
  if (result.png.byteLength > CACHE_MAX_BYTES) return
  cache.set(key, result)
  cacheBytes += result.png.byteLength
  while (cacheBytes > CACHE_MAX_BYTES) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    forget(oldest)
  }
}

export function lookupCapture(key: string): CaptureArtboardResult | undefined {
  const hit = cache.get(key)
  // Refresh recency so hot artboards survive eviction.
  if (hit) rememberCapture(key, hit)
  return hit
}
