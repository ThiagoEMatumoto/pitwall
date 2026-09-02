import { ChevronDown } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'

export interface SelectOption {
  value: string
  label?: string
}

interface Props {
  value: string
  options: readonly (SelectOption | string)[]
  onChange: (value: string) => void
  // Shown as an extra option when the current value is not in the list.
  allowCustom?: boolean
}

export function SelectField({ value, options, onChange, allowCustom }: Props) {
  const list = options.map((o) => (typeof o === 'string' ? { value: o, label: o } : o))
  const known = list.some((o) => o.value === value)
  return (
    <div className="relative min-w-0 flex-1">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-6 w-full appearance-none rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] pl-2 pr-6 text-[11px] text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]"
      >
        {!known && (allowCustom || value) && <option value={value}>{value || '—'}</option>}
        {list.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label ?? o.value}
          </option>
        ))}
      </select>
      <span className="pointer-events-none absolute right-1.5 top-1/2 -translate-y-1/2 text-[var(--color-text-dim)]">
        <Icon as={ChevronDown} size={12} />
      </span>
    </div>
  )
}
