import type { InputHTMLAttributes } from 'react'
import { Check } from 'lucide-react'
import { Icon } from './Icon'

// Checkbox do tema: o nativo desenhava um quadrado branco no tema escuro.
// O input continua nativo (teclado, foco, change); só a aparência é nossa.
export function Checkbox({ className = '', ...props }: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>) {
  return (
    <span className={`relative inline-flex size-4 shrink-0 ${className}`}>
      <input
        type="checkbox"
        {...props}
        className="peer size-4 cursor-pointer appearance-none rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] transition checked:border-[var(--color-accent)] checked:bg-[var(--color-accent)] hover:border-[var(--color-accent)] focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-1 focus-visible:outline-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-40"
      />
      <Icon
        as={Check}
        size={12}
        className="pointer-events-none absolute left-0.5 top-0.5 hidden text-[var(--color-bg)] peer-checked:block"
      />
    </span>
  )
}
