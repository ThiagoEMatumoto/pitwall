import { memo, useRef } from 'react'
import { Handle, Position, useStore, type NodeProps } from '@xyflow/react'
import { Pin, Plus } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import type { LaneData, MapNode } from './graph-to-flow'
import { useMapActions } from './map-context'
import { compensatedPx } from './card-display'
import { useFeaturePanelStore } from './feature-panel-store'
import { FeatureCardReminders } from './FeaturePanel'
import { STATUS_META } from '@/features/features/status'
import type { FeatureStatus } from '../../../shared/types/ipc'

// Cabeçalhos legíveis no zoom de enquadramento: a fonte compensa o zoom até um teto.
function useHeaderPx(base: number, max: number): number {
  const zoom = useStore((s) => Math.round(s.transform[2] * 20) / 20)
  return zoom >= 1 ? base : compensatedPx(zoom, base, max)
}

function AttentionBadge({ count }: { count: number }) {
  if (count === 0) return null
  return (
    <span
      data-testid="lane-attention-badge"
      title={`${count} ${count === 1 ? 'sessão precisa' : 'sessões precisam'} de você`}
      className="flex h-[1.4em] min-w-[1.4em] items-center justify-center rounded-full px-1 text-[0.85em] font-semibold"
      style={{ background: 'var(--color-warning)', color: 'var(--color-bg)' }}
    >
      {count}
    </span>
  )
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

// Card da feature: o topo do mapa. Título, pulso de 1 linha, status, contadores e
// o foco da parede (feature_pin); o clique no cabeçalho abre o painel da feature
// sobre o mapa (FeaturePanel), sem navegar.
// Até onde o ponteiro anda entre o pointerdown e o click e ainda conta como
// clique (abre o painel) e não como arrasto do card.
const HEADER_CLICK_SLOP_PX = 4

function FeatureHeader({ lane, px }: { lane: LaneData; px: number }) {
  const open = useFeaturePanelStore((s) => s.open)
  const status = STATUS_META[lane.status as FeatureStatus]
  const down = useRef<{ x: number; y: number } | null>(null)
  // SEM `nodrag`: o cabeçalho é a alça natural do card (as lanes de repo que
  // preenchem o corpo não arrastam). O clique só abre o painel se não houve
  // arrasto entre o pointerdown e o click.
  return (
    <button
      type="button"
      data-testid="feature-card-header"
      onPointerDown={(e) => {
        down.current = { x: e.clientX, y: e.clientY }
      }}
      onClick={(e) => {
        e.stopPropagation()
        const start = down.current
        down.current = null
        if (start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > HEADER_CLICK_SLOP_PX) return
        if (lane.featureId) open(lane.featureId)
      }}
      onDoubleClick={(e) => e.stopPropagation()}
      title="Abrir o painel da feature"
      className="flex w-full min-w-0 cursor-grab flex-col gap-0.5 rounded-t-xl px-3 pt-1.5 text-left transition hover:bg-[color-mix(in_srgb,var(--color-surface-2)_50%,transparent)]"
      style={{ fontSize: px }}
    >
      <span className="flex min-w-0 items-center gap-1.5 whitespace-nowrap font-semibold text-[var(--color-text)]">
        {lane.pinned && (
          <span data-testid="feature-card-pinned" title="Em foco na parede de features">
            <Icon as={Pin} size={12} className="text-[var(--color-accent)]" />
          </span>
        )}
        <span className="min-w-0 truncate">{lane.label}</span>
        {status && (
          <span
            data-testid="feature-card-status"
            className="shrink-0 rounded-full border px-1.5 text-[0.75em] font-medium"
            style={{ borderColor: status.color, color: status.color }}
          >
            {status.label}
          </span>
        )}
        <span data-testid="feature-card-counts" className="shrink-0 text-[0.8em] font-normal text-[var(--color-text-dim)]">
          {plural(lane.sessionCount ?? 0, 'sessão', 'sessões')} · {plural(lane.repoCount ?? 0, 'repo', 'repos')}
        </span>
        <AttentionBadge count={lane.attentionCount ?? 0} />
      </span>
      <span className="flex min-w-0 items-center gap-2">
        <span
          data-testid="feature-card-pulse"
          className="block min-w-0 flex-1 truncate text-[0.8em] text-[var(--color-text-dim)]"
        >
          {lane.pulse ?? 'sem pulso ainda'}
        </span>
        {lane.featureId && <FeatureCardReminders featureId={lane.featureId} />}
      </span>
    </button>
  )
}

// Lane automática: projeto (contêiner externo, arrastável) → repo (coluna
// interna, fixa). A lane de repo é alvo de conexão: soltar ali o fio de uma
// sessão de outro repo abre a delegação. Os handles invisíveis também ancoram
// as arestas repoDep.
function LaneGroupNodeImpl({ data }: NodeProps<MapNode>) {
  const actions = useMapActions()
  const lane = data as LaneData
  const color = lane.color ?? 'var(--color-accent)'
  const projectPx = useHeaderPx(13, 26)
  const repoPx = useHeaderPx(11, 20)
  if (lane.level === 'feature') {
    return (
      <div
        data-testid="lane-feature"
        data-lane-kind="feature"
        data-feature-id={lane.featureId}
        className="h-full w-full rounded-xl border"
        style={{
          borderColor: `color-mix(in srgb, ${color} 55%, var(--color-border))`,
          background: 'color-mix(in srgb, var(--color-surface) 45%, transparent)',
        }}
      >
        <FeatureHeader lane={lane} px={projectPx} />
      </div>
    )
  }
  if (lane.level === 'project') {
    return (
      <div
        data-testid="lane-project"
        data-lane-kind="project"
        className="h-full w-full rounded-xl border border-dashed"
        style={{
          borderColor: `color-mix(in srgb, ${color} 40%, var(--color-border))`,
          background: 'color-mix(in srgb, var(--color-surface) 35%, transparent)',
        }}
      >
        <div
          className="flex items-center gap-1.5 whitespace-nowrap px-3 pt-1.5 font-semibold text-[var(--color-text)]"
          style={{ fontSize: projectPx }}
        >
          <span className="h-2 w-2 rounded-full" style={{ background: color }} />
          {lane.label}
          <AttentionBadge count={lane.attentionCount ?? 0} />
        </div>
      </div>
    )
  }
  return (
    <div
      data-testid="lane-repo"
      data-repo-id={lane.repoId ?? ''}
      className="h-full w-full rounded-lg border"
      style={{
        borderColor: 'color-mix(in srgb, var(--color-border) 70%, transparent)',
        background: 'color-mix(in srgb, var(--color-bg) 55%, transparent)',
      }}
    >
      <Handle
        type="target"
        position={Position.Left}
        className="!h-3 !w-3 !border-0 !bg-transparent"
      />
      <div
        className="flex items-center gap-1 px-3 pt-2 font-mono uppercase tracking-wide text-[var(--color-text-dim)]"
        style={{ fontSize: repoPx, lineHeight: 1.1 }}
      >
        {/* Projeto alheio no mesmo formato do repo (mono, caixa alta), só mais
            apagado; o title guarda o rótulo inteiro quando a lane trunca. */}
        <span
          className="min-w-0 flex-1 truncate"
          title={lane.projectName ? `${lane.projectName} / ${lane.label}` : lane.label}
        >
          {lane.projectName && (
            <span data-testid="lane-repo-project" className="opacity-70">
              {lane.projectName} /{' '}
            </span>
          )}
          {lane.label}
        </span>
        {lane.repoId && (
          <button
            type="button"
            data-testid="lane-new-session"
            onClick={(e) => {
              e.stopPropagation()
              actions.newSession(lane.repoId)
            }}
            onDoubleClick={(e) => e.stopPropagation()}
            title={`Nova sessão em ${lane.label} (ou duplo clique na área vazia da lane)`}
            aria-label={`Nova sessão em ${lane.label}`}
            className="nodrag flex shrink-0 items-center gap-0.5 rounded px-1 normal-case tracking-normal text-[var(--color-accent)] transition hover:bg-[var(--color-surface-2)]"
          >
            <Icon as={Plus} size={11} />
            Nova sessão
          </button>
        )}
      </div>
      <Handle
        type="source"
        position={Position.Right}
        className="!h-1 !w-1 !border-0 !bg-transparent"
      />
    </div>
  )
}

export const LaneGroupNode = memo(LaneGroupNodeImpl)
