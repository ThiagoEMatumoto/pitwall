import { memo } from 'react'
import { Handle, Position, useStore, type NodeProps } from '@xyflow/react'
import { Plus } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import type { LaneData, MapNode } from './graph-to-flow'
import { useMapActions } from './map-context'
import { compensatedPx } from './card-display'

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
  if (lane.level === 'project') {
    return (
      <div
        data-testid="lane-project"
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
        <span className="min-w-0 flex-1 truncate">{lane.label}</span>
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
