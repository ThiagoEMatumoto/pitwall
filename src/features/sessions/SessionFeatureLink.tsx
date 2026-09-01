import { useState } from 'react'
import { Link2, Target } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import { FeaturePicker } from '@/features/features/FeaturePicker'
import { LivenessChip } from '@/features/features/LivenessChip'
import type { FeatureWithActivity } from '@/features/features/feature-activity'
import { featuresApi, sessionsApi } from '@/lib/ipc'
import { navigateToFeature } from '@/lib/nav'
import { useSessionFeatureStore } from '@/store/sessionFeatureStore'
import type { SessionFeature } from './useSessionFeature'

interface Props {
  /** Feature vinculada hoje; `null` = sessão solta. */
  feature: SessionFeature | null
  /** Sem id de sessão não há o que gravar: sobra só o chip de leitura. */
  sessionId?: string
  /** Recorte do picker; sessão avulsa (sem repo) vê todas as frentes. */
  repoId?: string | null
}

// Identidade de frente da sessão no header: o chip de volta pro dossiê (quando
// há vínculo) e a ação de vincular/trocar — o meio da sessão é justamente onde a
// pessoa descobre a qual frente aquilo pertence.
export function SessionFeatureLink({ feature, sessionId, repoId = null }: Props) {
  const [open, setOpen] = useState(false)
  const [features, setFeatures] = useState<FeatureWithActivity[]>([])
  const note = useSessionFeatureStore((s) => s.note)

  function toggle() {
    if (open) {
      setOpen(false)
      return
    }
    setOpen(true)
    // Carrega na abertura, não no mount: o header monta em toda pane e a lista
    // de frentes não vale um IPC por sessão viva.
    void featuresApi.listWithStats().then(setFeatures)
  }

  function pick(featureId: string | null) {
    setOpen(false)
    if (!sessionId || featureId === null || featureId === feature?.id) return
    void sessionsApi.setFeature(sessionId, featureId).then(() => {
      // O índice reverso é do renderer: sem isto as outras superfícies (abas,
      // strip, switcher, palette) só veriam o vínculo novo depois de um reload.
      note(sessionId, featureId)
    })
  }

  return (
    <div className="relative flex min-w-0 shrink items-center gap-1">
      {feature && (
        <button
          type="button"
          data-testid="header-feature-chip"
          onClick={() => navigateToFeature(feature.id)}
          title={`Voltar para a feature: ${feature.title}`}
          aria-label={`Voltar para a feature ${feature.title}`}
          className="flex min-w-0 shrink items-center gap-1.5 rounded-full border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-0.5 text-[10px] text-[var(--color-text-dim)] transition hover:border-[var(--color-accent)] hover:text-[var(--color-text)]"
        >
          <Icon as={Target} size={10} />
          <span className="max-w-32 truncate">{feature.title}</span>
          {feature.liveness && (
            <LivenessChip
              liveness={feature.liveness}
              lastActivityAt={feature.lastActivityAt}
              issues={feature.issues}
            />
          )}
        </button>
      )}
      {sessionId &&
        (feature ? (
          // Trocar fica separado do chip de propósito: o clique no chip continua
          // sendo a volta pro dossiê (comportamento que já existia).
          <button
            type="button"
            data-testid="header-feature-change"
            onClick={toggle}
            title="Trocar a frente desta sessão"
            aria-label="Trocar a frente desta sessão"
            className={`shrink-0 rounded p-0.5 text-[var(--color-text-dim)] transition-opacity focus-visible:opacity-100 group-hover:opacity-100 hover:text-[var(--color-accent)] ${
              open ? 'opacity-100' : 'opacity-0'
            }`}
          >
            <Icon as={Link2} size={11} />
          </button>
        ) : (
          <button
            type="button"
            data-testid="header-feature-link"
            onClick={toggle}
            title="Vincular esta sessão a uma frente de trabalho"
            aria-label="Vincular a uma frente"
            className={`flex shrink-0 items-center gap-1 rounded-full border border-dashed border-[var(--color-border)] px-2 py-0.5 text-[10px] text-[var(--color-text-dim)] transition focus-visible:opacity-100 group-hover:opacity-100 hover:border-[var(--color-accent)] hover:text-[var(--color-text)] ${
              open ? 'opacity-100' : 'opacity-0'
            }`}
          >
            <Icon as={Link2} size={10} />
            <span>vincular a uma frente</span>
          </button>
        ))}
      {open && (
        <FeaturePicker
          features={features}
          value={feature?.id ?? null}
          onPick={pick}
          onClose={() => setOpen(false)}
          repoId={repoId}
          testId="header-feature-picker"
        />
      )}
    </div>
  )
}
