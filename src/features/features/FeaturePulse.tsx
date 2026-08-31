import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, Pencil } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Icon } from '@/components/ui/Icon'
import { loopApi } from '@/lib/ipc'
import { PULSE_MAX_LENGTH } from '../../../shared/feature-loop'
import type { FeaturePulse as Pulse, PulseSource } from '../../../shared/types/ipc'

const HISTORY_LIMIT = 20

// Quem escreveu o pulso muda como ele se lê: 'sessão'/'MCP' saíram de um
// agente, não do usuário — por isso ganham cor própria, não só rótulo.
const SOURCE_META: Record<PulseSource, { label: string; color: string }> = {
  human: { label: 'você', color: 'var(--color-text-dim)' },
  session: { label: 'sessão', color: 'var(--color-accent2)' },
  mcp: { label: 'MCP', color: 'var(--color-info)' },
  seed: { label: 'inicial', color: 'var(--color-text-dim)' },
}

function fmtWhen(ts: number): string {
  return new Date(ts).toLocaleString('pt-BR', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function SourceChip({ source }: { source: PulseSource }) {
  const meta = SOURCE_META[source]
  return (
    <span
      data-testid="pulse-source"
      data-source={source}
      className="inline-flex shrink-0 items-center rounded-full border px-1.5 py-px text-[10px] font-medium"
      style={{
        color: meta.color,
        borderColor: `color-mix(in srgb, ${meta.color} 45%, transparent)`,
        background: `color-mix(in srgb, ${meta.color} 12%, transparent)`,
      }}
    >
      {meta.label}
    </span>
  )
}

interface Props {
  featureId: string
  pulse: Pulse | null
  loading?: boolean
  /** Muda de valor => abre a edição (a faixa de issues aponta pra cá). */
  focusSignal?: number
  /** Chamado após gravar — o dono do snapshot recarrega. */
  onSaved?: () => void
}

export function FeaturePulse({ featureId, pulse, loading = false, focusSignal, onSaved }: Props) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [history, setHistory] = useState<Pulse[]>([])
  const textarea = useRef<HTMLTextAreaElement>(null)
  const firstSignal = useRef(focusSignal)

  // Trocar de feature no meio da edição deixaria o rascunho da anterior no ar.
  useEffect(() => {
    setEditing(false)
    setHistoryOpen(false)
    setHistory([])
    setError(null)
  }, [featureId])

  // Recarrega também quando o pulso vigente muda: um pulso novo entra no
  // histórico e a lista aberta ficaria desatualizada.
  useEffect(() => {
    if (!historyOpen) return
    let alive = true
    void loopApi
      .pulseHistory(featureId, HISTORY_LIMIT)
      .then((items) => {
        if (alive) setHistory(items)
      })
      .catch((err: unknown) => {
        if (alive) setError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      alive = false
    }
  }, [historyOpen, featureId, pulse?.id])

  const startEdit = useCallback(() => {
    setDraft(pulse?.body ?? '')
    setError(null)
    setEditing(true)
  }, [pulse?.body])

  useEffect(() => {
    if (editing) textarea.current?.focus()
  }, [editing])

  // Ignora o valor inicial: só o INCREMENTO (um clique na faixa) abre o editor.
  useEffect(() => {
    if (focusSignal === undefined || focusSignal === firstSignal.current) return
    startEdit()
  }, [focusSignal, startEdit])

  const over = draft.length > PULSE_MAX_LENGTH
  const empty = draft.trim() === ''

  async function handleSave() {
    if (saving || over || empty) return
    setSaving(true)
    setError(null)
    try {
      await loopApi.setPulse({ featureId, body: draft.trim(), source: 'human' })
      setEditing(false)
      onSaved?.()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  // Pulsos anteriores: o vigente já está em destaque acima.
  const previous = history.filter((p) => p.id !== pulse?.id)

  return (
    <section className="mt-3">
      {editing ? (
        <div className="flex flex-col gap-1.5">
          <textarea
            ref={textarea}
            aria-label="Pulso da feature"
            value={draft}
            rows={2}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setEditing(false)
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void handleSave()
            }}
            placeholder="Como a frente vai agora, em uma frase."
            className="w-full resize-y rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]"
          />
          <div className="flex items-center gap-3">
            <span
              data-testid="pulse-counter"
              data-over={over}
              className="font-mono text-[11px] tabular-nums"
              style={{ color: over ? 'var(--color-danger)' : 'var(--color-text-dim)' }}
            >
              {draft.length}/{PULSE_MAX_LENGTH}
            </span>
            {over && (
              <span className="text-[11px] text-[var(--color-danger)]">
                Acima do limite — o pulso é uma frase, não um relatório.
              </span>
            )}
            <div className="ml-auto flex items-center gap-2">
              <Button variant="ghost" onClick={() => setEditing(false)}>
                Cancelar
              </Button>
              <Button onClick={() => void handleSave()} loading={saving} disabled={over || empty}>
                Salvar pulso
              </Button>
            </div>
          </div>
        </div>
      ) : pulse ? (
        <div className="flex items-start gap-2">
          <div className="min-w-0">
            <p className="text-base leading-snug text-[var(--color-text)]">{pulse.body}</p>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-[10px] text-[var(--color-text-dim)]">
              <span className="font-mono tabular-nums">{fmtWhen(pulse.createdAt)}</span>
              <SourceChip source={pulse.source} />
            </div>
          </div>
          <button
            type="button"
            title="Editar pulso"
            onClick={startEdit}
            className="ml-auto shrink-0 rounded p-1 text-[var(--color-text-dim)] transition hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text)]"
          >
            <Icon as={Pencil} size={13} />
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={startEdit}
          className="rounded-md border border-dashed border-[var(--color-border)] px-3 py-2 text-left text-sm text-[var(--color-text-dim)] transition hover:border-[var(--color-accent)] hover:text-[var(--color-text)]"
        >
          <span className="italic">sem pulso</span>
          <span className="ml-1.5 text-xs">
            {loading ? 'carregando…' : '— escreva em uma frase como a frente vai agora'}
          </span>
        </button>
      )}

      {error && <p className="mt-1 text-[11px] text-[var(--color-danger)]">{error}</p>}

      <div className="mt-2">
        <button
          type="button"
          onClick={() => setHistoryOpen((v) => !v)}
          aria-expanded={historyOpen}
          className="inline-flex items-center gap-1 text-[11px] text-[var(--color-text-dim)] transition hover:text-[var(--color-text)]"
        >
          <Icon as={historyOpen ? ChevronDown : ChevronRight} size={12} />
          histórico
        </button>

        {historyOpen && (
          <ol className="mt-2 flex flex-col gap-2 border-l border-[var(--color-border)] pl-3">
            {previous.length === 0 ? (
              <li className="text-[11px] text-[var(--color-text-dim)]">Sem pulsos anteriores.</li>
            ) : (
              previous.map((p) => (
                <li key={p.id} data-testid="pulse-entry" className="flex flex-col gap-0.5">
                  <div className="flex flex-wrap items-center gap-2 text-[10px] text-[var(--color-text-dim)]">
                    <span className="font-mono tabular-nums">{fmtWhen(p.createdAt)}</span>
                    <SourceChip source={p.source} />
                  </div>
                  <p className="text-xs leading-snug text-[var(--color-text-dim)]">{p.body}</p>
                </li>
              ))
            )}
          </ol>
        )}
      </div>
    </section>
  )
}
