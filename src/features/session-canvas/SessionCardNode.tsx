import { memo, useState } from 'react'
import { Handle, Position, useStore, type NodeProps } from '@xyflow/react'
import {
  ChevronDown,
  ChevronRight,
  ChevronUp,
  History,
  Pencil,
  Sparkles,
  SquareTerminal,
  StickyNote,
} from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import { relativeTime } from '@/lib/time'
import { useAppStore } from '@/store/appStore'
import type { CardViewState } from '../../../shared/types/canvas'
import { OPEN_H, type MapNode, type SessionCardData } from './graph-to-flow'
import { TONE_COLOR, indicatorText, type CardIndicator } from './card-indicator'
import { useMapLive } from './map-live'
import {
  ACTIVE_TONES,
  BorderHandles,
  StatusPill,
  frameStyle,
  useIndicator,
  useReportCardHeight,
} from './card-parts'
import { MotherCard } from './MotherCard'
import { CardResizer } from './CardResizer'
import { CardAttention, CardPromptBar, LiveTail } from './SessionCardLive'
import { isActionableDetail } from '@/features/session-switcher/AttentionPopover'
import { useMapActions } from './map-context'
import { useMapFocus } from './map-focus'
import {
  briefSay,
  cardDetail,
  cardFooter,
  cardTitle,
  compensatedPx,
  quantizeZoom,
  type CardDetail,
} from './card-display'
import { PurposeLine } from './PurposeLine'
import { ProviderBadge } from '@/features/sessions/ProviderBadge'
import { BatonPassedChip, MotherBadge } from './MotherBadge'
import { motherFrame } from './mother-badge'

function FanChip({ data }: { data: SessionCardData }) {
  const actions = useMapActions()
  const n = data.childCount
  if (n === 0) return null
  const label = `${n} ${n === 1 ? 'filha' : 'filhas'}`
  if (!data.fanCollapsible) {
    // O badge "MÃE · n filhas" já diz a contagem; repetir só come o nome.
    if (data.node.isMother) return null
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
      aria-label={data.node.isMother ? label : undefined}
    >
      {/* Na mãe o badge já mostra a contagem: aqui fica só o chevron. */}
      {!data.node.isMother && label}
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
      <BatonPassedChip node={node} />
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

// Botão da direita: abre o terminal real na modal do mapa (nunca "Recolher",
// que é o chevron da esquerda).
function TerminalToggle({ data }: { data: SessionCardData }) {
  const { node } = data
  const actions = useMapActions()
  if (node.status === 'ended') return null
  return (
    <button
      type="button"
      data-testid="card-interact"
      onClick={(e) => {
        e.stopPropagation()
        actions.interact(node.sessionId)
      }}
      title="Terminal: o terminal real da sessão numa janela grande sobre o mapa (Enter ou duplo clique)"
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
      // O duplo clique (aqui ou no resto do cartão) abre o terminal na modal: é o
      // onNodeDoubleClick do mapa. Recolher é o chevron.
    >
      <ViewToggle data={data} view={view} />
      <span
        data-testid="card-title"
        className="min-w-0 shrink truncate text-[14px] font-medium text-[var(--color-text)]"
        title={node.title}
      >
        {cardTitle(node)}
      </span>
      <MotherBadge node={node} />
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
      <TerminalToggle data={data} />
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
      <MotherBadge node={node} compact />
      <BatonPassedChip node={node} compact />
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
  // Menu inline na tela: o tail repetiria o comando que o painel já mostra.
  const item = useMapLive().attention.get(node.sessionId)
  const menuInline = !!item && isActionableDetail(item.detail)
  return (
    <>
      <Header data={data} view={view} />
      <StateLine data={data} ind={ind} />
      <PurposeLine sessionId={node.sessionId} purpose={node.purpose} source={node.purposeSource} />
      {view === 'open' && (
        <>
          <Footer data={data} />
          <CardAttention node={node} />
          {!menuInline && (
            <LiveTail node={node} window={data.tail?.window} lines={data.tail?.lines} />
          )}
          <CardPromptBar node={node} />
        </>
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
  const say = briefSay(ind, firstLineOf(lastText), node)
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
        <MotherBadge node={node} compact />
        {data.view === 'collapsed' && <BatonPassedChip node={node} compact />}
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
          <span className="flex-1" />
          <BatonPassedChip node={node} compact />
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
  return useStore((s) => quantizeZoom(s.transform[2]))
}

function RegularCard({ id, data, selected }: NodeProps<MapNode>) {
  const card = data as SessionCardData
  const { node } = card
  const actions = useMapActions()
  const focus = useMapFocus()
  const zoom = useZoom()
  const ind = useIndicator(node)
  const detail: CardDetail = cardDetail(zoom)
  // Só esmaece quem não pede nada: quem trabalha e quem precisa de você ficam
  // legíveis — "ver as sessões trabalhando" não pode depender da seleção.
  const dimmed = focus.dimOthers && !focus.nodes.has(id) && !ACTIVE_TONES.has(ind.tone)
  const frame = motherFrame(node, frameStyle(ind.tone, !!selected))
  const alertClass = ind.tone === 'needs-you' ? 'session-card-alert' : ''
  // Aberto em detalhe cheio: a caixa cresce com o conteúdo até a vaga máxima e o
  // layout segue a altura medida (a vaga do nó acompanha no frame seguinte).
  // Redimensionado pelo usuário: a caixa preenche a vaga (o tamanho é dele).
  const [resizing, setResizing] = useState(false)
  const sized = card.sized || resizing
  const sizedByContent = detail === 'full' && card.view === 'open' && !sized
  const fill = detail === 'full' && card.view !== 'collapsed' && sized
  const measureRef = useReportCardHeight(node.sessionId, sizedByContent)
  const resizable = detail === 'full' && card.view !== 'collapsed'

  if (detail === 'blocks') {
    const color = TONE_COLOR[ind.tone]
    return (
      <div
        data-testid="session-card"
        data-session-id={node.sessionId}
        data-detail="blocks"
        data-mother={node.isMother ? 'true' : undefined}
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
    <>
      <div
        data-testid="session-card"
        data-session-id={node.sessionId}
        data-detail={detail}
        data-mother={node.isMother ? 'true' : undefined}
        data-view={card.view}
        data-tone={ind.tone}
        data-sized={card.sized ? 'true' : undefined}
        onContextMenu={(e) => actions.openContextMenu(e, `s:${node.sessionId}`)}
        // O fundo fica SEMPRE opaco: com opacity no cartão inteiro (encerrada, foco)
        // os fios que passam por baixo apareciam através dele. Esmaece só o conteúdo.
        // A caixa desenhada só ocupa o que tem (a vaga do layout é o teto): sem
        // isto sobrava uma caixa alta vazia no aberto e no resumido. relative: as
        // âncoras dos fios seguem a borda desenhada, não a da vaga.
        ref={measureRef}
        className={`group relative w-full rounded-lg border bg-[var(--color-surface)] transition ${
          card.view === 'collapsed' || fill
            ? 'h-full overflow-hidden'
            : sizedByContent
              ? ''
              : 'max-h-full'
        } ${sizedByContent || fill ? 'flex flex-col overflow-hidden' : ''} ${alertClass}`}
        data-dimmed={dimmed ? 'true' : undefined}
        style={sizedByContent ? { ...frame, maxHeight: OPEN_H } : frame}
      >
        <BorderHandles />
        <div
          className={`w-full ${dimmed ? 'session-card-dimmed' : ''} ${
            detail === 'full' && card.view !== 'collapsed'
              ? 'flex min-h-0 flex-1 flex-col gap-1.5 px-2.5 py-2'
              : 'h-full'
          }`}
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
      {resizable && (
        <CardResizer
          sessionId={node.sessionId}
          mother={false}
          sized={card.sized}
          onResizing={setResizing}
        />
      )}
    </>
  )
}

// A mãe tem a própria variante (maior, sempre aberta). Dois componentes, e não um
// return cedo: a mesma sessão vira mãe ao ganhar a 1ª filha, e os hooks de um
// não podem mudar de ordem no meio da vida do nó.
function SessionCardNodeImpl(props: NodeProps<MapNode>) {
  return (props.data as SessionCardData).prominentMother ? (
    <MotherCard {...props} />
  ) : (
    <RegularCard {...props} />
  )
}

export const SessionCardNode = memo(SessionCardNodeImpl)
