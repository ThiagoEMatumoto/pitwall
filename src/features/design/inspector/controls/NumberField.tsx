import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'

// 'auto' and 'none' print no suffix ('auto' also placeholders the empty value).
export type NumberUnit = 'px' | '%' | 'ms' | 'auto' | 'none'

interface Props {
  value: number | null
  onCommit: (value: number | null) => void
  // Fired while scrubbing (label drag); the caller applies it transiently.
  onScrub?: (value: number) => void
  label?: string
  // Placeholder for null (e.g. the computed size while sizing is hug).
  placeholder?: string
  unit?: NumberUnit
  units?: readonly NumberUnit[]
  onUnitChange?: (unit: NumberUnit) => void
  min?: number
  max?: number
  step?: number
  disabled?: boolean
  // Shown but not editable (a measured value, e.g. the height of a flow artboard).
  readOnly?: boolean
  // A typed value fell outside [min, max]: the caller may say so (toast).
  onClamped?: (requested: number, value: number) => void
}

const SCRUB_PX_PER_UNIT = 2

function clamp(n: number, min?: number, max?: number): number {
  if (min != null && n < min) return min
  if (max != null && n > max) return max
  return n
}

export function NumberField({
  value,
  onCommit,
  onScrub,
  label,
  placeholder,
  unit = 'px',
  units,
  onUnitChange,
  min,
  max,
  step = 1,
  disabled,
  readOnly,
  onClamped,
}: Props) {
  const [draft, setDraft] = useState<string>(value == null ? '' : String(value))
  const [editing, setEditing] = useState(false)
  const scrub = useRef<{ startX: number; startValue: number } | null>(null)

  useEffect(() => {
    if (!editing) setDraft(value == null ? '' : String(value))
  }, [value, editing])

  function commitDraft(): void {
    setEditing(false)
    const trimmed = draft.trim()
    if (trimmed === '' || trimmed === 'auto') {
      if (value != null) onCommit(null)
      return
    }
    const n = Number(trimmed.replace(/px|%$/, ''))
    if (!Number.isFinite(n)) {
      setDraft(value == null ? '' : String(value))
      return
    }
    const next = clamp(n, min, max)
    if (next !== n) onClamped?.(n, next)
    if (next !== value) onCommit(next)
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>): void {
    if (e.key === 'Enter') {
      e.currentTarget.blur()
      return
    }
    if (e.key === 'Escape') {
      setDraft(value == null ? '' : String(value))
      setEditing(false)
      e.currentTarget.blur()
      return
    }
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault()
      const delta = (e.shiftKey ? 10 : step) * (e.key === 'ArrowUp' ? 1 : -1)
      const base = Number(draft) || value || 0
      const next = clamp(base + delta, min, max)
      setDraft(String(next))
      onCommit(next)
    }
  }

  function onLabelPointerDown(e: PointerEvent<HTMLSpanElement>): void {
    if (disabled || readOnly || value == null) return
    e.currentTarget.setPointerCapture(e.pointerId)
    scrub.current = { startX: e.clientX, startValue: value }
  }

  function onLabelPointerMove(e: PointerEvent<HTMLSpanElement>): void {
    if (!scrub.current) return
    const mult = e.shiftKey ? 10 : 1
    const delta = Math.round((e.clientX - scrub.current.startX) / SCRUB_PX_PER_UNIT) * mult
    const next = clamp(scrub.current.startValue + delta, min, max)
    setDraft(String(next))
    if (onScrub) onScrub(next)
  }

  function onLabelPointerUp(e: PointerEvent<HTMLSpanElement>): void {
    if (!scrub.current) return
    e.currentTarget.releasePointerCapture(e.pointerId)
    const mult = e.shiftKey ? 10 : 1
    const delta = Math.round((e.clientX - scrub.current.startX) / SCRUB_PX_PER_UNIT) * mult
    const next = clamp(scrub.current.startValue + delta, min, max)
    scrub.current = null
    if (next !== value) onCommit(next)
  }

  const showUnits = units && units.length > 1 && onUnitChange

  return (
    <div
      className={`flex h-6 min-w-0 flex-1 items-center rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] text-[11px] focus-within:border-[var(--color-accent)] ${
        disabled ? 'opacity-50' : ''
      }`}
    >
      {label && (
        <span
          onPointerDown={onLabelPointerDown}
          onPointerMove={onLabelPointerMove}
          onPointerUp={onLabelPointerUp}
          title={readOnly ? undefined : 'Arraste para ajustar'}
          className={`select-none px-1.5 text-[var(--color-text-dim)] ${readOnly ? '' : 'cursor-ew-resize'}`}
        >
          {label}
        </span>
      )}
      <input
        type="text"
        inputMode="decimal"
        disabled={disabled}
        readOnly={readOnly}
        value={draft}
        placeholder={placeholder ?? (unit === 'auto' ? 'auto' : '')}
        onFocus={() => setEditing(true)}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={readOnly ? undefined : commitDraft}
        onKeyDown={readOnly ? undefined : onKeyDown}
        className={`h-full w-full min-w-0 bg-transparent px-1 tabular-nums outline-none placeholder:text-[var(--color-text-dim)] ${
          readOnly ? 'text-[var(--color-text-dim)]' : 'text-[var(--color-text)]'
        }`}
      />
      {showUnits ? (
        <select
          value={unit}
          onChange={(e) => onUnitChange(e.target.value as NumberUnit)}
          className="h-full appearance-none bg-transparent pr-1 text-[10px] text-[var(--color-text-dim)] outline-none"
        >
          {units.map((u) => (
            <option key={u} value={u}>
              {u}
            </option>
          ))}
        </select>
      ) : (
        unit !== 'auto' &&
        unit !== 'none' && (
          <span className="pr-1.5 text-[10px] text-[var(--color-text-dim)]">{unit}</span>
        )
      )}
    </div>
  )
}
