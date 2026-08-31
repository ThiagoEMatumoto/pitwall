import { Pin, PinOff, Radio } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import { activeMarker } from '@/features/brand'
import { relativeTime } from '@/lib/time'
import type { FeatureLoopSnapshot } from '../../../shared/types/ipc'
import type { Feature, FeatureWithStats, Repo } from '../../../shared/types/ipc'
import { FeatureList } from './FeatureList'
import { LivenessChip } from './LivenessChip'

interface Props {
  /** Pinadas, já na ordem da parede (focusRank). */
  pinned: Feature[]
  /** O resto, já ordenado por atividade real pela FeaturesArea. */
  features: Feature[]
  snapshots: Map<string, FeatureLoopSnapshot>
  liveByFeature: Map<string, number>
  reposById: Map<string, Repo>
  sessionCounts: Map<string, number>
  statsById: Map<string, FeatureWithStats>
  selectedId: string | null
  onSelect: (id: string) => void
  onArchive: (id: string) => void
  onTogglePin: (id: string, pinned: boolean) => void
}

// A parede é a view default das Features: em cima o que o usuário declarou que
// importa AGORA (pinadas, com pulso e vitalidade à vista), embaixo o resto por
// atividade real. É a resposta direta ao "features isoladas, esquecidas": o
// esquecimento acontece quando nada tem primeiro plano.
export function FeatureWall({
  pinned,
  features,
  snapshots,
  liveByFeature,
  reposById,
  sessionCounts,
  statsById,
  selectedId,
  onSelect,
  onArchive,
  onTogglePin,
}: Props) {
  return (
    <div className="flex flex-col gap-6" data-testid="feature-wall">
      <section>
        <header className="mb-3 flex items-center gap-2">
          <Icon as={Pin} size={13} className="text-[var(--color-accent)]" />
          <h2 className="text-sm font-semibold text-[var(--color-text)]">Em foco</h2>
          <span className="rounded-full bg-[var(--color-surface-2)] px-2 py-0.5 font-mono text-[10px] tabular-nums text-[var(--color-text-dim)]">
            {pinned.length}
          </span>
        </header>

        {pinned.length === 0 ? (
          <EmptyFocus candidate={features[0] ?? null} onPin={(id) => onTogglePin(id, true)} />
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {pinned.map((f) => (
              <PinnedCard
                key={f.id}
                feature={f}
                snapshot={snapshots.get(f.id) ?? null}
                live={liveByFeature.get(f.id) ?? 0}
                stats={statsById.get(f.id)}
                active={f.id === selectedId}
                onSelect={() => onSelect(f.id)}
                onUnpin={() => onTogglePin(f.id, false)}
              />
            ))}
          </ul>
        )}
      </section>

      <section>
        <header className="mb-3 flex items-center gap-2">
          <h2 className="text-sm font-semibold text-[var(--color-text)]">Por atividade</h2>
          <span className="text-[11px] text-[var(--color-text-dim)]">
            o que foi tocado mais recentemente primeiro
          </span>
        </header>
        <FeatureList
          features={features}
          reposById={reposById}
          sessionCounts={sessionCounts}
          statsById={statsById}
          selectedId={selectedId}
          onSelect={onSelect}
          onArchive={onArchive}
          onTogglePin={onTogglePin}
        />
      </section>
    </div>
  )
}

// Vazio que CONVIDA: além de explicar, oferece o gesto com a candidata óbvia
// (a mais ativa) já preenchida — um clique, não um caça-ao-botão.
function EmptyFocus({
  candidate,
  onPin,
}: {
  candidate: Feature | null
  onPin: (id: string) => void
}) {
  return (
    <div
      data-testid="feature-wall-empty-focus"
      className="rounded-[14px] border border-dashed border-[var(--color-border)] px-4 py-5 text-center"
    >
      <p className="text-sm text-[var(--color-text)]">Nada em foco ainda.</p>
      <p className="mt-1 text-xs text-[var(--color-text-dim)]">
        Fixe as frentes que você está tocando nesta semana — elas sobem pra cá com o pulso à vista,
        e param de se perder no meio da lista.
      </p>
      {candidate && (
        <button
          type="button"
          data-testid="feature-wall-pin-suggestion"
          onClick={() => onPin(candidate.id)}
          className="mt-3 inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium transition"
          style={{
            borderColor: 'color-mix(in srgb, var(--color-accent) 45%, transparent)',
            color: 'var(--color-accent)',
            background: 'color-mix(in srgb, var(--color-accent) 12%, transparent)',
          }}
        >
          <Icon as={Pin} size={13} />
          Fixar “{candidate.title}”
        </button>
      )}
    </div>
  )
}

function PinnedCard({
  feature,
  snapshot,
  live,
  stats,
  active,
  onSelect,
  onUnpin,
}: {
  feature: Feature
  snapshot: FeatureLoopSnapshot | null
  live: number
  stats?: FeatureWithStats
  active: boolean
  onSelect: () => void
  onUnpin: () => void
}) {
  const lastActivity = snapshot?.lastActivityAt ?? stats?.lastRecordAt ?? feature.updatedAt
  return (
    <li>
      {/* div role=button (não <button>): o desafixar é um botão aninhado. */}
      <div
        role="button"
        tabIndex={0}
        data-testid="feature-wall-card"
        data-feature-id={feature.id}
        onClick={onSelect}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            onSelect()
          }
        }}
        className={`group flex h-full cursor-pointer flex-col rounded-[14px] border px-4 py-3.5 text-left transition ${
          active
            ? `border-[var(--color-accent)] bg-[var(--color-surface-2)] ${activeMarker}`
            : 'border-[var(--color-border)] bg-[var(--color-surface)] hover:bg-[var(--color-surface-2)]/60'
        }`}
      >
        <div className="flex items-start justify-between gap-2">
          <h3 className="min-w-0 flex-1 text-sm font-semibold leading-snug text-[var(--color-text)]">
            {feature.title}
          </h3>
          <button
            type="button"
            data-testid="feature-wall-unpin"
            title="Tirar do foco"
            onClick={(e) => {
              e.stopPropagation()
              onUnpin()
            }}
            className="shrink-0 rounded p-1 text-[var(--color-text-dim)] transition hover:bg-[var(--color-bg)] hover:text-[var(--color-text)]"
          >
            <Icon as={PinOff} size={13} />
          </button>
        </div>

        {snapshot?.pulse ? (
          <p className="mt-2 line-clamp-3 text-xs leading-relaxed text-[var(--color-text)]">
            {snapshot.pulse.body}
          </p>
        ) : (
          <p className="mt-2 text-xs italic text-[var(--color-text-dim)]">
            sem pulso — abra o dossiê e escreva em uma frase como a frente vai agora
          </p>
        )}

        <div className="mt-auto flex flex-wrap items-center gap-2 pt-3">
          {snapshot && (
            <LivenessChip
              liveness={snapshot.liveness}
              lastActivityAt={snapshot.lastActivityAt}
              issues={snapshot.issues}
            />
          )}
          {live > 0 && (
            <span
              data-testid="feature-wall-live"
              title={`${live} sessão(ões) desta feature rodando agora`}
              className="inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium"
              style={{
                color: 'var(--color-success)',
                borderColor: 'color-mix(in srgb, var(--color-success) 45%, transparent)',
                background: 'color-mix(in srgb, var(--color-success) 12%, transparent)',
              }}
            >
              <Icon as={Radio} size={10} />
              {live === 1 ? 'sessão viva' : `${live} sessões vivas`}
            </span>
          )}
          <span className="ml-auto text-[10px] text-[var(--color-text-dim)]">
            {relativeTime(lastActivity)}
          </span>
        </div>
      </div>
    </li>
  )
}
