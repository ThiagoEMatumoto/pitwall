import { memo, useRef } from 'react'
import { Handle, Position, useStore, type NodeProps } from '@xyflow/react'
import { Pin, Plus } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import { PROJECT_HEADER, type LaneData, type MapNode } from './graph-to-flow'
import { useMapActions } from './map-context'
import { compensatedPx, isCompactZoom } from './card-display'
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
// Abaixo disto o prefixo do projeto alheio ("Diligencia ·") sai do cabeçalho da
// raia (fica no title): ele truncava justo o nome do repo.
const REPO_PREFIX_MIN_ZOOM = 0.6
// Abaixo disto a 3ª linha (fonte compensada) não cabe nos 80px do cabeçalho.
const REMINDERS_MIN_ZOOM = 0.7

function FeatureHeader({ lane, px }: { lane: LaneData; px: number }) {
  const open = useFeaturePanelStore((s) => s.open)
  const status = STATUS_META[lane.status as FeatureStatus]
  const down = useRef<{ x: number; y: number } | null>(null)
  // Na visão geral a fonte compensada não cabe nas 3 linhas do cabeçalho: os
  // lembretes saem (o painel continua a um clique).
  const showReminders = useStore((s) => s.transform[2] >= REMINDERS_MIN_ZOOM)
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
      <span
        data-testid="feature-card-pulse"
        className="block min-w-0 truncate text-[0.8em] text-[var(--color-text-dim)]"
      >
        {lane.pulse ?? 'sem pulso ainda'}
      </span>
      {/* 3ª linha: os lembretes não disputam a linha do pulso nem a borda direita (dock). */}
      {lane.featureId && showReminders && <FeatureCardReminders featureId={lane.featureId} />}
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
  const compact = useStore((s) => isCompactZoom(s.transform[2]))
  const hidePrefix = useStore((s) => s.transform[2] < REPO_PREFIX_MIN_ZOOM)
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
        {/* Mesma linha de título do card da feature, numa faixa de altura fixa
            (PROJECT_HEADER): com a fonte compensada ela invadia a 1ª raia. A
            borda tracejada é a única diferença de um card de feature. */}
        <div
          data-testid="lane-project-header"
          className="flex min-w-0 items-center gap-1.5 overflow-hidden whitespace-nowrap px-3 pt-1.5 font-semibold text-[var(--color-text)]"
          style={{ fontSize: projectPx, height: PROJECT_HEADER }}
        >
          <span className="min-w-0 truncate" title={lane.label}>
            {lane.label}
          </span>
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
        className={`flex items-center gap-1 px-3 text-[var(--color-text-dim)] ${compact ? 'pt-1' : 'pt-2'}`}
        // No resumo a fonte compensada (até 20px) com pt-2 passava dos 30px do
        // cabeçalho e o nome do repo encostava no cartão.
        style={{ fontSize: repoPx, lineHeight: 1.2 }}
      >
        {/* Título normal (a caixa alta mono gritava mais que o card). Projeto
            alheio vira um prefixo discreto; o title guarda o rótulo inteiro. */}
        <span
          className="min-w-0 flex-1 truncate font-medium"
          title={lane.projectName ? `${lane.projectName} · ${lane.label}` : lane.label}
        >
          {lane.projectName && !hidePrefix && (
            <span data-testid="lane-repo-project" className="font-normal opacity-70">
              {lane.projectName} ·{' '}
            </span>
          )}
          <span className="text-[var(--color-text)]">{lane.label}</span>
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
            data-compact={compact || undefined}
            className={`nodrag flex shrink-0 items-center justify-center rounded normal-case tracking-normal text-[var(--color-accent)] transition hover:bg-[var(--color-surface-2)] ${
              compact ? 'h-[1.4em] w-[1.4em] border border-[var(--color-border)]' : 'gap-0.5 px-1'
            }`}
          >
            {/* No resumo, só o "+": por extenso nas 3 raias ele tomava o espaço
                do nome do repo, que é o que identifica a raia. */}
            <Icon as={Plus} size={compact ? repoPx : 11} />
            {!compact && 'Nova sessão'}
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
