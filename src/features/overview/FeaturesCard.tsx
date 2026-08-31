import { useState } from 'react'
import { relativeTime } from '@/lib/time'
import { useAppStore } from '@/store/appStore'
import { useFeaturesStore } from '@/store/featuresStore'
import { LivenessChip } from '@/features/features/LivenessChip'
import { STATUS_META as FEATURE_STATUS_META } from '@/features/features/status'
import { useLoopSnapshots } from '@/features/features/useLoopSnapshots'
import { isStalledFeature, selectFeaturesWithoutObjective } from '../../../shared/home-selectors'
import type {
  Feature,
  FeatureLoopSnapshot,
  OverviewFeatureActivity,
} from '../../../shared/types/ipc'
import { CardDot, CardEmpty, HomeCard } from './HomeGrid'
import { usePinnedFeatures } from './usePinnedFeatures'

// Card "Features em andamento": atividade real de sessões por feature
// (data.features do agregado), com destaque "parada >3d" via isStalledFeature
// e um resumo "sem OKR" (achado-raiz #2 da curadoria: o dado existia — Onda 0
// — mas não era exposto em lugar nenhum).
export function FeaturesCard({ features }: { features: OverviewFeatureActivity[] }) {
  const setArea = useAppStore((s) => s.setArea)
  const [now] = useState(() => Date.now())
  const withoutObjective = selectFeaturesWithoutObjective(features)
  // Em foco manda no card: se o usuário fixou alguma coisa, é ela que a Home
  // mostra (com pulso e vitalidade). Sem pin nenhum, o card segue como era —
  // atividade das features de trabalho.
  const pinned = usePinnedFeatures()
  const snapshots = useLoopSnapshots(pinned.map((f) => f.id))

  return (
    <HomeCard
      title={pinned.length > 0 ? 'Features em foco' : 'Features em andamento'}
      count={pinned.length > 0 ? pinned.length : features.length}
      dot={<CardDot color="var(--color-accent2)" />}
      action={
        <button
          type="button"
          onClick={() => setArea('features')}
          className="text-[10px] text-[var(--color-text-dim)] transition hover:text-[var(--color-accent)]"
        >
          ver todas
        </button>
      }
    >
      {withoutObjective.length > 0 && (
        <button
          type="button"
          onClick={() => setArea('features')}
          title="Features de trabalho sem vínculo a nenhum objetivo/OKR"
          className="mb-2 flex w-full items-center gap-1.5 rounded-md border border-[var(--color-info)]/40 bg-[var(--color-info)]/10 px-2.5 py-1.5 text-left text-[11px] text-[var(--color-info)] transition hover:bg-[var(--color-info)]/20"
        >
          <span className="font-semibold tabular-nums">{withoutObjective.length}</span>
          feature{withoutObjective.length === 1 ? '' : 's'} de trabalho sem OKR
        </button>
      )}
      {pinned.length > 0 ? (
        <ul className="flex flex-col gap-1.5" data-testid="home-pinned-features">
          {pinned.map((f) => (
            <PinnedRow key={f.id} feature={f} snapshot={snapshots.get(f.id) ?? null} />
          ))}
        </ul>
      ) : features.length === 0 ? (
        <CardEmpty>Nenhuma feature em andamento.</CardEmpty>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {features.map((f) => (
            <FeatureRow key={f.id} feature={f} now={now} />
          ))}
        </ul>
      )}
    </HomeCard>
  )
}

function FeatureRow({ feature, now }: { feature: OverviewFeatureActivity; now: number }) {
  const meta = FEATURE_STATUS_META[feature.status]
  const stalled = isStalledFeature(feature, now)
  return (
    <li className="flex items-center gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)]/40 px-2.5 py-1.5">
      <span
        className="h-2 w-2 shrink-0 rounded-full"
        style={{ background: meta.color }}
        title={meta.label}
      />
      <span className="min-w-0 flex-1 truncate text-sm text-[var(--color-text)]">
        {feature.title}
      </span>
      {stalled && (
        <span className="shrink-0 rounded-full border border-[var(--color-warning)] px-2 py-0.5 text-[10px] font-medium text-[var(--color-warning)]">
          parada {relativeTime(feature.lastSessionAt)}
        </span>
      )}
      <span className="shrink-0 text-[10px] tabular-nums text-[var(--color-text-dim)]">
        {feature.sessionCount === 1 ? '1 sessão' : `${feature.sessionCount} sessões`}
      </span>
      {!stalled && feature.lastSessionAt !== null && (
        <span className="shrink-0 text-[10px] tabular-nums text-[var(--color-text-dim)]">
          {relativeTime(feature.lastSessionAt)}
        </span>
      )}
    </li>
  )
}

// Linha da feature em foco: pulso truncado numa linha (é uma frase, e o card
// tem altura fixa) e o chip de vitalidade que o dossiê já usa.
function PinnedRow({
  feature,
  snapshot,
}: {
  feature: Feature
  // Vem pronto do card: buscar de novo aqui duplicaria o IPC por linha.
  snapshot: FeatureLoopSnapshot | null
}) {
  const meta = FEATURE_STATUS_META[feature.status]
  const setArea = useAppStore((s) => s.setArea)
  return (
    <li>
      <button
        type="button"
        data-testid="home-pinned-feature"
        data-feature-id={feature.id}
        onClick={() => {
          void useFeaturesStore.getState().select(feature.id)
          setArea('features')
        }}
        className="flex w-full items-center gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)]/40 px-2.5 py-1.5 text-left transition hover:bg-[var(--color-surface-2)]/60"
      >
        <CardDot color={meta.color} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm text-[var(--color-text)]">{feature.title}</span>
          <span className="block truncate text-[11px] text-[var(--color-text-dim)]">
            {snapshot?.pulse?.body ?? 'sem pulso'}
          </span>
        </span>
        {snapshot && (
          <LivenessChip
            liveness={snapshot.liveness}
            lastActivityAt={snapshot.lastActivityAt}
            issues={snapshot.issues}
          />
        )}
      </button>
    </li>
  )
}
