import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ColorSelect } from '@/components/ui/ColorSelect'

export interface TokenOption {
  name: string
  value: string
}

interface Props {
  value: string
  onCommit: (value: string) => void
  tokens?: readonly TokenOption[]
  placeholder?: string
  // Computed colour shown as swatch + placeholder while there is no inline value.
  computed?: string
}

const HEX_RE = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i
const TOKEN_RE = /^var\(--color-([a-z0-9_-]+)\)$/i

// "var(--color-surface)" does not fit the field; at rest it reads as the
// token's name. The raw value comes back while editing.
export function displayColor(value: string): string {
  const m = TOKEN_RE.exec(value.trim())
  return m ? `token: ${m[1]}` : value
}

// Swatch background: a var(--token) resolves inside the app chrome, not in
// the artboard, so we show the token's declared value instead.
function swatchColor(value: string, tokens: readonly TokenOption[]): string {
  const m = TOKEN_RE.exec(value.trim())
  if (m) return tokens.find((t) => t.name === m[1])?.value ?? 'transparent'
  return value || 'transparent'
}

export function ColorField({ value, onCommit, tokens = [], placeholder, computed }: Props) {
  const [draft, setDraft] = useState(value)
  const [open, setOpen] = useState(false)
  const [focused, setFocused] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => setDraft(value), [value])

  // Focusing swaps "token: text" for the raw var, which drops the caret at
  // the end; select it all so typing replaces instead of appending.
  useLayoutEffect(() => {
    if (focused) inputRef.current?.select()
  }, [focused])

  useEffect(() => {
    if (!open) return
    function onDocDown(e: MouseEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDocDown)
    return () => document.removeEventListener('mousedown', onDocDown)
  }, [open])

  function commit(next: string): void {
    const trimmed = next.trim()
    setDraft(trimmed)
    if (trimmed !== value) onCommit(trimmed)
  }

  const pickerValue = HEX_RE.test(value)
    ? value
    : HEX_RE.test(computed ?? '')
      ? computed!
      : '#000000'

  return (
    <div ref={rootRef} className="relative">
      <div className="flex h-6 items-center gap-1.5 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] pl-1 text-[11px] focus-within:border-[var(--color-accent)]">
        <button
          type="button"
          aria-label="Escolher cor"
          onClick={() => setOpen((o) => !o)}
          className="h-4 w-4 shrink-0 rounded-sm border border-[var(--color-border)]"
          style={{ background: swatchColor(value || computed || '', tokens) }}
        />
        <input
          ref={inputRef}
          type="text"
          value={focused ? draft : displayColor(draft)}
          title={draft || undefined}
          placeholder={placeholder ?? computed ?? '—'}
          spellCheck={false}
          onChange={(e) => setDraft(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            setFocused(false)
            commit(draft)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur()
            if (e.key === 'Escape') {
              setDraft(value)
              e.currentTarget.blur()
            }
          }}
          className="h-full w-full min-w-0 bg-transparent pr-1 font-mono text-[var(--color-text)] outline-none placeholder:text-[var(--color-text-dim)]"
        />
      </div>
      {open && (
        <div className="absolute left-0 top-full z-30 mt-1 w-56 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-2 shadow-xl">
          <ColorSelect
            value={pickerValue}
            onChange={(hex) => {
              commit(hex)
            }}
          />
          {tokens.length > 0 && (
            <div className="mt-2 border-t border-[var(--color-border)] pt-2">
              <div className="mb-1 text-[10px] uppercase tracking-wider text-[var(--color-text-dim)]">
                Tokens
              </div>
              <ul className="flex max-h-40 flex-col overflow-y-auto">
                {tokens.map((t) => (
                  <li key={t.name}>
                    <button
                      type="button"
                      onClick={() => {
                        commit(`var(--color-${t.name})`)
                        setOpen(false)
                      }}
                      className="flex w-full items-center gap-2 rounded px-1 py-0.5 text-left text-[11px] text-[var(--color-text-dim)] transition hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text)]"
                    >
                      <span
                        className="h-3 w-3 rounded-sm border border-[var(--color-border)]"
                        style={{ background: t.value }}
                      />
                      <span className="truncate">{t.name}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
