import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronRight, Users } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import { ApexDot } from '@/features/brand'
import { usePanelTier } from '@/features/sessions/use-panel-tier'
import { useCrewWaitingCount } from '@/features/session-switcher/useWaitingCount'
import { useAppStore } from '@/store/appStore'
import { useHandoffsStore } from '@/store/handoffsStore'
import { HandoffCard, STATUS_COLOR, liveBadgeFor, useHeartbeatTtl } from './HandoffCard'
import {
  activeCrew,
  crewNeedsAttention,
  orderCrew,
  resolveCrewFocus,
  splitAlias,
  stepCrewFocus,
} from './crew'
import { RAIL_WIDTH, clampWidth, useCrewDockStore } from './crew-dock-store'
import type { Handoff, LiveSessionInfo } from '../../../shared/types/ipc'

// Crew Dock: as sessões-filhas de handoff, na periferia da janela. Fica colapsado
// numa trilha de dots (presente, sem ocupar área) e SÓ ABRE quando você manda —
// clique ou Ctrl+J. Quando alguma filha passa a esperar, quem avisa é a trilha:
// O Ápice pulsa e o contador acende em âmbar, dentro dos 40px. Peek in-place: dá
// pra ler e responder daqui, sem abrir pane (o cap de contextos WebGL é 8;
// "Abrir terminal" continua sendo ação explícita, dentro do card).
// Montado como IRMÃO de <main> no AppShell — vive fora do plano de abas do
// dockview, então não mistura com as sessões-mãe nem some fora da área projetos.

// Largura que o dock ocupa AGORA (0 = sem equipe, o dock nem monta). Quem
// desenha por cima da janela — a pilha de toasts — se desloca por ela: um aviso
// não pode cobrir o painel de onde ele veio.
export function useCrewDockWidth(): number {
  const handoffs = useHandoffsStore((s) => s.handoffs)
  const collapsed = useCrewDockStore((s) => s.collapsed)
  const width = useCrewDockStore((s) => s.width)
  const hasCrew = useMemo(() => activeCrew(handoffs).length > 0, [handoffs])
  if (!hasCrew) return 0
  return collapsed ? RAIL_WIDTH : width
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

// Gate: o painel abaixo só monta quando há equipe — o que também garante que o
// ResizeObserver do usePanelTier pegue o elemento já existente.
export function CrewDock() {
  const handoffs = useHandoffsStore((s) => s.handoffs)
  const liveSessions = useAppStore((s) => s.liveSessions)
  const attention = useCrewWaitingCount()

  const crew = useMemo(() => orderCrew(handoffs, liveSessions), [handoffs, liveSessions])
  const liveById = useMemo(() => new Map(liveSessions.map((s) => [s.id, s])), [liveSessions])

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
  const width = useCrewDockStore((s) => s.width)
  const setWidth = useCrewDockStore((s) => s.setWidth)
  const expand = useCrewDockStore((s) => s.expand)
  const collapse = useCrewDockStore((s) => s.collapse)
  const openPeek = useCrewDockStore((s) => s.openPeek)
  const focusedId = useCrewDockStore((s) => s.focusedId)
  const setFocusedId = useCrewDockStore((s) => s.setFocusedId)
  const focusNonce = useCrewDockStore((s) => s.focusNonce)
  const ttlHours = useHeartbeatTtl()
  const { ref, tier } = usePanelTier<HTMLDivElement>()

  // Largura durante o arrasto fica local — só o commit no pointerup persiste.
  const [dragWidth, setDragWidth] = useState<number | null>(null)
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null)

  const expanded = !collapsed
  const shownWidth = dragWidth ?? width

  // ── Teclado: Ctrl+J entra, ↑/↓ andam, Espaço/Enter espiam, Esc sai ─────────
  const listRef = useRef<HTMLDivElement>(null)
  // Anel de foco só quando o dock REALMENTE tem o foco — senão o card 0 ficaria
  // marcado o tempo todo, prometendo um teclado que não está ali.
  const [dockFocused, setDockFocused] = useState(false)
  // Quem tinha o foco antes do Ctrl+J (tipicamente o textarea do xterm). O Esc
  // no dock devolve pra lá: sair rápido é metade do valor de entrar rápido.
  const originRef = useRef<HTMLElement | null>(null)

  const ids = useMemo(() => crew.map((h) => h.id), [crew])
  // Lido dentro de handlers/efeitos que não devem re-rodar a cada mudança da lista.
  const idsRef = useRef(ids)
  idsRef.current = ids

  // Filha entrou/saiu (ou a atenção reordenou): mantém o cursor num card que
  // ainda existe. setFocusedId é no-op quando o valor não muda.
  useEffect(() => {
    setFocusedId(resolveCrewFocus(ids, useCrewDockStore.getState().focusedId))
  }, [ids, setFocusedId])

  function focusCard(id: string) {
    listRef.current?.querySelector<HTMLElement>(`[data-crew-card="${CSS.escape(id)}"]`)?.focus()
  }

  // Pedido de foco do AppShell (Ctrl+J). Nonce, não booleano: pedir duas vezes
  // seguidas tem que disparar duas vezes.
  useEffect(() => {
    if (focusNonce === 0) return
    const active = document.activeElement
    // Ctrl+J com o foco já no dock não pode sobrescrever a origem real.
    if (!(active instanceof HTMLElement) || !listRef.current?.contains(active)) {
      originRef.current = active instanceof HTMLElement ? active : null
    }
    const target = useCrewDockStore.getState().focusedId ?? idsRef.current[0]
    if (!target) return
    // rAF: o expand() do requestFocus pode ter acabado de montar estes cards.
    requestAnimationFrame(() => focusCard(target))
  }, [focusNonce])

  function leaveDock(card: HTMLElement) {
    const origin = originRef.current
    if (origin?.isConnected && !listRef.current?.contains(origin)) origin.focus()
    else card.blur()
  }

  function onCardKeyDown(e: React.KeyboardEvent<HTMLDivElement>, id: string) {
    // Só age com o foco no CARD (o wrapper). Dentro do textarea de resposta o
    // evento bubbla até aqui com outro target — lá, Espaço é espaço.
    if (e.target !== e.currentTarget) return
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const next = stepCrewFocus(idsRef.current, id, e.key === 'ArrowDown' ? 1 : -1)
      if (next) focusCard(next)
    } else if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault()
      openPeek(id)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      leaveDock(e.currentTarget)
    }
  }

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

          <div
            ref={listRef}
            onFocus={() => setDockFocused(true)}
            onBlur={() => setDockFocused(false)}
            className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2"
          >
            {crew.map((h) => (
              // Wrapper focável de verdade: sem um elemento que receba foco, o
              // Espaço vazaria pro xterm em vez de abrir o peek. tabIndex -1
              // porque a entrada é pelo Ctrl+J — os botões/textarea de dentro do
              // card já ocupam a ordem natural do Tab.
              <div
                key={h.id}
                data-crew-card={h.id}
                tabIndex={-1}
                // Foco (do teclado ou do mouse) é a verdade: o cursor do store
                // segue o DOM, não o contrário.
                onFocus={() => setFocusedId(h.id)}
                onKeyDown={(e) => onCardKeyDown(e, h.id)}
                className={`shrink-0 rounded-[14px] outline-none ${
                  dockFocused && h.id === focusedId
                    ? 'ring-1 ring-[var(--color-accent)] ring-offset-0'
                    : ''
                }`}
              >
                <HandoffCard
                  handoff={h}
                  ttlHours={ttlHours}
                  tier={tier}
                  onPeek={() => {
                    // Foca o card ANTES de abrir: o peek guarda o activeElement
                    // como origem, e devolver o foco ao card (não ao botão) deixa
                    // as setas prontas assim que o overlay fecha.
                    focusCard(h.id)
                    openPeek(h.id)
                  }}
                />
              </div>
            ))}
          </div>
        </>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col items-center gap-2 py-2">
          {/* Aviso de espera cabe nos 40px: O Ápice pulsa na filha que espera
              (abaixo) e o contador acende em âmbar aqui. Abrir 340px por cima da
              leitura, sozinho, era interrupção maior que o aviso — agora é
              clique ou Ctrl+J. */}
          <button
            type="button"
            onClick={expand}
            title={
              attention > 0
                ? `${attention} filha(s) esperando você — clique ou Ctrl+J para abrir`
                : `Equipe: ${crew.length} sessão(ões) delegada(s) — clique ou Ctrl+J para abrir`
            }
            className="rounded p-1 text-[var(--color-text-dim)] transition hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text)]"
          >
            <Icon as={Users} size={16} />
          </button>
          <button
            type="button"
            onClick={expand}
            title={
              attention > 0
                ? `${attention} filha(s) esperando você`
                : `${crew.length} sessão(ões) delegada(s)`
            }
            className="rounded px-1 font-mono text-[10px] tabular-nums transition hover:bg-[var(--color-surface-2)]"
            style={{ color: attention > 0 ? 'var(--color-warning)' : 'var(--color-text-dim)' }}
          >
            {attention > 0 ? `${attention}!` : crew.length}
          </button>
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
