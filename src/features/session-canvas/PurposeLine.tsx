import { useEffect, useRef, useState } from 'react'
import type { SessionGraphNode } from '../../../shared/types/session-graph'
import { useMapActions } from './map-context'

// Só o propósito do usuário entra no campo: o derivado (tarefa do handoff, 1º
// prompt cortado em "…") vira placeholder, senão sair sem mexer o gravaria como
// escolha do usuário e a precedência handoff/transcript se perderia.
export function PurposeLine({
  sessionId,
  purpose,
  source,
}: {
  sessionId: string
  purpose: string | null
  source: SessionGraphNode['purposeSource']
}) {
  const actions = useMapActions()
  const editing = actions.editingPurposeId === sessionId
  const initial = source === 'user' ? (purpose ?? '') : ''
  const [draft, setDraft] = useState(initial)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!editing) return
    setDraft(initial)
    requestAnimationFrame(() => inputRef.current?.select())
  }, [editing, initial])

  const commit = () => {
    const next = draft.trim()
    if (next === initial.trim()) actions.cancelEdit()
    else actions.savePurpose(sessionId, next || null)
  }

  if (editing) {
    return (
      <input
        ref={inputRef}
        value={draft}
        aria-label="Propósito da sessão"
        maxLength={200}
        placeholder={source !== 'user' && purpose ? purpose : 'Do que esta sessão se trata?'}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Enter') commit()
          if (e.key === 'Escape') actions.cancelEdit()
        }}
        onBlur={commit}
        className="nodrag w-full rounded border border-[var(--color-accent)] bg-[var(--color-bg)] px-1.5 py-0.5 text-[13px] text-[var(--color-text)] outline-none"
      />
    )
  }
  // Sem propósito, nada ocupa a linha: o convite é o ✎ do cabeçalho (no hover).
  if (!purpose) return null
  return (
    <div
      data-testid="card-purpose"
      title={`${purpose}\n\nDuplo clique para editar`}
      onDoubleClick={(e) => {
        e.stopPropagation()
        actions.startEditPurpose(sessionId)
      }}
      className="line-clamp-2 shrink-0 cursor-text text-[13px] leading-snug text-[var(--color-text)]"
    >
      {purpose}
    </div>
  )
}
