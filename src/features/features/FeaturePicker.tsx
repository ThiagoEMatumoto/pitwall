import { useEffect, useMemo, useRef, useState } from 'react'
import { Pin, Search } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import { selectPickableFeatures, type FeatureWithActivity } from './feature-activity'
import { isPinned } from './feature-pin'
import { STATUS_META } from './status'

interface Props {
  /** Fonte já carregada pelo consumidor (`list()` ou `listWithStats()`). */
  features: FeatureWithActivity[]
  /** Feature vinculada hoje; marca o item ativo. */
  value: string | null
  /** Escolha do usuário. `null` só chega quando `allowNone`. */
  onPick: (featureId: string | null) => void
  /** Fechar sem escolher (Esc / clique fora). */
  onClose: () => void
  /** Recorte por repo — o consumidor decide se faz sentido. */
  repoId?: string | null
  /** Oferece "— sem vínculo —" no topo. Default false. */
  allowNone?: boolean
  /** Borda de ancoragem no wrapper `relative` do consumidor. Default 'left'. */
  align?: 'left' | 'right'
  testId?: string
}

// Painel de escolha de feature: busca por título, em foco primeiro, o resto por
// atividade recente, arquivadas fora. Só o PAINEL — quem abre (campo do diálogo,
// chip do header) fica com o consumidor, que também controla o `open`.
export function FeaturePicker({
  features,
  value,
  onPick,
  onClose,
  repoId = null,
  allowNone = false,
  align = 'left',
  testId = 'feature-picker',
}: Props) {
  const [query, setQuery] = useState('')
  const panelRef = useRef<HTMLDivElement>(null)

  // Clique fora / Esc fecham. `mousedown` (e não `click`) porque o clique no
  // trigger do consumidor só chega depois — fechar aqui e reabrir lá viraria
  // um toggle invisível.
  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (!panelRef.current?.contains(e.target as Node)) onClose()
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [onClose])

  const listed = useMemo(
    () => selectPickableFeatures(features, { repoId, query }),
    [features, repoId, query],
  )

  return (
    <div
      ref={panelRef}
      data-testid={testId}
      role="listbox"
      className={`absolute top-full z-50 mt-1 max-h-72 w-72 overflow-hidden rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] shadow-lg ${
        align === 'right' ? 'right-0' : 'left-0'
      }`}
    >
      <div className="flex items-center gap-2 border-b border-[var(--color-border)] px-2.5 py-1.5">
        <Icon as={Search} size={12} className="shrink-0 text-[var(--color-text-dim)]" />
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Buscar frente…"
          aria-label="Buscar frente"
          data-testid={`${testId}-search`}
          className="w-full bg-transparent text-xs outline-none placeholder:text-[var(--color-text-dim)]"
        />
      </div>
      <div className="max-h-60 overflow-y-auto py-1">
        {allowNone && (
          <button
            type="button"
            role="option"
            aria-selected={value === null}
            data-testid={`${testId}-none`}
            onClick={() => onPick(null)}
            className="flex w-full items-center px-2.5 py-1.5 text-left text-xs text-[var(--color-text-dim)] hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text)]"
          >
            — sem vínculo —
          </button>
        )}
        {listed.length === 0 && (
          <div className="px-2.5 py-2 text-xs text-[var(--color-text-dim)]">
            Nenhuma frente encontrada.
          </div>
        )}
        {listed.map((f) => {
          const meta = STATUS_META[f.status]
          const on = f.id === value
          return (
            <button
              key={f.id}
              type="button"
              role="option"
              aria-selected={on}
              data-feature-id={f.id}
              onClick={() => onPick(f.id)}
              title={`${f.title} — ${meta.label}`}
              className={`flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs transition hover:bg-[var(--color-surface-2)] ${
                on ? 'text-[var(--color-accent)]' : 'text-[var(--color-text)]'
              }`}
            >
              <span
                className="h-1.5 w-1.5 shrink-0 rounded-full"
                style={{ background: meta.color }}
              />
              <span className="min-w-0 flex-1 truncate">{f.title}</span>
              {isPinned(f) && (
                <Icon
                  as={Pin}
                  size={10}
                  className="shrink-0 text-[var(--color-accent)]"
                  aria-label="em foco"
                />
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}
