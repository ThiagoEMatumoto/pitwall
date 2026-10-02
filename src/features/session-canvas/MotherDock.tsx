import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { Crosshair, Crown, Maximize2, PinOff } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import { Terminal } from '@/features/sessions/Terminal'
import { useTerminalLease } from '@/features/sessions/terminal-lease'
import { useTerminalPrefsStore } from '@/lib/terminal-prefs-store'
import { formatCombo, resolveCombo } from '@/lib/keybindings'
import { useKeybindingsStore } from '@/lib/keybindings-store'
import { sessionFromLiveSession, useAppStore } from '@/store/appStore'
import type { SessionGraph } from '../../../shared/types/session-graph'
import { TONE_COLOR, indicatorFor, indicatorText } from './card-indicator'
import { cardTitle } from './card-display'
import { useMapLive } from './map-live'
import { clampDockWidth, fitDockToRow, useMotherDockStore } from './mother-dock'

// "Fixar mãe": a mãe numa coluna de altura total à esquerda do mapa — terminal
// REAL (o mesmo Terminal da modal, anexado à mesma PTY, com o composer dele;
// uma segunda barra aqui duplicava a entrada). A coluna segura a lease 'dock' (terminal-lease): a aba da mãe mostra
// "Fixada no mapa" e, se a modal abrir na mesma sessão, ela fica por cima e
// devolve a PTY à coluna ao fechar. O mapa segue navegável ao lado (é um irmão
// no flex, então o enquadrar desconta a largura sozinho).
const DOCK_FONT_PX = 14

export function MotherDock({
  graph,
  inUse,
  onOpenModal,
  onCenter,
}: {
  graph: SessionGraph
  inUse: ReadonlySet<string>
  onOpenModal: (sessionId: string) => void
  onCenter: (sessionId: string) => void
}) {
  const pinnedId = useMotherDockStore((s) => s.pinnedId)
  const storedWidth = useMotherDockStore((s) => s.width)
  const focusNonce = useMotherDockStore((s) => s.focusNonce)
  const live = useAppStore((s) =>
    pinnedId ? s.liveSessions.find((x) => x.id === pinnedId && x.status !== 'ended') : undefined,
  )
  const prefFontSize = useTerminalPrefsStore((s) => s.fontSize)
  const overrides = useKeybindingsStore((s) => s.overrides)
  const { now, workingSince } = useMapLive()
  const [dragW, setDragW] = useState<number | null>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  // Largura da linha (coluna + mapa): a coluna cede para o mapa manter um mínimo.
  const [aside, setAside] = useState<HTMLElement | null>(null)
  const [rowW, setRowW] = useState<number | null>(null)
  useEffect(() => {
    const row = aside?.parentElement
    if (!row || typeof ResizeObserver === 'undefined') return
    const measure = () => setRowW(row.clientWidth)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(row)
    return () => ro.disconnect()
  }, [aside])

  // Bastão: a coluna passa para a sucessora. Encerrada sem sucessora, desafixa
  // (não fica uma coluna vazia). Sessão ainda não carregada (boot) não conta
  // como encerrada: a preferência persistida espera o grafo chegar.
  useEffect(() => {
    if (!pinnedId) return
    const dock = useMotherDockStore.getState()
    dock.follow(graph.edges, inUse)
    const after = useMotherDockStore.getState().pinnedId
    const ended = graph.nodes.find((n) => n.sessionId === after)?.status === 'ended'
    if (after === pinnedId && ended) dock.unpin()
  }, [pinnedId, graph, inUse])

  // A lease é da coluna enquanto ela mostra esta PTY.
  const leaseId = live?.id
  useEffect(() => {
    if (!leaseId) return
    useTerminalLease.getState().acquire(leaseId, 'dock')
    return () => useTerminalLease.getState().release(leaseId, 'dock')
  }, [leaseId])

  // O atalho (e o "Fixar") pedem foco no xterm da coluna — uma vez por pedido.
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      if (useMotherDockStore.getState().takeFocus()) focusDockXterm(bodyRef.current)
    })
    return () => cancelAnimationFrame(raf)
  }, [focusNonce])

  // Bastão trocou a PTY da coluna: só devolve o foco se ele estava na coluna
  // (senão puxaria o texto de quem digita em outro cartão para a sucessora).
  // focusin no document: remover o xterm focado não dispara um focusin, então
  // a última posição conhecida do foco sobrevive à troca.
  const hadFocusRef = useRef(false)
  useEffect(() => {
    const onFocusIn = (e: FocusEvent) => {
      hadFocusRef.current = !!bodyRef.current?.contains(e.target as Node)
    }
    document.addEventListener('focusin', onFocusIn)
    return () => document.removeEventListener('focusin', onFocusIn)
  }, [])
  const prevLeaseRef = useRef(leaseId)
  useEffect(() => {
    const changed = prevLeaseRef.current !== undefined && prevLeaseRef.current !== leaseId
    prevLeaseRef.current = leaseId
    if (!changed || !hadFocusRef.current) return
    const raf = requestAnimationFrame(() => focusDockXterm(bodyRef.current))
    return () => cancelAnimationFrame(raf)
  }, [leaseId])

  if (!pinnedId || !live) return null
  const node = graph.nodes.find((n) => n.sessionId === pinnedId)
  const width = fitDockToRow(dragW ?? storedWidth, rowW)
  const ind = node ? indicatorFor(node, live, workingSince.get(node.sessionId) ?? null, null) : null
  const childCount = node?.childCount ?? 0
  const combo = formatCombo(resolveCombo('mother.focus', overrides))

  const startResize = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    const startX = e.clientX
    const startW = width
    const el = e.currentTarget
    el.setPointerCapture(e.pointerId)
    const next = (ev: PointerEvent) =>
      fitDockToRow(clampDockWidth(startW + ev.clientX - startX), rowW)
    const move = (ev: PointerEvent) => setDragW(next(ev))
    const up = (ev: PointerEvent) => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      useMotherDockStore.getState().setWidth(next(ev))
      setDragW(null)
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
  }

  return (
    <aside
      ref={setAside}
      data-testid="mother-dock"
      data-session-id={pinnedId}
      aria-label={`Sessão mãe fixada: ${node ? cardTitle(node) : live.id}`}
      className="pw-rise relative flex h-full shrink-0 flex-col border-r border-[var(--color-border)] bg-[var(--color-surface)]"
      style={{
        width,
        boxShadow:
          'inset 0 3px 0 0 var(--color-accent), 8px 0 28px -18px color-mix(in srgb, var(--color-accent) 60%, transparent)',
      }}
    >
      <header className="flex shrink-0 flex-col gap-1.5 border-b border-[var(--color-border)] px-3 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <span
            data-testid="mother-dock-badge"
            className="inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[12px] font-semibold uppercase tracking-wide"
            style={{ color: 'var(--color-bg)', background: 'var(--color-accent)' }}
            title={`Mãe: lidera ${childCount} ${childCount === 1 ? 'filha' : 'filhas'}`}
          >
            <Icon as={Crown} size={12} />
            MÃE · {childCount}
          </span>
          <span
            data-testid="mother-dock-title"
            className="min-w-0 flex-1 truncate text-[15px] font-semibold text-[var(--color-text)]"
            title={node?.title}
          >
            {node ? cardTitle(node) : live.id}
          </span>
          <DockButton
            testId="mother-dock-center"
            icon={Crosshair}
            title="Mostrar o cartão dela no mapa"
            onClick={() => onCenter(pinnedId)}
          />
          <DockButton
            testId="mother-dock-modal"
            icon={Maximize2}
            title="Abrir na janela grande do mapa"
            onClick={() => onOpenModal(pinnedId)}
          />
          <DockButton
            testId="mother-dock-unpin"
            icon={PinOff}
            title={`Desafixar: volta para o cartão (${combo} foca a mãe)`}
            onClick={() => useMotherDockStore.getState().unpin()}
          />
        </div>
        {ind && (
          <div className="flex min-w-0 items-center gap-2 text-[12px]">
            <span
              className="h-2 w-2 shrink-0 rounded-full"
              style={{ background: TONE_COLOR[ind.tone] }}
            />
            <span className="shrink-0 font-medium" style={{ color: TONE_COLOR[ind.tone] }}>
              {indicatorText(ind, now)}
            </span>
            {(ind.reason ?? ind.step ?? node?.featureTitle) && (
              <span className="min-w-0 truncate text-[var(--color-text-dim)]">
                · {ind.reason ?? ind.step ?? node?.featureTitle}
              </span>
            )}
          </div>
        )}
      </header>
      <div ref={bodyRef} className="relative min-h-0 flex-1" data-testid="mother-dock-terminal">
        <div className="absolute inset-0">
          <Terminal
            session={sessionFromLiveSession(live, null)}
            repoLabel={live.repo?.label ?? 'Avulsa'}
            repoPath={live.repo?.path ?? ''}
            projectName={live.projectName ?? ''}
            projectIcon={live.projectIcon}
            projectColor={live.projectColor}
            mode="terminal"
            chrome="bare"
            leaseHost="dock"
            fontSize={Math.max(DOCK_FONT_PX, prefFontSize)}
            hudStatus={ind ? { label: indicatorText(ind, now), color: TONE_COLOR[ind.tone] } : undefined}
            onClose={() => useMotherDockStore.getState().unpin()}
          />
        </div>
      </div>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Redimensionar a coluna da mãe"
        data-testid="mother-dock-resize"
        onPointerDown={startResize}
        className="absolute inset-y-0 -right-1 z-10 w-2 cursor-col-resize transition hover:bg-[color-mix(in_srgb,var(--color-accent)_35%,transparent)]"
      />
    </aside>
  )
}

function focusDockXterm(body: HTMLElement | null): void {
  body?.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea')?.focus()
}

function DockButton({
  testId,
  icon,
  title,
  onClick,
}: {
  testId: string
  icon: typeof Crown
  title: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onClick}
      title={title}
      aria-label={title}
      className="shrink-0 rounded p-1 text-[var(--color-text-dim)] transition hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text)]"
    >
      <Icon as={icon} size={15} />
    </button>
  )
}
