import { useState } from 'react'

// Paleta por speaker, atribuída pela ordem de aparição na reunião.
// 'me' nunca passa por aqui — fica com o accent.
//
// Os 4 temas são escuros (bg ≈ #08-#10) e o texto é fixo, então cores claras
// e saturadas funcionam em todos. A ordem foi escolhida para que os 3 primeiros
// participantes (caso comum) fiquem a >=25° de hue de qualquer accent de tema
// (roxo/verde/ciano/laranja) e que dois índices vizinhos nunca sejam da mesma
// família — em especial, sem dois azuis seguidos (era o caso accent2 → info).
export const SPEAKER_COLORS = [
  '#F5C542', // amarelo
  '#F472B6', // rosa
  '#A3E635', // lima
  'var(--color-info)', // azul (#7FA7E8, fixo entre temas)
  'var(--color-danger)', // coral (#FF8D75, fixo entre temas)
  '#2EC4B6', // teal
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
