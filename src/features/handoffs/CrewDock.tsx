import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronRight, Users } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import { ApexDot } from '@/features/brand'
import { usePanelTier } from '@/features/sessions/use-panel-tier'
import { useCrewWaitingCount } from '@/features/session-switcher/useWaitingCount'
import { useAppStore } from '@/store/appStore'
import { useHandoffsStore } from '@/store/handoffsStore'
import { HandoffCard, STATUS_COLOR, liveBadgeFor, useHeartbeatTtl } from './HandoffCard'
import { activeCrew, crewNeedsAttention, orderCrew, splitAlias } from './crew'
import { RAIL_WIDTH, clampWidth, dockExpanded, useCrewDockStore } from './crew-dock-store'
import type { Handoff, LiveSessionInfo } from '../../../shared/types/ipc'

// Crew Dock: as sessões-filhas de handoff, na periferia da janela. Fica colapsado
// numa trilha de dots (presente, sem ocupar área) e ABRE SOZINHO quando alguma
// filha passa a esperar você — recolhendo de volta quando a espera acaba. Peek
// in-place: dá pra ler e responder daqui, sem abrir pane (o cap de contextos
// WebGL é 8; "Abrir terminal" continua sendo ação explícita, dentro do card).
// Montado como IRMÃO de <main> no AppShell — vive fora do plano de abas do
// dockview, então não mistura com as sessões-mãe nem some fora da área projetos.

// Largura que o dock ocupa AGORA (0 = sem equipe, o dock nem monta). Quem
// desenha por cima da janela — a pilha de toasts — se desloca por ela: um aviso
// não pode cobrir o painel de onde ele veio.
export function useCrewDockWidth(): number {
  const handoffs = useHandoffsStore((s) => s.handoffs)
  const collapsed = useCrewDockStore((s) => s.collapsed)
  const autoRevealed = useCrewDockStore((s) => s.autoRevealed)
  const width = useCrewDockStore((s) => s.width)
  const hasCrew = useMemo(() => activeCrew(handoffs).length > 0, [handoffs])
  if (!hasCrew) return 0
  return dockExpanded({ collapsed, autoRevealed }) ? width : RAIL_WIDTH
}

function crewDotColor(handoff: Handoff, live: LiveSessionInfo | undefined): string {
  if (live) return liveBadgeFor(live.status).color
  return STATUS_COLOR[handoff.status]
}

function crewDotTitle(handoff: Handoff, live: LiveSessionInfo | undefined): string {
  const alias = splitAlias(live?.title)
  const who = alias?.name ?? handoff.targetRepoLabel ?? handoff.targetRepoId
  const scope = alias?.scope ? ` (${alias.scope})` : ''
  const state = live ? liveBadgeFor(live.status).label : 'despachando'
  return `${who}${scope} — ${state}`
}

// Gate sempre montado: observa a equipe e mantém o auto-reveal sincronizado
// mesmo quando não há ninguém delegado (senão o dock reabriria sozinho no
// próximo handoff, carregando um autoRevealed velho). O painel abaixo só monta
// quando há equipe — o que também garante que o ResizeObserver do usePanelTier
// pegue o elemento já existente.
export function CrewDock() {
  const handoffs = useHandoffsStore((s) => s.handoffs)
  const liveSessions = useAppStore((s) => s.liveSessions)
  const syncAttention = useCrewDockStore((s) => s.syncAttention)
  const attention = useCrewWaitingCount()

  const crew = useMemo(() => orderCrew(handoffs, liveSessions), [handoffs, liveSessions])
  const liveById = useMemo(() => new Map(liveSessions.map((s) => [s.id, s])), [liveSessions])

  // Auto-reveal: o dock reage ao "tem alguém esperando?", não a um clique. O
  // store decide se abre (respeita o mute de quem acabou de recolher à mão).
  useEffect(() => {
    syncAttention(attention > 0)
  }, [attention, syncAttention])

  // Nada delegado, nenhum pixel gasto.
  if (crew.length === 0) return null

  return <CrewDockPanel crew={crew} liveById={liveById} attention={attention} />
}

interface PanelProps {
  crew: Handoff[]
  liveById: Map<string, LiveSessionInfo>
  attention: number
}

function CrewDockPanel({ crew, liveById, attention }: PanelProps) {
  const collapsed = useCrewDockStore((s) => s.collapsed)
  const autoRevealed = useCrewDockStore((s) => s.autoRevealed)
  const width = useCrewDockStore((s) => s.width)
  const setWidth = useCrewDockStore((s) => s.setWidth)
  const expand = useCrewDockStore((s) => s.expand)
  const collapse = useCrewDockStore((s) => s.collapse)
  const openPeek = useCrewDockStore((s) => s.openPeek)
  const ttlHours = useHeartbeatTtl()
  const { ref, tier } = usePanelTier<HTMLDivElement>()

  // Largura durante o arrasto fica local — só o commit no pointerup persiste.
  const [dragWidth, setDragWidth] = useState<number | null>(null)
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null)

  const expanded = dockExpanded({ collapsed, autoRevealed })
  const shownWidth = dragWidth ?? width

  // Só o primeiro "esperando" ganha O Ápice (regra da casa: um pulso por vista).
  const apexId = crew.find((h) =>
    crewNeedsAttention(h, h.childSessionId ? liveById.get(h.childSessionId) : undefined),
  )?.id

  return (
    <aside
      ref={ref}
      data-testid="crew-dock"
      data-expanded={expanded}
      className="relative flex shrink-0 flex-col overflow-hidden border-l border-[var(--color-border)] bg-[var(--color-surface)]"
      style={{ width: expanded ? shownWidth : RAIL_WIDTH }}
    >
      {expanded ? (
        <>
          <div
            role="separator"
            aria-orientation="vertical"
            title="Arraste para redimensionar"
            className="absolute inset-y-0 left-0 z-10 w-1 cursor-col-resize hover:bg-[var(--color-accent)]/40"
            onPointerDown={(e) => {
              e.preventDefault()
              e.currentTarget.setPointerCapture(e.pointerId)
              dragRef.current = { startX: e.clientX, startWidth: width }
              setDragWidth(width)
            }}
            onPointerMove={(e) => {
              const drag = dragRef.current
              if (!drag) return
              // Dock encostado na direita: arrastar pra esquerda alarga.
              setDragWidth(clampWidth(drag.startWidth - (e.clientX - drag.startX)))
            }}
            onPointerUp={(e) => {
              if (!dragRef.current) return
              e.currentTarget.releasePointerCapture(e.pointerId)
              dragRef.current = null
              if (dragWidth != null) setWidth(dragWidth)
              setDragWidth(null)
            }}
          />

          <header className="flex shrink-0 items-center gap-2 border-b border-[var(--color-border)] px-2 py-1.5">
            <Icon as={Users} size={14} className="shrink-0 text-[var(--color-text-dim)]" />
            <span className="text-xs font-medium text-[var(--color-text)]">Equipe</span>
            <span className="font-mono text-[11px] tabular-nums text-[var(--color-text-dim)]">
              {crew.length}
            </span>
            {attention > 0 && (
              <span
                className="truncate rounded-full border px-1.5 py-0.5 text-[10px] font-medium"
                style={{
                  color: 'var(--color-warning)',
                  borderColor: 'color-mix(in srgb, var(--color-warning) 45%, transparent)',
                  background: 'color-mix(in srgb, var(--color-warning) 12%, transparent)',
                }}
                title="Filhas aguardando você responder"
              >
                {attention} esperando
              </span>
            )}
            <button
              type="button"
              onClick={collapse}
              title="Recolher a equipe"
              className="ml-auto shrink-0 rounded p-1 text-[var(--color-text-dim)] transition hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text)]"
            >
              <Icon as={ChevronRight} size={14} />
            </button>
          </header>

          <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2">
            {crew.map((h) => (
              <HandoffCard
                key={h.id}
                handoff={h}
                ttlHours={ttlHours}
                tier={tier}
                onPeek={() => openPeek(h.id)}
              />
            ))}
          </div>
        </>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col items-center gap-2 py-2">
          <button
            type="button"
            onClick={expand}
            title={`Equipe: ${crew.length} sessão(ões) delegada(s)`}
            className="rounded p-1 text-[var(--color-text-dim)] transition hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text)]"
          >
            <Icon as={Users} size={16} />
          </button>
          <span
            className="font-mono text-[10px] tabular-nums"
            style={{ color: attention > 0 ? 'var(--color-warning)' : 'var(--color-text-dim)' }}
          >
            {attention > 0 ? `${attention}!` : crew.length}
          </span>
          <div className="flex min-h-0 flex-1 flex-col items-center gap-2.5 overflow-y-auto pt-1">
            {crew.map((h) => {
              const live = h.childSessionId ? liveById.get(h.childSessionId) : undefined
              const color = crewDotColor(h, live)
              return (
                <button
                  key={h.id}
                  type="button"
                  onClick={expand}
                  title={crewDotTitle(h, live)}
                  className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full transition hover:bg-[var(--color-surface-2)]"
                >
                  {h.id === apexId ? (
                    <ApexDot size={9} color="var(--color-warning)" />
                  ) : (
                    <span className="h-2 w-2 rounded-full" style={{ background: color }} />
                  )}
                </button>
              )
            })}
          </div>
        </div>
      )}
    </aside>
  )
}
