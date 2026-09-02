import { useState } from 'react'

// Paleta por speaker: 6 tokens do tema, atribuídos pela ordem de aparição.
// 'me' nunca passa por aqui — fica com o accent.
export const SPEAKER_COLORS = [
  'var(--color-accent2)',
  'var(--color-info)',
  'var(--color-success)',
  'var(--color-warning)',
  'var(--color-violet)',
  'var(--color-accent-dim)',
] as const

export function speakerColor(index: number): string {
  return SPEAKER_COLORS[index % SPEAKER_COLORS.length]
}

interface Props {
  label: string
  /** Sem onRename o label é só texto (trilha 'me' ou segmento sem diarização). */
  onRename?: (name: string) => void
  color?: string
  className?: string
}

export function SpeakerName({ label, onRename, color, className = '' }: Props) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(label)

  if (!onRename) {
    return (
      <span className={className} style={color ? { color } : undefined}>
        {label}
      </span>
    )
  }

  const commit = () => {
    setEditing(false)
    const next = draft.trim()
    if (next && next !== label) onRename(next)
  }

  if (editing) {
    return (
      <input
        autoFocus
        aria-label={`Renomear ${label}`}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit()
          if (e.key === 'Escape') {
            setDraft(label)
            setEditing(false)
          }
        }}
        className="w-32 rounded border border-[var(--color-accent)]/60 bg-[var(--color-surface)] px-1 text-[var(--color-text)] outline-none"
      />
    )
  }

  return (
    <button
      type="button"
      title="Renomear participante"
      onClick={() => {
        setDraft(label)
        setEditing(true)
      }}
      className={`rounded px-0.5 hover:bg-[var(--color-surface-2)] hover:underline ${className}`}
      style={color ? { color } : undefined}
    >
      {label}
    </button>
  )
}
