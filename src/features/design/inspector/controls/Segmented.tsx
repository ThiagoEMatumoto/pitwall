import type { ComponentType } from 'react'
import type { LucideProps } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'

export interface SegmentedOption<T extends string> {
  value: T
  label?: string
  icon?: ComponentType<LucideProps>
  title?: string
}

interface Props<T extends string> {
  value: T | null
  options: readonly SegmentedOption<T>[]
  onChange: (value: T) => void
}

export function Segmented<T extends string>({ value, options, onChange }: Props<T>) {
  return (
    <div className="flex h-6 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-px">
      {options.map((opt) => {
        const active = opt.value === value
        return (
          <button
            key={opt.value}
            type="button"
            title={opt.title ?? opt.label ?? opt.value}
            onClick={() => onChange(opt.value)}
            className={`flex flex-1 items-center justify-center gap-1 rounded-[5px] px-1 text-[11px] transition ${
              active
                ? 'bg-[var(--color-surface-2)] text-[var(--color-text)]'
                : 'text-[var(--color-text-dim)] hover:text-[var(--color-text)]'
            }`}
          >
            {opt.icon && <Icon as={opt.icon} size={12} />}
            {opt.label}
          </button>
        )
      })}
    </div>
  )
}
