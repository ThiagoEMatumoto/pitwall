import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/Button'
import { featuresApi } from '@/lib/ipc'
import { OBJECTIVE_MAX_LENGTH } from '../../../shared/feature-loop'

interface Props {
  featureId: string
  objective: string | null
  /** Muda de valor => abre a edição (a faixa de issues aponta pra cá). */
  editSignal?: number
  onSaved?: () => void
}

// O "Resumo" (features.objective) era só leitura no dossiê: a issue
// objective_missing não tinha pra onde levar dentro do app. Agora o próprio
// campo edita — mesma gramática do FeaturePulse (clicar no vazio abre).
export function FeatureObjectiveField({ featureId, objective, editSignal, onSaved }: Props) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const textarea = useRef<HTMLTextAreaElement>(null)
  const firstSignal = useRef(editSignal)

  useEffect(() => {
    setEditing(false)
    setError(null)
  }, [featureId])

  useEffect(() => {
    // Ignora o valor inicial: só o INCREMENTO (um clique na faixa) abre.
    if (editSignal === undefined || editSignal === firstSignal.current) return
    setDraft(objective ?? '')
    setError(null)
    setEditing(true)
  }, [editSignal, objective])

  useEffect(() => {
    if (editing) textarea.current?.focus()
  }, [editing])

  const over = draft.length > OBJECTIVE_MAX_LENGTH

  async function handleSave() {
    if (saving || over) return
    setSaving(true)
    setError(null)
    try {
      const trimmed = draft.trim()
      await featuresApi.update({ id: featureId, objective: trimmed === '' ? null : trimmed })
      setEditing(false)
      onSaved?.()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  if (!editing) {
    if (!objective) return null
    return (
      <p className="mt-2 text-sm text-[var(--color-text-dim)]">
        <span className="font-medium text-[var(--color-text)]">Resumo: </span>
        {objective}
        <button
          type="button"
          data-testid="feature-objective-edit"
          onClick={() => {
            setDraft(objective)
            setEditing(true)
          }}
          className="ml-2 text-[11px] text-[var(--color-text-dim)] underline decoration-dotted underline-offset-2 transition hover:text-[var(--color-text)]"
        >
          editar
        </button>
      </p>
    )
  }

  return (
    <div className="mt-2 flex flex-col gap-1.5" data-testid="feature-objective-editor">
      <textarea
        ref={textarea}
        aria-label="Objetivo da feature"
        value={draft}
        rows={2}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setEditing(false)
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void handleSave()
        }}
        placeholder="O que esta frente precisa entregar."
        className="w-full resize-y rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]"
      />
      <div className="flex items-center gap-3">
        <span
          className="font-mono text-[11px] tabular-nums"
          style={{ color: over ? 'var(--color-danger)' : 'var(--color-text-dim)' }}
        >
          {draft.length}/{OBJECTIVE_MAX_LENGTH}
        </span>
        {error && <span className="text-[11px] text-[var(--color-danger)]">{error}</span>}
        <div className="ml-auto flex items-center gap-2">
          <Button variant="ghost" onClick={() => setEditing(false)}>
            Cancelar
          </Button>
          <Button onClick={() => void handleSave()} loading={saving} disabled={over}>
            Salvar objetivo
          </Button>
        </div>
      </div>
    </div>
  )
}
