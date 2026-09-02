// Pure mapping between inspector values and node.style. Keys are written in
// kebab-case (the parser's convention); reads accept camelCase too because
// ops coming from Claude may use either spelling.

export type Style = Record<string, string>
export type StylePatch = Record<string, string | null>

function camel(key: string): string {
  return key.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())
}

export function getStyle(style: Style, key: string): string | undefined {
  return style[key] ?? style[camel(key)]
}

// A patch written in kebab-case also clears a camelCase twin so the two
// spellings never coexist on the node.
export function normalizePatch(style: Style, patch: StylePatch): StylePatch {
  const out: StylePatch = { ...patch }
  for (const key of Object.keys(patch)) {
    const twin = camel(key)
    if (twin !== key && twin in style) out[twin] = null
  }
  return out
}

export function parsePx(value: string | undefined): number | null {
  if (value == null) return null
  const m = /^(-?\d*\.?\d+)(px)?$/.exec(value.trim())
  return m ? Number(m[1]) : null
}

export function px(n: number): string {
  return `${Math.round(n * 100) / 100}px`
}

function splitBox(value: string | undefined): [number, number, number, number] | null {
  if (!value) return null
  const parts = value.trim().split(/\s+/).map(parsePx)
  if (parts.some((p) => p == null)) return null
  const [a, b = a, c = a, d = b] = parts as number[]
  return [a, b, c, d]
}

function joinBox(box: readonly number[]): string {
  const [t, r, b, l] = box
  if (t === r && r === b && b === l) return px(t)
  if (t === b && r === l) return `${px(t)} ${px(r)}`
  return `${px(t)} ${px(r)} ${px(b)} ${px(l)}`
}

// ---- Sizing ----

export type SizingMode = 'hug' | 'fill' | 'fixed'
export type Axis = 'width' | 'height'

export interface Sizing {
  mode: SizingMode
  px: number | null
}

export function readSizing(style: Style, axis: Axis): Sizing {
  const raw = getStyle(style, axis)
  const flex = getStyle(style, 'flex') ?? getStyle(style, 'flex-grow')
  if (raw === '100%' || (flex != null && /^1\b/.test(flex.trim()))) return { mode: 'fill', px: null }
  const n = parsePx(raw)
  if (n != null) return { mode: 'fixed', px: n }
  return { mode: 'hug', px: null }
}

export function writeSizing(axis: Axis, sizing: Sizing, inFlex: boolean): StylePatch {
  const min = axis === 'width' ? 'min-width' : 'min-height'
  switch (sizing.mode) {
    case 'hug':
      return { [axis]: 'auto', flex: 'none', [min]: null }
    case 'fill':
      return inFlex ? { [axis]: null, flex: '1 1 0', [min]: '0' } : { [axis]: '100%', flex: null, [min]: null }
    case 'fixed':
      return { [axis]: px(sizing.px ?? 100), flex: inFlex ? 'none' : null, [min]: null }
  }
}

// ---- Auto layout ----

export type FlexDirection = 'row' | 'column'

export interface AutoLayout {
  enabled: boolean
  direction: FlexDirection
  gap: number
  padding: [number, number, number, number]
  align: string
  justify: string
  wrap: boolean
}

export const ALIGN_OPTIONS = ['stretch', 'flex-start', 'center', 'flex-end', 'baseline'] as const
export const JUSTIFY_OPTIONS = [
  'flex-start',
  'center',
  'flex-end',
  'space-between',
  'space-around',
  'space-evenly',
] as const

export function readPadding(style: Style): [number, number, number, number] {
  const base = splitBox(getStyle(style, 'padding')) ?? [0, 0, 0, 0]
  const sides = ['top', 'right', 'bottom', 'left'] as const
  return sides.map((side, i) => parsePx(getStyle(style, `padding-${side}`)) ?? base[i]) as [
    number,
    number,
    number,
    number,
  ]
}

export function readAutoLayout(style: Style): AutoLayout {
  const display = getStyle(style, 'display')
  const dir = getStyle(style, 'flex-direction')
  return {
    enabled: display === 'flex' || display === 'inline-flex',
    direction: dir?.startsWith('column') ? 'column' : 'row',
    gap: parsePx(getStyle(style, 'gap')) ?? 0,
    padding: readPadding(style),
    align: getStyle(style, 'align-items') ?? 'stretch',
    justify: getStyle(style, 'justify-content') ?? 'flex-start',
    wrap: getStyle(style, 'flex-wrap') === 'wrap',
  }
}

export function writeAutoLayout(layout: AutoLayout): StylePatch {
  const longhands: StylePatch = {
    'padding-top': null,
    'padding-right': null,
    'padding-bottom': null,
    'padding-left': null,
  }
  if (!layout.enabled) {
    return {
      display: null,
      'flex-direction': null,
      gap: null,
      'align-items': null,
      'justify-content': null,
      'flex-wrap': null,
    }
  }
  return {
    ...longhands,
    display: 'flex',
    'flex-direction': layout.direction,
    gap: layout.gap ? px(layout.gap) : null,
    padding: layout.padding.some((p) => p !== 0) ? joinBox(layout.padding) : null,
    'align-items': layout.align === 'stretch' ? null : layout.align,
    'justify-content': layout.justify === 'flex-start' ? null : layout.justify,
    'flex-wrap': layout.wrap ? 'wrap' : null,
  }
}

export function writePadding(padding: readonly number[]): StylePatch {
  return {
    padding: padding.some((p) => p !== 0) ? joinBox(padding) : null,
    'padding-top': null,
    'padding-right': null,
    'padding-bottom': null,
    'padding-left': null,
  }
}

// ---- Radius ----

const CORNERS = ['top-left', 'top-right', 'bottom-right', 'bottom-left'] as const

export function readRadius(style: Style): [number, number, number, number] {
  const base = splitBox(getStyle(style, 'border-radius')) ?? [0, 0, 0, 0]
  return CORNERS.map((c, i) => parsePx(getStyle(style, `border-${c}-radius`)) ?? base[i]) as [
    number,
    number,
    number,
    number,
  ]
}

export function writeRadius(radius: readonly number[]): StylePatch {
  const patch: StylePatch = {
    'border-radius': radius.some((r) => r !== 0) ? joinBox(radius) : null,
  }
  for (const c of CORNERS) patch[`border-${c}-radius`] = null
  return patch
}

// ---- Border ----

export interface Border {
  width: number
  style: string
  color: string
}

export const BORDER_STYLES = ['solid', 'dashed', 'dotted'] as const

export function readBorder(style: Style): Border {
  const parts = (getStyle(style, 'border') ?? '').trim().split(/\s+/).filter(Boolean)
  let width = 0
  let kind = 'solid'
  const colorParts: string[] = []
  for (const p of parts) {
    const n = parsePx(p)
    if (n != null) width = n
    else if ((BORDER_STYLES as readonly string[]).includes(p) || p === 'none') kind = p
    else colorParts.push(p)
  }
  return {
    width: parsePx(getStyle(style, 'border-width')) ?? width,
    style: getStyle(style, 'border-style') ?? kind,
    color: getStyle(style, 'border-color') ?? colorParts.join(' '),
  }
}

export function writeBorder(border: Border): StylePatch {
  const off = border.width <= 0 || border.style === 'none'
  return {
    border: off ? null : `${px(border.width)} ${border.style} ${border.color || 'currentColor'}`,
    'border-width': null,
    'border-style': null,
    'border-color': null,
  }
}

// ---- Shadow ----

export const SHADOW_PRESETS = {
  none: '',
  sm: '0 1px 2px rgba(0,0,0,0.08)',
  md: '0 4px 12px rgba(0,0,0,0.12)',
  lg: '0 12px 32px rgba(0,0,0,0.18)',
} as const

export type ShadowPreset = keyof typeof SHADOW_PRESETS

export function readShadow(style: Style): ShadowPreset | 'custom' {
  const raw = (getStyle(style, 'box-shadow') ?? '').trim()
  if (!raw || raw === 'none') return 'none'
  const norm = raw.replace(/\s+/g, ' ')
  for (const [id, value] of Object.entries(SHADOW_PRESETS)) if (value === norm) return id as ShadowPreset
  return 'custom'
}

export function writeShadow(preset: ShadowPreset): StylePatch {
  return { 'box-shadow': preset === 'none' ? null : SHADOW_PRESETS[preset] }
}

// ---- Position / opacity / blend ----

export type PositionMode = 'static' | 'relative' | 'absolute'

export interface Position {
  mode: PositionMode
  top: number | null
  left: number | null
}

export function readPosition(style: Style): Position {
  const raw = getStyle(style, 'position')
  const mode: PositionMode = raw === 'absolute' || raw === 'relative' ? raw : 'static'
  return {
    mode,
    top: parsePx(getStyle(style, 'top')),
    left: parsePx(getStyle(style, 'left')),
  }
}

export function writePosition(pos: Position): StylePatch {
  if (pos.mode === 'static') return { position: null, top: null, left: null }
  return {
    position: pos.mode,
    top: pos.top == null ? null : px(pos.top),
    left: pos.left == null ? null : px(pos.left),
  }
}

// Percent 0–100.
export function readOpacity(style: Style): number {
  const raw = getStyle(style, 'opacity')
  if (raw == null) return 100
  const n = Number(raw)
  return Number.isFinite(n) ? Math.round(n * 100) : 100
}

export function writeOpacity(percent: number): StylePatch {
  const clamped = Math.max(0, Math.min(100, percent))
  return { opacity: clamped === 100 ? null : String(clamped / 100) }
}

export const BLEND_MODES = [
  'normal',
  'multiply',
  'screen',
  'overlay',
  'darken',
  'lighten',
  'difference',
] as const

export function readBlend(style: Style): string {
  return getStyle(style, 'mix-blend-mode') ?? 'normal'
}

export function writeBlend(mode: string): StylePatch {
  return { 'mix-blend-mode': mode === 'normal' ? null : mode }
}

// ---- Typography ----

export interface Typography {
  fontFamily: string
  fontSize: number | null
  fontWeight: string
  lineHeight: string
  letterSpacing: number | null
  textAlign: string
  color: string
}

export const FONT_WEIGHTS = ['300', '400', '500', '600', '700', '800'] as const
export const TEXT_ALIGNS = ['left', 'center', 'right', 'justify'] as const

export function readTypography(style: Style): Typography {
  return {
    fontFamily: getStyle(style, 'font-family') ?? '',
    fontSize: parsePx(getStyle(style, 'font-size')),
    fontWeight: getStyle(style, 'font-weight') ?? '400',
    lineHeight: getStyle(style, 'line-height') ?? '',
    letterSpacing: parsePx(getStyle(style, 'letter-spacing')),
    textAlign: getStyle(style, 'text-align') ?? 'left',
    color: getStyle(style, 'color') ?? '',
  }
}

export function writeTypography(t: Partial<Typography>): StylePatch {
  const patch: StylePatch = {}
  if ('fontFamily' in t) patch['font-family'] = t.fontFamily || null
  if ('fontSize' in t) patch['font-size'] = t.fontSize == null ? null : px(t.fontSize)
  if ('fontWeight' in t) patch['font-weight'] = t.fontWeight === '400' || !t.fontWeight ? null : t.fontWeight
  if ('lineHeight' in t) patch['line-height'] = t.lineHeight || null
  if ('letterSpacing' in t) patch['letter-spacing'] = t.letterSpacing == null ? null : px(t.letterSpacing)
  if ('textAlign' in t) patch['text-align'] = t.textAlign === 'left' || !t.textAlign ? null : t.textAlign
  if ('color' in t) patch.color = t.color || null
  return patch
}
