// Pure coordinate math for the design canvas. Three spaces:
// - screen: pixels relative to the stage element's top-left
// - canvas: page units (where artboards are positioned; meta.x/y)
// - artboard-local: pixels inside one artboard (what the iframe reports)
// screen = canvas * zoom + viewport.{x,y}

import type { Rect } from '@shared/design/protocol'
import type { DesignArtboard, DesignPageViewport } from '@shared/types/design'

export type Viewport = DesignPageViewport

export interface Point {
  x: number
  y: number
}

export interface Size {
  w: number
  h: number
}

export type ArtboardPlacement = Pick<DesignArtboard, 'x' | 'y' | 'width' | 'height'>

export const MIN_ZOOM = 0.02
export const MAX_ZOOM = 32

export function clampZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom))
}

// ---- point conversions ----

export function canvasToScreen(p: Point, vp: Viewport): Point {
  return { x: p.x * vp.zoom + vp.x, y: p.y * vp.zoom + vp.y }
}

export function screenToCanvas(p: Point, vp: Viewport): Point {
  return { x: (p.x - vp.x) / vp.zoom, y: (p.y - vp.y) / vp.zoom }
}

export function canvasToArtboard(p: Point, meta: ArtboardPlacement): Point {
  return { x: p.x - meta.x, y: p.y - meta.y }
}

export function artboardToCanvas(p: Point, meta: ArtboardPlacement): Point {
  return { x: p.x + meta.x, y: p.y + meta.y }
}

export function screenToArtboard(p: Point, vp: Viewport, meta: ArtboardPlacement): Point {
  return canvasToArtboard(screenToCanvas(p, vp), meta)
}

export function artboardToScreen(p: Point, vp: Viewport, meta: ArtboardPlacement): Point {
  return canvasToScreen(artboardToCanvas(p, meta), vp)
}

// ---- rect conversions ----

export function artboardScreenRect(meta: ArtboardPlacement, vp: Viewport): Rect {
  const origin = canvasToScreen({ x: meta.x, y: meta.y }, vp)
  return {
    x: origin.x,
    y: origin.y,
    w: meta.width * vp.zoom,
    h: meta.height * vp.zoom,
  }
}

// A rect reported by the iframe (artboard-local px) → screen px.
export function artboardRectToScreen(rect: Rect, meta: ArtboardPlacement, vp: Viewport): Rect {
  const origin = artboardToScreen({ x: rect.x, y: rect.y }, vp, meta)
  return { x: origin.x, y: origin.y, w: rect.w * vp.zoom, h: rect.h * vp.zoom }
}

export function screenRectToArtboard(rect: Rect, meta: ArtboardPlacement, vp: Viewport): Rect {
  const origin = screenToArtboard({ x: rect.x, y: rect.y }, vp, meta)
  return { x: origin.x, y: origin.y, w: rect.w / vp.zoom, h: rect.h / vp.zoom }
}

export function artboardBounds(meta: ArtboardPlacement): Rect {
  return { x: meta.x, y: meta.y, w: meta.width, h: meta.height }
}

// ---- rect helpers ----

export function rectFromPoints(a: Point, b: Point): Rect {
  const x = Math.min(a.x, b.x)
  const y = Math.min(a.y, b.y)
  return { x, y, w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) }
}

export function rectContains(rect: Rect, p: Point): boolean {
  return p.x >= rect.x && p.x <= rect.x + rect.w && p.y >= rect.y && p.y <= rect.y + rect.h
}

export function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
}

export function unionRects(rects: readonly Rect[]): Rect | null {
  if (rects.length === 0) return null
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const r of rects) {
    minX = Math.min(minX, r.x)
    minY = Math.min(minY, r.y)
    maxX = Math.max(maxX, r.x + r.w)
    maxY = Math.max(maxY, r.y + r.h)
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
}

export function rectCenter(rect: Rect): Point {
  return { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 }
}

// ---- viewport ----

// New viewport with `zoom`, keeping the canvas point under `anchor` (screen) fixed.
export function zoomAt(vp: Viewport, zoom: number, anchor: Point): Viewport {
  const next = clampZoom(zoom)
  const canvasPoint = screenToCanvas(anchor, vp)
  return {
    x: anchor.x - canvasPoint.x * next,
    y: anchor.y - canvasPoint.y * next,
    zoom: next,
  }
}

// Viewport that shows `bounds` (canvas units) centered in a stage of `stage` px.
export function fitViewport(bounds: Rect, stage: Size, padding = 64): Viewport {
  const availW = Math.max(1, stage.w - padding * 2)
  const availH = Math.max(1, stage.h - padding * 2)
  const zoom = clampZoom(Math.min(availW / Math.max(1, bounds.w), availH / Math.max(1, bounds.h), 1))
  const center = rectCenter(bounds)
  return {
    x: stage.w / 2 - center.x * zoom,
    y: stage.h / 2 - center.y * zoom,
    zoom,
  }
}

// ---- iframe url ----

export type ArtboardUrlMode = 'edit' | 'preview'

// Mirrors the route served by electron/main/services/design/protocol.ts;
// the renderer cannot import from electron/main.
export function artboardUrl(id: string, docId: string, mode: ArtboardUrlMode, token: string): string {
  const query = new URLSearchParams({ doc: docId, mode, t: token })
  return `pitwall-design://artboard/${encodeURIComponent(id)}?${query.toString()}`
}
