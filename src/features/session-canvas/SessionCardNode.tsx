import { memo, useMemo, type CSSProperties } from 'react'
import { Handle, NodeResizeControl, Position, useStore, type NodeProps } from '@xyflow/react'
import {
  ChevronDown,
  ChevronRight,
  ChevronUp,
  History,
  LoaderCircle,
  PanelTop,
  Pencil,
  Sparkles,
  SquareTerminal,
  StickyNote,
} from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import { relativeTime } from '@/lib/time'
import { useAppStore } from '@/store/appStore'
import type { CardViewState } from '../../../shared/types/canvas'
import type { SessionGraphNode } from '../../../shared/types/session-graph'
import { type MapNode, type SessionCardData } from './graph-to-flow'
import {
  TONE_COLOR,
  indicatorFor,
  indicatorText,
  type CardIndicator,
  type IndicatorTone,
} from './card-indicator'
import { useCardViewStore } from './card-view-store'
import { tailText } from './card-tail'
import { useMapLive } from './map-live'
import { CardAttention, CardPromptBar, CardTerminal, LiveTail } from './SessionCardLive'
import { isActionableDetail } from '@/features/session-switcher/AttentionPopover'
import { useMapActions } from './map-context'
import { useMapFocus } from './map-focus'
import { cardDetail, cardFooter, cardTitle, compensatedPx, type CardDetail } from './card-display'
import { PurposeLine } from './PurposeLine'
import { ProviderBadge } from '@/features/sessions/ProviderBadge'

// Tons que nunca esmaecem no modo foco.
const ACTIVE_TONES: ReadonlySet<IndicatorTone> = new Set(['working', 'needs-you', 'starting'])

// Menor terminal no cartão: abaixo disso a TUI quebra o layout da caixa de input.
const TERMINAL_MIN_W = 520
const TERMINAL_MIN_H = 340

// O indicador do cartão: status do grafo + motivo da tela + relógio de working +
// a marca de interrupção no fim da tela (só quando o cartão está aberto).
function useIndicator(n: SessionGraphNode): CardIndicator {
  const live = useAppStore((s) => s.liveSessions.find((x) => x.id === n.sessionId))
  const tail = useCardViewStore((s) => s.tails[n.sessionId])
  const { workingSince } = useMapLive()
  const tailLines = useMemo(() => (tail ? tailText(tail.lines) : null), [tail])
  return indicatorFor(n, live, workingSince.get(n.sessionId) ?? null, tailLines)
}

function StatusPill({ ind }: { ind: CardIndicator }) {
  const { now } = useMapLive()
  const color = TONE_COLOR[ind.tone]
  const busy = ind.tone === 'working' || ind.tone === 'starting'
  return (
    <span
      data-testid="card-status"
      data-tone={ind.tone}
      className="inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-px text-[11px] font-medium leading-4"
      style={{
        color,
        borderColor: `color-mix(in srgb, ${color} 45%, transparent)`,
        background: `color-mix(in srgb, ${color} ${ind.tone === 'ended' ? 6 : 14}%, transparent)`,
      }}
    >
      {busy ? (
        <Icon as={LoaderCircle} size={11} className="session-card-spin" />
      ) : (
        <span
          className={`h-1.5 w-1.5 rounded-full ${ind.tone === 'needs-you' ? 'pw-pulse' : ''}`}
          style={{ background: color }}
        />
      )}
      {indicatorText(ind, now)}
    </span>
  )
}

function FanChip({ data }: { data: SessionCardData }) {
  const actions = useMapActions()
  const n = data.childCount
  if (n === 0) return null
  const label = `${n} ${n === 1 ? 'filha' : 'filhas'}`
  if (!data.fanCollapsible) {
    return (
      <span
        data-testid="card-children"
        className="shrink-0 text-[11px] text-[var(--color-text-dim)]"
        title={`${label} delegada${n === 1 ? '' : 's'}`}
      >
        {label}
      </span>
    )
  }
  return (
    <button
      type="button"
      data-testid="card-children"
      onClick={(e) => {
        e.stopPropagation()
        actions.toggleFan(data.node.sessionId)
      }}
      title={data.fanExpanded ? 'Recolher os fios das filhas' : 'Mostrar os fios até cada filha'}
      className="nodrag flex shrink-0 items-center gap-0.5 rounded-full border border-[var(--color-border)] px-1.5 text-[11px] text-[var(--color-text-dim)] transition hover:text-[var(--color-text)]"
    >
      {label}
      <Icon as={data.fanExpanded ? ChevronUp : ChevronDown} size={11} />
    </button>
  )
}

const FOOTER_ICON = { note: StickyNote, summary: Sparkles, last: History } as const

function Footer({ data }: { data: SessionCardData }) {
  const actions = useMapActions()
  const { node } = data
  const busy = actions.summarizingIds.has(node.sessionId)
  const canSummarize = node.provider === 'claude' && !!node.ccSessionId
  const footer = cardFooter(node, data.noteExcerpt)
  // Sem texto, a linha só guardava o "Resumir" invisível (hover): uma faixa morta
  // em todo cartão. Resumir segue no "⋯ Mais" e no clique direito.
  if (!footer) return null
  const title =
    footer.kind === 'summary'
      ? `Onde parei (resumo ${relativeTime(node.lastSummaryAt)}${data.summaryStale ? ', desatualizado' : ''}): ${footer.text}`
      : footer.kind === 'note'
        ? `Nota: ${footer.text}`
        : footer.kind === 'last'
          ? `Sua última mensagem: ${footer.text}`
          : undefined
  return (
    <div className="flex min-h-[18px] min-w-0 shrink-0 items-center gap-1.5 text-[11px] text-[var(--color-text-dim)]">
      <span
        className="flex min-w-0 flex-1 items-center gap-1"
        title={title}
        data-testid="card-footer"
        data-kind={footer.kind}
      >
        <Icon
          as={FOOTER_ICON[footer.kind]}
          size={11}
          className={footer.kind === 'note' ? 'shrink-0 text-[var(--color-warning)]' : 'shrink-0'}
        />
        <span className="min-w-0 truncate">
          {footer.kind === 'last' && 'última: '}
          {footer.text}
          {footer.kind === 'summary' && data.summaryStale && (
            <span className="opacity-70"> · desatualizado</span>
          )}
        </span>
      </span>
      {canSummarize && (
        <button
          type="button"
          disabled={busy}
          data-testid="card-summarize"
          onClick={(e) => {
            e.stopPropagation()
            actions.summarize(node.sessionId)
          }}
          title="Resumir onde a sessão parou (claude -p, sob demanda)"
          className={`nodrag flex shrink-0 items-center gap-0.5 rounded px-1 py-0.5 text-[var(--color-accent)] transition hover:bg-[var(--color-surface-2)] disabled:opacity-50 ${
            busy ? '' : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100'
          }`}
        >
          <Icon as={Sparkles} size={11} />
          {busy ? 'Resumindo…' : 'Resumir'}
        </button>
      )}
    </div>
  )
}

// Linha logo abaixo do título: por que ela precisa de você, o que está fazendo,
// ou de quem herdou o bastão.
function StateLine({ data, ind }: { data: SessionCardData; ind: CardIndicator }) {
  const { node } = data
  return (
    <div className="flex min-w-0 items-center gap-1.5 text-[11px]">
      <StatusPill ind={ind} />
      {ind.reason && (
        <span
          data-testid="card-attention-reason"
          className="min-w-0 truncate font-medium text-[var(--color-danger)]"
        >
          {ind.reason}
        </span>
      )}
      {!ind.reason && ind.step && (
        <span
          data-testid="card-step"
          className="min-w-0 truncate text-[var(--color-text-dim)]"
          title={ind.step}
        >
          {ind.step}
        </span>
      )}
      {data.continuesFrom && (
        <span
          data-testid="card-continues-from"
          className="min-w-0 truncate text-[var(--color-violet)]"
          title={`Herdou o bastão de ${data.continuesFrom}, que já encerrou`}
        >
          ⟲ continua de {data.continuesFrom}
        </span>
      )}
      <ProviderBadge provider={node.provider} className="ml-auto" />
    </div>
  )
}

// Filha de handoff: de quem ela é. Mãe no mapa → atalho (pan até ela).
function MotherChip({ data }: { data: SessionCardData }) {
  const actions = useMapActions()
  const mother = data.motherOf
  if (!mother) return null
  const label = `↳ de ${mother.title}`
  if (!mother.onMap) {
    return (
      <span
        data-testid="card-mother"
        className="min-w-0 shrink truncate text-[11px] text-[var(--color-text-dim)]"
        title={`Filha de ${mother.title}, que já encerrou`}
      >
        {label}
      </span>
    )
  }
  return (
    <button
      type="button"
      data-testid="card-mother"
      onClick={(e) => {
        e.stopPropagation()
        actions.centerOn(mother.sessionId)
      }}
      title={`Filha de ${mother.title} — ir até a mãe`}
      className="nodrag min-w-0 shrink truncate rounded-full border border-[var(--color-border)] px-1.5 text-[11px] text-[var(--color-text-dim)] transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
    >
      {label}
    </button>
  )
}

function ViewToggle({ data, view }: { data: SessionCardData; view: CardViewState }) {
  const actions = useMapActions()
  const collapsed = view === 'collapsed'
  return (
    <button
      type="button"
      data-testid="card-toggle"
      aria-expanded={!collapsed}
      aria-label={collapsed ? 'Abrir cartão' : 'Recolher cartão'}
      title={collapsed ? 'Abrir cartão: saída ao vivo + prompt' : 'Recolher cartão'}
      onClick={(e) => {
        e.stopPropagation()
        actions.toggleView(data.node.sessionId)
      }}
      className="nodrag -ml-1 shrink-0 rounded p-0.5 text-[var(--color-text-dim)] transition hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text)]"
    >
      <Icon as={collapsed ? ChevronRight : ChevronDown} size={14} />
    </button>
  )
}

// Botão da direita: entra no terminal real ou volta ao cartão (nunca "Recolher",
// que é o chevron da esquerda).
function TerminalToggle({ data, view }: { data: SessionCardData; view: CardViewState }) {
  const { node } = data
  const actions = useMapActions()
  if (view === 'terminal') {
    return (
      <button
        type="button"
        data-testid="card-leave-terminal"
        onClick={(e) => {
          e.stopPropagation()
          actions.leaveTerminal(node.sessionId)
        }}
        title="Voltar ao cartão (Esc fora do terminal, ou afaste o zoom)"
        className="nodrag flex shrink-0 items-center gap-1 rounded border border-[var(--color-border)] px-1.5 py-0.5 text-[11px] text-[var(--color-text-dim)] transition hover:text-[var(--color-text)]"
      >
        <Icon as={PanelTop} size={11} /> Voltar ao cartão
      </button>
    )
  }
  if (node.status === 'ended') return null
  return (
    <button
      type="button"
      data-testid="card-interact"
      onClick={(e) => {
        e.stopPropagation()
        actions.interact(node.sessionId)
      }}
      title="Terminal: o terminal real da sessão aqui no cartão (Enter com o cartão selecionado)"
      className="nodrag flex shrink-0 items-center gap-1 rounded border border-[var(--color-border)] px-1.5 py-0.5 text-[11px] text-[var(--color-text-dim)] transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
    >
      <Icon as={SquareTerminal} size={11} /> Terminal
    </button>
  )
}

function Header({ data, view }: { data: SessionCardData; view: CardViewState }) {
  const { node } = data
  const actions = useMapActions()
  // Sem propósito, o convite a escrever é um ✎ no hover — a linha "Sem propósito"
  // em todo cartão era ruído.
  const canWritePurpose =
    view === 'open' && !node.purpose && actions.editingPurposeId !== node.sessionId
  return (
    <div
      data-testid="card-header"
      className="flex min-w-0 items-center gap-1"
      // Duplo clique no cabeçalho alterna recolhido ⇄ aberto (no resto do cartão
      // continua abrindo a aba).
      onDoubleClick={(e) => {
        e.stopPropagation()
        actions.toggleView(node.sessionId)
      }}
    >
      <ViewToggle data={data} view={view} />
      <span
        data-testid="card-title"
        className="min-w-0 shrink truncate text-[14px] font-medium text-[var(--color-text)]"
        title={node.title}
      >
        {cardTitle(node)}
      </span>
      <MotherChip data={data} />
      {canWritePurpose && (
        <button
          type="button"
          data-testid="card-write-purpose"
          onClick={(e) => {
            e.stopPropagation()
            actions.startEditPurpose(node.sessionId)
          }}
          title="Escrever o propósito desta sessão"
          aria-label="Escrever o propósito"
          className="nodrag shrink-0 rounded p-0.5 text-[var(--color-text-dim)] opacity-0 transition hover:text-[var(--color-text)] focus-visible:opacity-100 group-hover:opacity-100"
        >
          <Icon as={Pencil} size={11} />
        </button>
      )}
      <span className="flex-1" />
      <FanChip data={data} />
      <TerminalToggle data={data} view={view} />
    </div>
  )
}

// Recolhido = UMA linha: chevron, ponto de estado, alias e o motivo/passo.
function CollapsedBody({ data, ind }: { data: SessionCardData; ind: CardIndicator }) {
  const { node } = data
  const { now } = useMapLive()
  const detail = ind.reason ?? ind.step ?? indicatorText(ind, now)
  return (
    <div data-testid="card-header" className="flex h-full min-w-0 items-center gap-1.5 px-2.5">
      <ViewToggle data={data} view="collapsed" />
      <span
        data-testid="card-status"
        data-tone={ind.tone}
        title={indicatorText(ind, now)}
        className={`h-2 w-2 shrink-0 rounded-full ${ind.tone === 'needs-you' ? 'pw-pulse' : ''}`}
        style={{ background: TONE_COLOR[ind.tone] }}
      />
      <span
        data-testid="card-title"
        className="min-w-0 shrink truncate text-[13px] font-medium text-[var(--color-text)]"
        title={node.title}
      >
        {cardTitle(node)}
      </span>
      <span
        className="min-w-0 flex-1 truncate text-[11px]"
        style={{
          color: ind.tone === 'needs-you' ? TONE_COLOR['needs-you'] : 'var(--color-text-dim)',
        }}
        title={detail}
      >
        {detail}
      </span>
    </div>
  )
}

function CardBody({ data, ind }: { data: SessionCardData; ind: CardIndicator }) {
  const { node, view } = data
  const actions = useMapActions()
  // Menu inline na tela: o tail repetiria o comando que o painel já mostra.
  const item = useMapLive().attention.get(node.sessionId)
  const menuInline = !!item && isActionableDetail(item.detail)
  return (
    <>
      <Header data={data} view={view} />
      <StateLine data={data} ind={ind} />
      {view !== 'terminal' && (
        <PurposeLine
          sessionId={node.sessionId}
          purpose={node.purpose}
          source={node.purposeSource}
        />
      )}
      {view === 'open' && (
        <>
          <Footer data={data} />
          <CardAttention node={node} />
          {!menuInline && <LiveTail node={node} />}
          <CardPromptBar node={node} />
        </>
      )}
      {view === 'terminal' && (
        <CardTerminal node={node} onLeave={() => actions.leaveTerminal(node.sessionId)} />
      )}
    </>
  )
}

// Zoom afastado: uma faixa de 2 linhas (ponto + título; estado + o que ela diz
// agora), não a caixa alta vazia do cartão aberto.
function BriefBody({
  data,
  zoom,
  ind,
}: {
  data: SessionCardData
  zoom: number
  ind: CardIndicator
}) {
  const { node } = data
  const { now } = useMapLive()
  const lastText = useAppStore((s) => s.liveSessions.find((x) => x.id === node.sessionId)?.lastText)
  const say = ind.reason ?? ind.step ?? firstLineOf(lastText)
  const small = compensatedPx(zoom, 11, 18)
  return (
    <div className="flex min-w-0 flex-col gap-0.5 px-2.5 py-1.5">
      <div className="flex min-w-0 items-center gap-2">
        {/* Ponto compensado pelo zoom: com 6px fixos ele sumia (≈3,6px na tela a 0.6). */}
        <span
          data-testid="card-status"
          data-tone={ind.tone}
          className={`shrink-0 rounded-full ${ind.tone === 'needs-you' ? 'pw-pulse' : ''}`}
          style={{
            width: compensatedPx(zoom, 9, 16),
            height: compensatedPx(zoom, 9, 16),
            background: TONE_COLOR[ind.tone],
          }}
        />
        <span
          data-testid="card-title"
          className="min-w-0 flex-1 truncate font-medium leading-tight text-[var(--color-text)]"
          style={{ fontSize: compensatedPx(zoom) }}
        >
          {cardTitle(node)}
        </span>
      </div>
      {data.view !== 'collapsed' && (
        <div
          className="flex min-w-0 items-center gap-1.5 leading-tight"
          style={{ fontSize: small }}
        >
          <span className="shrink-0 font-medium" style={{ color: TONE_COLOR[ind.tone] }}>
            {indicatorText(ind, now)}
          </span>
          {say && <span className="min-w-0 truncate text-[var(--color-text-dim)]">· {say}</span>}
        </div>
      )}
    </div>
  )
}

function firstLineOf(text: string | null | undefined): string | null {
  return (
    text
      ?.split('\n')
      .map((l) => l.trim())
      .find(Boolean) ?? null
  )
}

// Zoom do viewport quantizado em 0.05: re-renderiza o cartão só quando a faixa
// ou a fonte compensada mudam de fato, não a cada frame do scroll.
function useZoom(): number {
  return useStore((s) => Math.round(s.transform[2] * 20) / 20)
}

// Um ponto no meio de cada borda: o fio entra/sai pelo da borda voltada pro
// outro nó (SessionEdge encaixa a ponta nele). Só o da direita é de arrastar
// (delegar); os outros são âncoras visuais e aparecem com o cartão em hover.
const SIDES = [Position.Top, Position.Right, Position.Bottom, Position.Left] as const

function BorderHandles() {
  return (
    <>
      {SIDES.map((side) => (
        <Handle
          key={side}
          id={`in-${side}`}
          type="target"
          position={side}
          isConnectable={false}
          className="!h-1.5 !w-1.5 !border-0 !bg-[var(--color-border)] opacity-0 transition group-hover:opacity-100"
        />
      ))}
    </>
  )
}

// Borda e brilho por estado: quem precisa de você pulsa em vermelho (o mesmo
// token do HUD de atenção), quem trabalha fica azul, quem terminou, verde.
function frameStyle(tone: IndicatorTone, selected: boolean): CSSProperties {
  const color = TONE_COLOR[tone]
  const strong = tone === 'needs-you'
  const quiet = tone === 'ended' || tone === 'starting'
  return {
    borderColor: quiet
      ? 'var(--color-border)'
      : `color-mix(in srgb, ${color} ${strong ? 80 : 45}%, transparent)`,
    borderWidth: strong ? 2 : 1,
    boxShadow: quiet
      ? undefined
      : `0 0 0 1px color-mix(in srgb, ${color} 18%, transparent), 0 0 14px -4px ${color}`,
    ...(selected ? { outline: '2px dashed var(--color-accent)', outlineOffset: 3 } : {}),
  }
}

function SessionCardNodeImpl({ id, data, selected }: NodeProps<MapNode>) {
  const card = data as SessionCardData
  const { node } = card
  const actions = useMapActions()
  const focus = useMapFocus()
  const zoom = useZoom()
  const ind = useIndicator(node)
  // Terminal no cartão é sempre o corpo inteiro: o zoom semântico não o encolhe.
  const detail: CardDetail = card.view === 'terminal' ? 'full' : cardDetail(zoom)
  // Só esmaece quem não pede nada: o terminal em uso (o clique no xterm não
  // seleciona o nó), quem trabalha e quem precisa de você ficam legíveis — "ver
  // as sessões trabalhando" não pode depender de onde está a seleção.
  const dimmed =
    focus.dimOthers &&
    !focus.nodes.has(id) &&
    card.view !== 'terminal' &&
    !ACTIVE_TONES.has(ind.tone)
  const frame = frameStyle(ind.tone, !!selected)
  const alertClass = ind.tone === 'needs-you' ? 'session-card-alert' : ''

  if (detail === 'blocks') {
    const color = TONE_COLOR[ind.tone]
    return (
      <div
        data-testid="session-card"
        data-session-id={node.sessionId}
        data-detail="blocks"
        data-view={card.view}
        data-tone={ind.tone}
        title={cardTitle(node)}
        className={`h-full w-full rounded-lg border ${alertClass}`}
        style={{
          ...frame,
          background: `color-mix(in srgb, ${color} ${ind.tone === 'ended' ? 14 : 45}%, var(--color-surface))`,
          opacity: dimmed ? 0.28 : 1,
        }}
      />
    )
  }

  return (
    <div
      data-testid="session-card"
      data-session-id={node.sessionId}
      data-detail={detail}
      data-view={card.view}
      data-tone={ind.tone}
      onContextMenu={(e) => actions.openContextMenu(e, `s:${node.sessionId}`)}
      // O fundo fica SEMPRE opaco: com opacity no cartão inteiro (encerrada, foco)
      // os fios que passam por baixo apareciam através dele. Esmaece só o conteúdo.
      // A caixa desenhada só ocupa o que tem (a vaga do layout é o teto): sem
      // isto sobrava uma caixa alta vazia no aberto e no resumido. relative: as
      // âncoras dos fios seguem a borda desenhada, não a da vaga.
      className={`group relative w-full rounded-lg border bg-[var(--color-surface)] transition ${
        card.view === 'terminal'
          ? 'h-full'
          : card.view === 'collapsed'
            ? 'h-full overflow-hidden'
            : 'max-h-full'
      } ${detail === 'full' && card.view === 'open' ? 'flex flex-col overflow-hidden' : ''} ${alertClass}`}
      data-dimmed={dimmed ? 'true' : undefined}
      style={frame}
    >
      <BorderHandles />
      {card.view === 'terminal' && (
        <NodeResizeControl
          minWidth={TERMINAL_MIN_W}
          minHeight={TERMINAL_MIN_H}
          position="bottom-right"
          onResizeEnd={(_e, p) =>
            actions.resizeTerminal(node.sessionId, { w: p.width, h: p.height })
          }
          style={{ background: 'transparent', border: 'none' }}
        >
          <span
            data-testid="card-resize"
            title="Redimensionar o terminal"
            className="absolute bottom-0.5 right-0.5 h-3 w-3 cursor-nwse-resize border-b-2 border-r-2 border-[var(--color-text-dim)]"
          />
        </NodeResizeControl>
      )}
      <div
        className={`w-full ${dimmed ? 'session-card-dimmed' : ''} ${
          detail === 'full' && card.view !== 'collapsed'
            ? 'flex min-h-0 flex-1 flex-col gap-1.5 px-2.5 py-2'
            : 'h-full'
        } ${card.view === 'terminal' ? 'h-full' : ''}`}
      >
        {detail === 'brief' ? (
          <BriefBody data={card} zoom={zoom} ind={ind} />
        ) : card.view === 'collapsed' ? (
          <CollapsedBody data={card} ind={ind} />
        ) : (
          <CardBody data={card} ind={ind} />
        )}
      </div>
      <Handle
        type="source"
        position={Position.Right}
        title="Arraste até a lane de outro repo para delegar"
        className="!h-2.5 !w-2.5 !border !border-[var(--color-accent)] !bg-[var(--color-surface)] opacity-0 transition group-hover:opacity-100"
      />
    </div>
  )
}

export const SessionCardNode = memo(SessionCardNodeImpl)
