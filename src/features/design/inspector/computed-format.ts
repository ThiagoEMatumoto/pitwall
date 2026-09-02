// Formatting of getComputedStyle values for the inspector's placeholders.
// Pure so it stays testable without the store or a bridge.

const RGB_RE = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/

// getComputedStyle reports colours as rgb()/rgba(); hex reads better in the
// field and is what the user would type. Anything else passes through.
export function computedColor(value: string | undefined): string {
  const raw = (value ?? '').trim()
  const m = RGB_RE.exec(raw)
  if (!m) return raw
  const alpha = m[4] == null ? 1 : Number(m[4])
  if (alpha === 0) return 'transparent'
  const hex = [m[1], m[2], m[3]].map((c) => Number(c).toString(16).padStart(2, '0')).join('')
  if (alpha >= 1) return `#${hex}`
  const a = Math.round(alpha * 255)
    .toString(16)
    .padStart(2, '0')
  return `#${hex}${a}`
}

// "16px" → "16"; "normal" → fallback. For NumberField placeholders.
export function computedPx(value: string | undefined, fallback = ''): string {
  const n = parseFloat(value ?? '')
  return Number.isFinite(n) ? String(Math.round(n * 100) / 100) : fallback
}

export function computedText(value: string | undefined, fallback = '—'): string {
  const raw = (value ?? '').trim()
  return raw || fallback
}
