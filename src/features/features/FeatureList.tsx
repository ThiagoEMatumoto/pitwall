import { Archive, GitBranch, Pin, PinOff } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import { activeMarker } from '@/features/brand'
import { relativeTime } from '@/lib/time'
import { stalledDays } from '../../../shared/feature-visibility'
import type { Feature, FeatureWithStats, Repo } from '../../../shared/types/ipc'
import { isPinned } from './feature-pin'
import { STATUS_META } from './status'

interface Props {
  features: Feature[]
  reposById: Map<string, Repo>
  sessionCounts: Map<string, number>
  // Stats por feature (recordCount/lastRecordAt) — badges e horário de atividade.
  statsById: Map<string, FeatureWithStats>
  selectedId: string | null
  onSelect: (id: string) => void
  onArchive: (id: string) => void
  // Ausente onde a parede não existe (board/dossiê reaproveitam o card).
  onTogglePin?: (id: string, pinned: boolean) => void
}

export function FeatureList({
  features,
  reposById,
  sessionCounts,
  statsById,
  selectedId,
  onSelect,
  onArchive,
  onTogglePin,
}: Props) {
  if (features.length === 0) {
    return (
      <div className="py-12 text-center text-sm text-[var(--color-text-dim)]">
        Nenhuma feature corresponde ao filtro.
      </div>
    )
  }

  return (
    <ul className="flex flex-col gap-2">
      {features.map((f) => (
        <FeatureCard
          key={f.id}
          feature={f}
          reposById={reposById}
          sessions={sessionCounts.get(f.id) ?? 0}
          stats={statsById.get(f.id)}
          active={f.id === selectedId}
          onSelect={() => onSelect(f.id)}
          onArchive={() => onArchive(f.id)}
          onTogglePin={onTogglePin ? () => onTogglePin(f.id, !isPinned(f)) : undefined}
        />
      ))}
    </ul>
  )
}

export function FeatureCard({
  feature,
  reposById,
  sessions,
  stats,
  active,
  onSelect,
  onArchive,
  onTogglePin,
}: {
  feature: Feature
  reposById: Map<string, Repo>
  sessions: number
  stats?: FeatureWithStats
  active: boolean
  onSelect: () => void
  onArchive?: () => void
  onTogglePin?: () => void
}) {
  const meta = STATUS_META[feature.status]
  const pinned = isPinned(feature)
  const recordCount = stats?.recordCount ?? 0
  // Atividade real: último registro de sessão quando existe, senão updated_at.
  const lastActivity = stats?.lastRecordAt ?? feature.updatedAt
  const stalled = stalledDays(feature.status, lastActivity)
  return (
    <li>
      {/* div role=button (não <button>) pra permitir o botão de archive aninhado */}
      <div
        role="button"
        tabIndex={0}
        onClick={onSelect}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            onSelect()
          }
        }}
        className={`group w-full cursor-pointer rounded-[14px] border px-4 py-3 text-left transition ${
          active
            ? `border-[var(--color-accent)] bg-[var(--color-surface-2)] ${activeMarker}`
            : 'border-[var(--color-border)] bg-[var(--color-surface)] hover:bg-[var(--color-surface-2)]/60'
        }`}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium text-[var(--color-text)]">
              {feature.title}
            </div>
            {feature.objective && (
              <div className="mt-0.5 line-clamp-2 text-xs text-[var(--color-text-dim)]">
                {feature.objective}
              </div>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <StatusBadge status={feature.status} />
            {onTogglePin && (
              /* Pinada: o botão fica sempre visível — é estado, não só ação. */
              <button
                type="button"
                data-testid="feature-card-pin"
                data-pinned={pinned}
                title={pinned ? 'Tirar do foco' : 'Fixar no foco (topo da parede)'}
                onClick={(e) => {
                  e.stopPropagation()
                  onTogglePin()
                }}
                className={`rounded p-1 transition hover:bg-[var(--color-bg)] hover:text-[var(--color-text)] ${
                  pinned
                    ? 'text-[var(--color-accent)] opacity-100'
                    : 'text-[var(--color-text-dim)] opacity-0 group-hover:opacity-100'
                }`}
              >
                <Icon as={pinned ? PinOff : Pin} size={13} />
              </button>
            )}
            {onArchive && (
              <button
                type="button"
                title="Arquivar feature"
                onClick={(e) => {
                  e.stopPropagation()
                  onArchive()
                }}
                className="rounded p-1 text-[var(--color-text-dim)] opacity-0 transition group-hover:opacity-100 hover:bg-[var(--color-bg)] hover:text-[var(--color-text)]"
              >
                <Icon as={Archive} size={13} />
              </button>
            )}
          </div>
        </div>

        <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
          {feature.repos.map((link) => (
            <span
              key={link.repoId}
              className="inline-flex items-center gap-1 rounded-full bg-[var(--color-bg)] px-2 py-0.5 text-[10px] text-[var(--color-text-dim)]"
              title={link.branch ? `branch: ${link.branch}` : undefined}
            >
              <Icon as={GitBranch} size={10} />
              {reposById.get(link.repoId)?.label ?? link.repoId}
            </span>
          ))}
          {recordCount === 0 && (
            <span
              className="inline-flex items-center rounded-full bg-[var(--color-bg)] px-2 py-0.5 text-[10px] text-[var(--color-text-dim)]"
              title="Nenhum registro de sessão sintetizado pra esta feature"
            >
              sem registros
            </span>
          )}
          {stalled !== null && (
            <span
              className="inline-flex items-center rounded-full bg-[var(--color-bg)] px-2 py-0.5 text-[10px] font-medium text-amber-500"
              title={`Sem atividade real há ${stalled} dias (status ${meta.label})`}
            >
              parada há {stalled}d
            </span>
          )}
          {feature.objectiveLinkCount === 0 && (sessions > 0 || recordCount > 0) && (
            <span
              className="inline-flex items-center rounded-full border border-[var(--color-info)] px-2 py-0.5 text-[10px] font-medium text-[var(--color-info)]"
              title="Feature com atividade real mas sem vínculo a nenhum objetivo/OKR"
            >
              sem OKR
            </span>
          )}
        </div>

        <div className="mt-2 flex items-center gap-2 text-[10px] text-[var(--color-text-dim)]">
          <span title={meta.label}>{relativeTime(lastActivity)}</span>
          {sessions > 0 && (
            <>
              <span aria-hidden>·</span>
              {/* A contagem era texto morto: agora leva ao dossiê, que é onde a
                  lista de sessões (com focar/retomar) vive. O card não ganha a
                  lista inteira de propósito — ele precisa continuar escaneável. */}
              <button
                type="button"
                data-testid="feature-card-sessions"
                onClick={(e) => {
                  e.stopPropagation()
                  onSelect()
                }}
                title={`Ver as ${sessions} sessões desta feature`}
                className="underline decoration-dotted underline-offset-2 hover:text-[var(--color-text)]"
              >
                {sessions} {sessions === 1 ? 'sessão' : 'sessões'}
              </button>
            </>
          )}
        </div>
      </div>
    </li>
  )
}

export function StatusBadge({ status }: { status: Feature['status'] }) {
  const meta = STATUS_META[status]
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium"
      style={{
        color: meta.color,
        borderColor: `color-mix(in srgb, ${meta.color} 45%, transparent)`,
        background: `color-mix(in srgb, ${meta.color} 12%, transparent)`,
      }}
    >
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: meta.color }} />
      {meta.label}
    </span>
  )
}
