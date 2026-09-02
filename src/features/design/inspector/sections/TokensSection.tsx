import { useState } from 'react'
import { Plus, X } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import { useDesignStore } from '@/store/designStore'
import type { DesignTokenCategory, DesignTokens } from '@shared/types/design'
import { ColorField } from '../controls/ColorField'
import { Section } from '../controls/Section'

const CATEGORIES: Array<{ id: DesignTokenCategory; label: string }> = [
  { id: 'color', label: 'Cores' },
  { id: 'spacing', label: 'Espaçamento' },
  { id: 'radius', label: 'Raio' },
  { id: 'font', label: 'Fontes' },
  { id: 'shadow', label: 'Sombras' },
]

const NAME_RE = /^[a-z0-9][a-z0-9-]*$/i

function ValueInput({ value, onCommit }: { value: string; onCommit: (v: string) => void }) {
  const [draft, setDraft] = useState(value)
  return (
    <input
      type="text"
      value={draft}
      spellCheck={false}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => draft.trim() !== value && onCommit(draft.trim())}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur()
      }}
      className="h-6 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 font-mono text-[11px] text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]"
    />
  )
}

function Category({
  category,
  label,
  tokens,
  onChange,
}: {
  category: DesignTokenCategory
  label: string
  tokens: DesignTokens
  onChange: (next: DesignTokens) => void
}) {
  const entries = Object.entries(tokens[category] ?? {})
  const [newName, setNewName] = useState('')
  const [adding, setAdding] = useState(false)

  function setValue(name: string, value: string): void {
    onChange({ ...tokens, [category]: { ...tokens[category], [name]: value } })
  }

  function remove(name: string): void {
    const { [name]: _gone, ...rest } = tokens[category] ?? {}
    onChange({ ...tokens, [category]: rest })
  }

  function add(): void {
    const name = newName.trim()
    setAdding(false)
    setNewName('')
    if (!NAME_RE.test(name) || tokens[category]?.[name] != null) return
    setValue(name, category === 'color' ? '#000000' : '')
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-wider text-[var(--color-text-dim)]">{label}</span>
        <button
          type="button"
          title={`Novo token de ${label.toLowerCase()}`}
          onClick={() => setAdding(true)}
          className="flex h-5 w-5 items-center justify-center rounded text-[var(--color-text-dim)] transition hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text)]"
        >
          <Icon as={Plus} size={12} />
        </button>
      </div>
      {entries.map(([name, value]) => (
        <div key={name} className="grid grid-cols-[72px_1fr_20px] items-center gap-1">
          <span className="truncate font-mono text-[11px] text-[var(--color-text)]" title={`--${category}-${name}`}>
            {name}
          </span>
          {category === 'color' ? (
            <ColorField value={value} onCommit={(v) => setValue(name, v)} />
          ) : (
            <ValueInput key={value} value={value} onCommit={(v) => setValue(name, v)} />
          )}
          <button
            type="button"
            title="Remover token"
            onClick={() => remove(name)}
            className="flex h-5 w-5 items-center justify-center rounded text-[var(--color-text-dim)] transition hover:text-[var(--color-danger)]"
          >
            <Icon as={X} size={12} />
          </button>
        </div>
      ))}
      {adding && (
        <input
          autoFocus
          type="text"
          value={newName}
          placeholder="nome-do-token"
          onChange={(e) => setNewName(e.target.value)}
          onBlur={add}
          onKeyDown={(e) => {
            if (e.key === 'Enter') add()
            if (e.key === 'Escape') {
              setAdding(false)
              setNewName('')
            }
          }}
          className="h-6 w-full rounded-md border border-[var(--color-accent)] bg-[var(--color-bg)] px-2 font-mono text-[11px] text-[var(--color-text)] outline-none"
        />
      )}
    </div>
  )
}

export function TokensSection() {
  const tokens = useDesignStore((s) => s.doc?.tokens)
  const setTokens = useDesignStore((s) => s.setTokens)
  if (!tokens) return null
  return (
    <Section title="Tokens" defaultOpen={false}>
      {CATEGORIES.map((c) => (
        <Category key={c.id} category={c.id} label={c.label} tokens={tokens} onChange={(next) => void setTokens(next)} />
      ))}
    </Section>
  )
}
