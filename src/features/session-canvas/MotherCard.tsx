import type { CSSProperties, ReactNode } from 'react'
import { Handle, Position, useStore, type NodeProps } from '@xyflow/react'
import {
  Crown,
  Eye,
  PanelLeft,
  GitBranchPlus,
  Pin,
  PinOff,
  Repeat,
  SquareTerminal,
  type LucideIcon,
} from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import { formatCombo, resolveCombo } from '@/lib/keybindings'
import { useKeybindingsStore } from '@/lib/keybindings-store'
import { useAppStore } from '@/store/appStore'
import { isActionableDetail } from '@/features/session-switcher/AttentionPopover'
import { ProviderBadge } from '@/features/sessions/ProviderBadge'
import type { SessionGraphNode } from '../../../shared/types/session-graph'
import { MOTHER_MAX_H, type MapNode, type SessionCardData } from './graph-to-flow'
import { TONE_COLOR, indicatorText, type CardIndicator } from './card-indicator'
import { quantizeZoom, cardTitle } from './card-display'
import { useMapActions } from './map-context'
import { useMapLive } from './map-live'
import {
  BorderHandles,
  StatusPill,
  frameStyle,
  useIndicator,
  useReportCardHeight,
} from './card-parts'
import { CardAttention, CardPromptBar, LiveTail } from './SessionCardLive'
import { BatonPassedChip, MotherBadge } from './MotherBadge'
import {
  MOTHER_STRIP,
  MOTHER_TAIL_LINES,
  MOTHER_TAIL_PX,
  MOTHER_TAIL_WINDOW,
  motherDetail,
} from './mother-badge'
import { PurposeLine } from './PurposeLine'
import { useMotherDockStore } from './mother-dock'
import { canPassBaton } from './useMapCommands'

// A mãe é a peça principal do card da feature: maior (MOTHER_W), sempre aberta,
// com 16 linhas de saída ao vivo, barra de prompt grande e as ações à vista.
// Abaixo de um zoom bem baixo vira o mini — o mesmo conteúdo essencial
// contra-escalado para a tela, dentro da mesma vaga do layout.

function useZoom(): number {
  return useStore((s) => quantizeZoom(s.transform[2]))
}

// Moldura da mãe: a faixa de 3px no topo (identidade) e um halo largo na cor
// de destaque — ela se separa das filhas sem parecer selecionada.
function motherBigFrame(base: CSSProperties): CSSProperties {
  const halo = '0 18px 48px -20px color-mix(in srgb, var(--color-accent) 55%, transparent)'
  return {
    ...base,
    borderWidth: Math.max(Number(base.borderWidth ?? 1), 1.5),
    boxShadow: [MOTHER_STRIP, base.boxShadow, halo].filter(Boolean).join(', '),
  }
}

function PinButton({ node }: { node: SessionGraphNode }) {
  const pinnedId = useMotherDockStore((s) => s.pinnedId)
  const overrides = useKeybindingsStore((s) => s.overrides)
  const pinned = pinnedId === node.sessionId
  const combo = formatCombo(resolveCombo('mother.focus', overrides))
  return (
    <button
      type="button"
      data-testid="mother-pin"
      aria-pressed={pinned}
      onClick={(e) => {
        e.stopPropagation()
        const dock = useMotherDockStore.getState()
        if (pinned) dock.unpin()
        else dock.pin(node.sessionId)
      }}
      title={
        pinned
          ? `Desafixar: o terminal volta para o cartão (${combo} foca a mãe)`
          : `Fixar a mãe numa coluna à esquerda do mapa, com o terminal interativo (${combo})`
      }
      className={`nodrag flex shrink-0 items-center gap-1 rounded-md border px-2 py-1 text-[12px] font-medium transition ${
        pinned
          ? 'border-[var(--color-accent)] bg-[color-mix(in_srgb,var(--color-accent)_16%,transparent)] text-[var(--color-accent)]'
          : 'border-[var(--color-border)] text-[var(--color-text-dim)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]'
      }`}
    >
      <Icon as={pinned ? PinOff : Pin} size={13} />
      {pinned ? 'Fixada' : 'Fixar'}
    </button>
  )
}

function QuickAction({
  testId,
  icon,
  label,
  title,
  onClick,
  disabled = false,
  accent = false,
}: {
  testId: string
  icon: LucideIcon
  label: ReactNode
  title: string
  onClick: () => void
  disabled?: boolean
  accent?: boolean
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
      title={title}
      className={`nodrag flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-[12px] transition disabled:pointer-events-none disabled:opacity-40 ${
        accent
          ? 'border-[color-mix(in_srgb,var(--color-accent)_55%,transparent)] text-[var(--color-accent)] hover:bg-[color-mix(in_srgb,var(--color-accent)_14%,transparent)]'
          : 'border-[var(--color-border)] text-[var(--color-text-dim)] hover:border-[var(--color-accent)] hover:text-[var(--color-text)]'
      }`}
    >
      <Icon as={icon} size={13} />
      {label}
    </button>
  )
}

function QuickActions({ data }: { data: SessionCardData }) {
  const { node } = data
  const actions = useMapActions()
  const alive = node.status !== 'ended'
  const n = data.childCount
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-1.5" data-testid="mother-actions">
      <QuickAction
        // Mesmo contrato do botão Terminal do cartão comum (SessionCardNode).
        testId="card-interact"
        icon={SquareTerminal}
        label="Terminal"
        accent
        disabled={!alive}
        title="O terminal real da mãe numa janela grande sobre o mapa (Enter ou duplo clique)"
        onClick={() => actions.interact(node.sessionId)}
      />
      <QuickAction
        testId="mother-baton"
        icon={Repeat}
        label="Passar o bastão"
        disabled={!canPassBaton(node)}
        title="A sucessora assume a liderança das filhas, com endereço novo"
        onClick={() => actions.passBaton(node)}
      />
      <QuickAction
        testId="mother-new-child"
        icon={GitBranchPlus}
        label="Nova filha"
        disabled={!alive}
        title="Delega uma tarefa a uma sessão-filha desta"
        onClick={() => actions.newChild(node)}
      />
      <QuickAction
        testId="mother-peek-children"
        icon={Eye}
        label={`Espiar filhas${n ? ` · ${n}` : ''}`}
        disabled={n === 0}
        title="Abre a 1ª filha na janela do mapa; Alt+, / Alt+. trocam entre elas"
        onClick={() => actions.peekChildren(node.sessionId)}
      />
    </div>
  )
}

function Header({ data }: { data: SessionCardData }) {
  const { node } = data
  return (
    <div data-testid="card-header" className="flex min-w-0 items-center gap-2">
      <MotherBadge node={node} />
      <span
        data-testid="card-title"
        className="min-w-0 shrink truncate text-[17px] font-semibold leading-tight text-[var(--color-text)]"
        title={node.title}
      >
        {cardTitle(node)}
      </span>
      {node.featureTitle && (
        <span
          data-testid="mother-feature"
          className="min-w-0 shrink truncate rounded-full border border-[var(--color-border)] px-2 py-0.5 text-[11px] text-[var(--color-text-dim)]"
          title={`Feature: ${node.featureTitle}`}
        >
          {node.featureTitle}
        </span>
      )}
      <span className="flex-1" />
      <PinButton node={node} />
    </div>
  )
}

function StateRow({ data, ind }: { data: SessionCardData; ind: CardIndicator }) {
  const { node } = data
  return (
    <div className="flex min-w-0 items-center gap-2 text-[12px]">
      <StatusPill ind={ind} />
      {ind.reason ? (
        <span
          data-testid="card-attention-reason"
          className="min-w-0 truncate font-medium text-[var(--color-danger)]"
        >
          {ind.reason}
        </span>
      ) : (
        ind.step && (
          <span
            data-testid="card-step"
            className="min-w-0 truncate text-[var(--color-text-dim)]"
            title={ind.step}
          >
            {ind.step}
          </span>
        )
      )}
      <BatonPassedChip node={node} />
      <ProviderBadge provider={node.provider} className="ml-auto" />
    </div>
  )
}

// Fixada: o terminal e o composer estão na coluna à esquerda. Repetir a saída e
// a barra aqui triplicava a entrada da mesma sessão; o cartão só aponta para lá.
function PinnedHere() {
  const overrides = useKeybindingsStore((s) => s.overrides)
  const combo = formatCombo(resolveCombo('mother.focus', overrides))
  return (
    <button
      type="button"
      data-testid="mother-pinned-here"
      onClick={(e) => {
        e.stopPropagation()
        useMotherDockStore.getState().requestFocus()
      }}
      title={`Focar o terminal da mãe na coluna (${combo})`}
      className="nodrag flex items-center gap-2 rounded-lg border border-dashed border-[color-mix(in_srgb,var(--color-accent)_45%,transparent)] bg-[color-mix(in_srgb,var(--color-accent)_7%,transparent)] px-3 py-2.5 text-left text-[13px] text-[var(--color-text-dim)] transition hover:border-[var(--color-accent)] hover:text-[var(--color-text)]"
    >
      <Icon as={PanelLeft} size={15} className="shrink-0 text-[var(--color-accent)]" />
      <span className="min-w-0 flex-1">Terminal e composer na coluna à esquerda</span>
      <kbd className="shrink-0 rounded border border-[var(--color-border)] px-1.5 py-0.5 text-[11px]">
        {combo}
      </kbd>
    </button>
  )
}

function FullBody({ data, ind }: { data: SessionCardData; ind: CardIndicator }) {
  const { node } = data
  const item = useMapLive().attention.get(node.sessionId)
  const menuInline = !!item && isActionableDetail(item.detail)
  const pinned = useMotherDockStore((s) => s.pinnedId === node.sessionId)
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 px-3.5 py-3">
      <Header data={data} />
      <StateRow data={data} ind={ind} />
      <PurposeLine sessionId={node.sessionId} purpose={node.purpose} source={node.purposeSource} />
      <CardAttention node={node} />
      {pinned ? (
        <PinnedHere />
      ) : (
        <>
          {!menuInline && (
            <LiveTail
              node={node}
              window={MOTHER_TAIL_WINDOW}
              lines={MOTHER_TAIL_LINES}
              fontPx={MOTHER_TAIL_PX}
            />
          )}
          <CardPromptBar node={node} size="large" />
        </>
      )}
      <QuickActions data={data} />
    </div>
  )
}

// Zoom bem baixo: o essencial (nome, selo, status, a última linha e o composer)
// numa camada contra-escalada — tamanho de tela constante, na vaga da mãe.
const MINI_MIN_ZOOM = 0.2
function MiniBody({
  data,
  ind,
  zoom,
}: {
  data: SessionCardData
  ind: CardIndicator
  zoom: number
}) {
  const { node } = data
  const { now } = useMapLive()
  const lastText = useAppStore((s) => s.liveSessions.find((x) => x.id === node.sessionId)?.lastText)
  const last = lastText
    ?.split('\n')
    .map((l) => l.trim())
    .find(Boolean)
  const z = Math.max(zoom, MINI_MIN_ZOOM)
  const n = node.childCount ?? 0
  return (
    <div
      data-testid="mother-mini"
      className="flex flex-col gap-1.5 px-3 py-2.5"
      style={{
        width: `${100 * z}%`,
        height: `${100 * z}%`,
        transform: `scale(${1 / z})`,
        transformOrigin: 'top left',
      }}
    >
      <div className="flex min-w-0 items-center gap-2">
        <span
          data-testid="card-status"
          data-tone={ind.tone}
          className={`h-2.5 w-2.5 shrink-0 rounded-full ${ind.tone === 'needs-you' ? 'pw-pulse' : ''}`}
          style={{ background: TONE_COLOR[ind.tone] }}
        />
        <span
          data-testid="card-title"
          className="min-w-0 flex-1 truncate text-[14px] font-semibold text-[var(--color-text)]"
        >
          {cardTitle(node)}
        </span>
        <span
          data-testid="card-mother-badge"
          className="inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 text-[12px] font-semibold uppercase tracking-wide"
          style={{ color: 'var(--color-bg)', background: 'var(--color-accent)' }}
        >
          <Icon as={Crown} size={12} />
          MÃE · {n}
        </span>
      </div>
      <div className="flex min-w-0 items-center gap-1.5 text-[12px]">
        <span className="shrink-0 font-medium" style={{ color: TONE_COLOR[ind.tone] }}>
          {indicatorText(ind, now)}
        </span>
        {(ind.reason ?? ind.step) && (
          <span className="min-w-0 truncate text-[var(--color-text-dim)]">
            · {ind.reason ?? ind.step}
          </span>
        )}
      </div>
      {last && (
        <p
          data-testid="mother-last-line"
          className="truncate font-mono text-[12px] text-[var(--color-text-dim)]"
          title={last}
        >
          {last}
        </p>
      )}
      <CardPromptBar node={node} />
    </div>
  )
}

export function MotherCard({ data, selected }: NodeProps<MapNode>) {
  const card = data as SessionCardData
  const { node } = card
  const actions = useMapActions()
  const zoom = useZoom()
  const ind = useIndicator(node)
  const detail = motherDetail(zoom)
  const pinned = useMotherDockStore((s) => s.pinnedId === node.sessionId)
  // A mãe nunca esmaece pelo foco em outra sessão: ela é a referência do card.
  const frame = motherBigFrame(frameStyle(ind.tone, !!selected))
  const measureRef = useReportCardHeight(node.sessionId, detail === 'full')
  return (
    <div
      data-testid="session-card"
      data-session-id={node.sessionId}
      data-detail={detail}
      data-mother="true"
      data-variant="mother"
      data-pinned={pinned ? 'true' : undefined}
      data-view="open"
      data-tone={ind.tone}
      onContextMenu={(e) => actions.openContextMenu(e, `s:${node.sessionId}`)}
      ref={measureRef}
      className={`group relative w-full overflow-hidden rounded-xl border bg-[var(--color-surface)] transition ${
        detail === 'full' ? 'flex flex-col' : 'h-full'
      } ${ind.tone === 'needs-you' ? 'session-card-alert' : ''}`}
      style={detail === 'full' ? { ...frame, maxHeight: MOTHER_MAX_H } : frame}
    >
      <BorderHandles />
      <div className={detail === 'full' ? 'flex min-h-0 flex-1 flex-col' : 'h-full'}>
        {detail === 'full' ? (
          <FullBody data={card} ind={ind} />
        ) : (
          <MiniBody data={card} ind={ind} zoom={zoom} />
        )}
      </div>
      <Handle
        type="source"
        position={Position.Right}
        title="Arraste até a lane de outro repo para delegar"
        className="!h-3 !w-3 !border !border-[var(--color-accent)] !bg-[var(--color-surface)] opacity-0 transition group-hover:opacity-100"
      />
    </div>
  )
}
