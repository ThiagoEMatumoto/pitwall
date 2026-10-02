import type { ReactNode } from 'react'
import { hintText, type ShortcutHint } from './shortcut-hints'

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-[5px] py-[2px] font-mono text-[10px] leading-none text-[var(--color-text)]">
      {children}
    </kbd>
  )
}

// text-dim sobre a superfície passa de 7:1; o que derrubava o contraste era a
// opacidade e a tecla misturada ao texto.
export function ShortcutHints({
  hints,
  className = '',
  testId,
}: {
  hints: ShortcutHint[]
  className?: string
  testId?: string
}) {
  return (
    <span
      data-testid={testId}
      aria-label={hintText(hints)}
      className={`flex items-center gap-3 text-[11px] text-[var(--color-text-dim)] ${className}`}
    >
      {hints.map((h) => (
        <span key={h.label} className="flex shrink-0 items-center gap-1">
          {h.keys.map((k, i) => (
            <span key={k} className="flex items-center gap-1">
              {i > 0 && <span aria-hidden>/</span>}
              <Kbd>{k}</Kbd>
            </span>
          ))}
          <span>{h.label}</span>
        </span>
      ))}
    </span>
  )
}
