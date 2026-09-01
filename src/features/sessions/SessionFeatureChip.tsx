import { useEffect, useRef } from 'react'
import { Target } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import { navigateToFeature } from '@/lib/nav'
import { useSessionFeatureStore } from '@/store/sessionFeatureStore'

export type ChipDensity = 'chip' | 'dot'

interface Props {
  /** `sessions.id` interno — chave do índice reverso sessão → feature. */
  sessionId: string | null | undefined
  /** `chip` mostra o título; `dot` só a marca (título no tooltip). */
  density: ChipDensity
  /**
   * Vínculo já conhecido pelo chamador (veio junto no mesmo SELECT). Dispensa o
   * índice reverso — útil onde a sessão nem aparece nele (listas por repo).
   */
  featureId?: string | null
  className?: string
}

// A marca "de que frente é esta sessão", clicável, em toda superfície que lista
// sessões. Lê o índice reverso CRU (sessionFeatureStore) — nunca useSessionFeature,
// que puxa um loop snapshot por sessão e viraria N chamadas numa lista.
export function SessionFeatureChip({ sessionId, density, featureId: known, className }: Props) {
  const hydrate = useSessionFeatureStore((s) => s.hydrate)
  const indexed = useSessionFeatureStore((s) =>
    sessionId ? (s.bySessionId[sessionId] ?? null) : null,
  )
  const featureId = known ?? indexed
  const title = useSessionFeatureStore((s) =>
    featureId ? (s.featureTitles[featureId] ?? null) : null,
  )
  const ref = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    void hydrate()
  }, [hydrate])

  // O chip vive DENTRO de alvos clicáveis (linha que foca a sessão, aba do
  // dockview que troca de painel). React delega no root, então stopPropagation
  // de um handler sintético não barra listener NATIVO de ancestral — por isso os
  // listeners moram no próprio elemento, onde disparam antes de qualquer bolha.
  useEffect(() => {
    const el = ref.current
    if (!el || !featureId) return
    const stop = (e: Event) => e.stopPropagation()
    const activate = (e: Event) => {
      e.preventDefault()
      e.stopPropagation()
      navigateToFeature(featureId)
    }
    el.addEventListener('pointerdown', stop)
    el.addEventListener('mousedown', stop)
    el.addEventListener('click', activate)
    return () => {
      el.removeEventListener('pointerdown', stop)
      el.removeEventListener('mousedown', stop)
      el.removeEventListener('click', activate)
    }
    // `title` entra nas deps porque o span só existe depois que ele chega: onde
    // o featureId vem pronto por prop (SessionsModal), sem isto o efeito rodava
    // uma vez só, com ref.current ainda null, e o chip nunca ganhava o listener.
  }, [featureId, title])

  // Sessão sem feature é o caso comum: não vira ruído visual nenhum.
  if (!featureId || !title) return null

  const label = `Voltar para a feature: ${title}`
  const shared = 'shrink-0 cursor-pointer outline-none transition focus-visible:outline focus-visible:outline-1 focus-visible:outline-[var(--color-accent)]'

  return (
    <span
      ref={ref}
      role="button"
      tabIndex={0}
      data-testid="session-feature-chip"
      data-feature-id={featureId}
      title={label}
      aria-label={label}
      onKeyDown={(e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return
        e.preventDefault()
        e.stopPropagation()
        navigateToFeature(featureId)
      }}
      className={
        density === 'dot'
          ? `${shared} inline-flex items-center rounded-full text-[var(--color-accent)] opacity-70 hover:opacity-100 ${className ?? ''}`
          : `${shared} inline-flex min-w-0 max-w-full items-center gap-1 rounded-full border border-[var(--color-border)] bg-[var(--color-bg)] px-1.5 py-0.5 text-[10px] text-[var(--color-text-dim)] hover:border-[var(--color-accent)] hover:text-[var(--color-text)] ${className ?? ''}`
      }
    >
      <Icon as={Target} size={density === 'dot' ? 11 : 10} className="shrink-0" />
      {density === 'chip' && <span className="max-w-28 truncate">{title}</span>}
    </span>
  )
}
