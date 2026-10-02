import type { ComponentType, CSSProperties } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ChevronDown,
  ChevronRight,
  Circle,
  Loader,
  Maximize2,
  Pin,
  Power,
  Zap,
  type LucideProps,
} from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import { ApexDot } from '@/features/brand'
import { SessionFeatureChip } from '@/features/sessions/SessionFeatureChip'
import { ProviderBadge } from '@/features/sessions/ProviderBadge'
import { relativeTime } from '@/lib/time'
import { pendingEndSessionIds, useAppStore } from '@/store/appStore'
import { useVisibleLiveSessions } from './useGlobalSessions'
import { useWaitingCount } from './useWaitingCount'
import { orderSessions } from './strip-pins'
import { useStripPinsStore } from './strip-pins-store'
import type { LiveSessionInfo } from '../../../shared/types/ipc'
import { liveSessionLabel } from './session-label'
import { clippedCount } from './strip-overflow'

type LiveStatus = LiveSessionInfo['status']

interface Props {
  onOpenSwitcher: () => void
}

// Ícone por estado: a FORMA carrega o status (spin trabalhando, raio aguardando,
// círculo ocioso) e a COR carrega o projeto — um glifo só, sem dots redundantes.
function statusIcon(status: LiveStatus): { icon: ComponentType<LucideProps>; spin: boolean } {
  switch (status) {
    case 'working':
    case 'starting':
      return { icon: Loader, spin: true }
    case 'waiting':
      return { icon: Zap, spin: false }
    case 'idle':
    case 'ended':
    default:
      return { icon: Circle, spin: false }
  }
}

function statusLabel(status: LiveStatus): string {
  switch (status) {
    case 'working':
      return 'trabalhando'
    case 'starting':
      return 'iniciando'
    case 'waiting':
      return 'aguardando você'
    case 'idle':
      return 'ocioso'
    case 'ended':
    default:
      return 'encerrada'
  }
}

export function SessionStrip({ onOpenSwitcher }: Props) {
  const liveSessions = useAppStore((s) => s.liveSessions)
  const panes = useAppStore((s) => s.panes)
  const focusPaneId = useAppStore((s) => s.focusPaneId)
  const focusOrOpenSession = useAppStore((s) => s.focusOrOpenSession)
  const endSession = useAppStore((s) => s.endSession)
  // Filhas de handoff sem pane aberta vivem no Crew Dock, não na barra — senão o
  // usuário fica com N chips pra monitorar. Abriu o terminal de uma, ela ganha
  // chip aqui como qualquer sessão (ver useVisibleLiveSessions).
  const visibleSessions = useVisibleLiveSessions()
  const waitingCount = useWaitingCount()
  const pinnedIds = useStripPinsStore((s) => s.pinnedIds)
  const pinsLoaded = useStripPinsStore((s) => s.loaded)
  const loadPins = useStripPinsStore((s) => s.load)
  const togglePin = useStripPinsStore((s) => s.togglePin)
  const prunePins = useStripPinsStore((s) => s.prune)
  // Tick pra reavaliar os tempos relativos no tooltip sem novos broadcasts.
  const [, setNow] = useState(() => Date.now())

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 5000)
    return () => clearInterval(id)
  }, [])

  useEffect(() => {
    void loadPins()
  }, [loadPins])

  // Higiene: descarta pins de sessões que não existem mais. Poda contra TODAS
  // as liveSessions (não só as visíveis) pra não perder pin de filha de handoff
  // temporariamente oculta. Lista vazia = provável boot antes do 1º broadcast —
  // não podar, senão apagaríamos pins válidos. O store ainda aplica carência de
  // 2 snapshots não-vazios antes de remover (snapshot parcial não apaga pin).
  // Sessões na janela de undo do Encerrar ficam fora do prune: o snapshot as
  // filtra de propósito, mas "Desfazer" as traz de volta — e ainda fixadas.
  useEffect(() => {
    if (!pinsLoaded || liveSessions.length === 0) return
    void prunePins(new Set(liveSessions.map((item) => item.id)), pendingEndSessionIds())
  }, [pinsLoaded, liveSessions, prunePins])

  // Fixados primeiro (ordem de fixação); resto na ordem original. Sem
  // auto-reorder por status — o sinal de "aguardando" é a cor/badge.
  const orderedSessions = useMemo(
    () =>
      orderSessions(
        visibleSessions.filter((item) => item.status !== 'ended'),
        pinnedIds,
      ),
    [visibleSessions, pinnedIds],
  )

  // ccSessionId → paneId das sessões exibidas no split (destaque "aberta").
  // Sessão sem id nativo (Codex) vem na lista viva chaveada pelo sessions.id.
  const openByCc = useMemo(() => {
    const m = new Map<string, string>()
    for (const p of panes) m.set(p.session.ccSessionId ?? p.session.id, p.paneId)
    return m
  }, [panes])

  // Overflow: quando há chip "aguardando" fora da viewport da barra, mostra um
  // indicador discreto que rola até ele — o chip não pula de posição sozinho.
  const scrollRef = useRef<HTMLDivElement>(null)
  const [waitingOffscreen, setWaitingOffscreen] = useState(false)
  const [clipped, setClipped] = useState<{ left: number; right: number; hidden: number[] }>({
    left: 0,
    right: 0,
    hidden: [],
  })

  const findOffscreenWaiting = useCallback((): HTMLElement | null => {
    const el = scrollRef.current
    if (!el) return null
    const bounds = el.getBoundingClientRect()
    for (const chip of el.querySelectorAll<HTMLElement>('[data-waiting="true"]')) {
      const r = chip.getBoundingClientRect()
      if (r.right > bounds.right + 1 || r.left < bounds.left - 1) return chip
    }
    return null
  }, [])

  const checkOverflow = useCallback(() => {
    setWaitingOffscreen(findOffscreenWaiting() !== null)
    const el = scrollRef.current
    if (!el) return
    const chips = [...el.querySelectorAll<HTMLElement>('[data-strip-chip]')].map((c) =>
      c.getBoundingClientRect(),
    )
    const next = clippedCount(el.getBoundingClientRect(), chips)
    setClipped((prev) =>
      prev.left === next.left &&
      prev.right === next.right &&
      prev.hidden.join() === next.hidden.join()
        ? prev
        : next,
    )
  }, [findOffscreenWaiting])

  useEffect(() => {
    checkOverflow()
    window.addEventListener('resize', checkOverflow)
    // Arrastar o split-pane muda a largura da barra sem window resize — o
    // ResizeObserver no container cobre qualquer mudança de layout.
    const el = scrollRef.current
    const observer = el ? new ResizeObserver(checkOverflow) : null
    if (el && observer) observer.observe(el)
    return () => {
      window.removeEventListener('resize', checkOverflow)
      observer?.disconnect()
    }
  }, [checkOverflow, orderedSessions])

  const scrollToWaiting = useCallback(() => {
    findOffscreenWaiting()?.scrollIntoView({ inline: 'nearest', behavior: 'smooth' })
  }, [findOffscreenWaiting])

  return (
    <div className="flex h-[38px] shrink-0 items-center gap-1 border-b border-[var(--color-border)] bg-[color-mix(in_srgb,var(--color-surface)_40%,transparent)] px-2">
      {visibleSessions.length === 0 ? (
        <span className="px-1 text-[11px] text-[var(--color-text-dim)]">
          Nenhuma sessão viva — clique num repo.
        </span>
      ) : (
        <div
          ref={scrollRef}
          onScroll={checkOverflow}
          data-testid="session-strip-scroll"
          className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          // Fade na borda que tem chips além dela, no lugar da scrollbar.
          style={stripMask(clipped)}
        >
          {orderedSessions.map((item, index) => {
            const paneId = openByCc.get(item.ccSessionId)
            const isOpen = paneId !== undefined
            const isFocused = isOpen && paneId === focusPaneId
            return (
              <Chip
                key={item.ccSessionId}
                item={item}
                isOpen={isOpen}
                isFocused={isFocused}
                isPinned={pinnedIds.includes(item.id)}
                // Fora do "+N" sem caber nem ícone + nome: invisível, mas mantém o
                // lugar (a medição seguinte não oscila).
                hidden={clipped.hidden.includes(index)}
                onOpen={() => void focusOrOpenSession(item)}
                onEnd={() => endSession(item.id)}
                onTogglePin={() => void togglePin(item.id)}
              />
            )
          })}
        </div>
      )}

      {waitingOffscreen && (
        <button
          type="button"
          onClick={scrollToWaiting}
          title="Sessão aguardando fora da barra — rolar até ela"
          aria-label="Sessão aguardando fora da barra — rolar até ela"
          className="relative flex h-6 w-5 shrink-0 items-center justify-center rounded text-[var(--color-text-dim)] transition hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text)]"
        >
          <Icon as={ChevronRight} size={13} />
          <span className="absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-[var(--color-warning)]" />
        </button>
      )}

      {clipped.left + clipped.right > 0 && (
        <button
          type="button"
          data-testid="session-strip-more"
          onClick={onOpenSwitcher}
          title="Sessões fora da barra — abrir o seletor"
          className="flex h-6 shrink-0 items-center gap-0.5 rounded px-1.5 text-[11px] text-[var(--color-text-dim)] transition hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text)]"
        >
          <Icon as={ChevronDown} size={12} />+{clipped.left + clipped.right}
        </button>
      )}

      <button
        type="button"
        onClick={onOpenSwitcher}
        title={
          waitingCount > 0
            ? `Abrir seletor de sessões · ${waitingCount} aguardando você`
            : 'Abrir seletor de sessões'
        }
        className="relative ml-1 flex h-6 w-6 shrink-0 items-center justify-center rounded text-[var(--color-text-dim)] transition hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text)]"
      >
        <Icon as={Maximize2} size={13} />
        {waitingCount > 0 && (
          <span className="absolute -right-1 -top-1 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-[var(--color-warning)] px-0.5 text-[9px] font-semibold leading-none text-black">
            {waitingCount}
          </span>
        )}
      </button>
    </div>
  )
}

const FADE_PX = 24

function stripMask(clipped: { left: number; right: number }): CSSProperties | undefined {
  if (!clipped.left && !clipped.right) return undefined
  const l = clipped.left ? `transparent, black ${FADE_PX}px` : 'black, black'
  const r = clipped.right ? `black calc(100% - ${FADE_PX}px), transparent` : 'black'
  const mask = `linear-gradient(to right, ${l}, ${r})`
  return { maskImage: mask, WebkitMaskImage: mask }
}

interface ChipProps {
  item: LiveSessionInfo
  isOpen: boolean
  isFocused: boolean
  isPinned: boolean
  hidden?: boolean
  onOpen: () => void
  onEnd: () => void
  onTogglePin: () => void
}

function Chip({ item, isOpen, isFocused, isPinned, hidden = false, onOpen, onEnd, onTogglePin }: ChipProps) {
  const title = liveSessionLabel(item)
  const preview = item.lastText?.replace(/\s+/g, ' ').trim()
  const tooltip = `${statusLabel(item.status)} · ${relativeTime(item.lastActivityAt)}${
    preview ? `\n${preview}` : ''
  }`
  const { icon, spin } = statusIcon(item.status)
  const waiting = item.status === 'waiting'

  return (
    <div
      data-strip-chip
      data-waiting={waiting || undefined}
      data-clipped-hidden={hidden || undefined}
      aria-hidden={hidden || undefined}
      className={`group relative flex h-7 shrink-0 items-center gap-1.5 rounded-lg border px-2.5 text-[11px] transition ${
        isFocused
          ? 'border-[color-mix(in_srgb,var(--color-accent)_55%,transparent)] text-[var(--color-text)]'
          : isOpen
            ? 'border-[var(--color-border)] bg-[var(--color-surface-2)]/60 text-[var(--color-text)]'
            : 'border-transparent text-[var(--color-text-dim)] hover:bg-[var(--color-surface-2)]/60 hover:text-[var(--color-text)]'
      }`}
      style={{
        ...(isFocused
          ? {
              background:
                'linear-gradient(90deg, color-mix(in srgb, var(--color-accent) 16%, transparent), color-mix(in srgb, var(--color-accent2) 6%, transparent))',
            }
          : {}),
        ...(hidden ? { visibility: 'hidden' as const } : {}),
      }}
      title={tooltip}
    >
      <button type="button" onClick={onOpen} className="flex min-w-0 items-center gap-2">
        {/* Aguardando ("no box · sua vez") ganha O Ápice pulsante; demais estados
            mantêm o glifo cuja FORMA carrega o status e a COR o projeto. */}
        {waiting ? (
          <ApexDot size={7} active color="var(--color-accent)" className="shrink-0" />
        ) : (
          <Icon
            as={icon}
            size={12}
            className={spin ? 'shrink-0 animate-spin' : 'shrink-0'}
            // Girando, a cor é a do status (a mesma do ponto do cartão): na cor do
            // projeto, as abas do Pessoal giravam em vermelho e liam como erro.
            style={{
              color: spin ? 'var(--color-info)' : (item.projectColor ?? 'var(--color-border)'),
            }}
          />
        )}
        {spin && item.projectColor && (
          <span
            data-testid="tab-project-dot"
            aria-hidden
            className="h-1.5 w-1.5 shrink-0 rounded-full"
            style={{ background: item.projectColor }}
          />
        )}
        <span className="max-w-40 truncate">{title}</span>
        <ProviderBadge provider={item.provider} />
      </button>
      <SessionFeatureChip sessionId={item.id} density="dot" />
      {/* Fixado: o próprio botão vira o indicador (sempre visível, preenchido). */}
      {isPinned && <PinButton isPinned onTogglePin={onTogglePin} />}
      {/* Ações do hover sobrepostas à ponta da aba: invisíveis com largura, eram
          ~40px de vão morto à direita do nome em cada aba; inline no hover, a
          aba crescia e empurrava as vizinhas. */}
      <span className="absolute inset-y-0 right-0 hidden items-center gap-1.5 rounded-r-lg bg-[var(--color-surface-2)] pl-1.5 pr-2 group-focus-within:flex group-hover:flex">
        {!isPinned && <PinButton isPinned={false} onTogglePin={onTogglePin} />}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onEnd()
          }}
          title="Encerrar o processo desta sessão"
          aria-label="Encerrar o processo desta sessão"
          className="shrink-0 leading-none text-[var(--color-text-dim)] transition hover:text-[var(--color-danger)] focus-visible:outline focus-visible:outline-1 focus-visible:outline-[var(--color-danger)]"
        >
          <Icon as={Power} size={12} />
        </button>
      </span>
    </div>
  )
}

function PinButton({ isPinned, onTogglePin }: { isPinned: boolean; onTogglePin: () => void }) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation()
        onTogglePin()
      }}
      title={isPinned ? 'Desafixar do início da barra' : 'Fixar no início da barra'}
      aria-label={isPinned ? 'Desafixar do início da barra' : 'Fixar no início da barra'}
      aria-pressed={isPinned}
      className={`shrink-0 leading-none transition focus-visible:outline focus-visible:outline-1 focus-visible:outline-[var(--color-accent)] ${
        isPinned
          ? 'text-[var(--color-accent)]'
          : 'text-[var(--color-text-dim)] hover:text-[var(--color-text)]'
      }`}
    >
      <Icon as={Pin} size={11} className={isPinned ? 'fill-current' : undefined} />
    </button>
  )
}
