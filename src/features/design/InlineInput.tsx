import { useState } from 'react'

const DEFAULT_CLASS =
  'mx-2 my-1 h-6 w-[calc(100%-16px)] rounded-md border border-[var(--color-accent)] bg-[var(--color-bg)] px-2 text-[11px] text-[var(--color-text)] outline-none'

// Enter or blur submits the trimmed value (empty = cancel); Escape cancels.
export function InlineInput({
  placeholder,
  initial = '',
  label,
  className = DEFAULT_CLASS,
  onSubmit,
  onCancel,
}: {
  placeholder: string
  initial?: string
  label?: string
  className?: string
  onSubmit: (value: string) => void
  onCancel: () => void
}) {
  const [value, setValue] = useState(initial)
  function submit(): void {
    const v = value.trim()
    if (v) onSubmit(v)
    else onCancel()
  }
  return (
    <input
      autoFocus
      type="text"
      value={value}
      placeholder={placeholder}
      aria-label={label ?? placeholder}
      onChange={(e) => setValue(e.target.value)}
      onBlur={submit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') submit()
        if (e.key === 'Escape') onCancel()
      }}
      className={className}
    />
  )
}
