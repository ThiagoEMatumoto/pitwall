import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { Crosshair, Crown, EyeOff, Maximize2, PanelTop, Pin, PinOff } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import { Terminal } from '@/features/sessions/Terminal'
import { useTerminalLease } from '@/features/sessions/terminal-lease'
import { useTerminalPrefsStore } from '@/lib/terminal-prefs-store'
import { formatCombo, matchCombo, resolveCombo } from '@/lib/keybindings'
import { useKeybindingsStore } from '@/lib/keybindings-store'
import { sessionFromLiveSession, useAppStore } from '@/store/appStore'
import type { SessionGraph } from '../../../shared/types/session-graph'
import { TONE_COLOR, indicatorFor, indicatorText } from './card-indicator'
import { cardTitle } from './card-display'
import { ChildPills } from './ChildPills'
import { useMapLive } from './map-live'
import {
  PANEL_SHARE,
  effectiveMotherId,
  panelWidth,
  shareOfWidth,
  useMotherDockStore,
} from './mother-dock'

// O painel da mãe: a mãe da feature em foco (ou a fixada) num painel grande à
// esquerda do mapa — terminal REAL (o mesmo Terminal da modal, anexado à mesma
// PTY, com o composer dele), fora do transform do ReactFlow, então legível em
// qualquer zoom. Segura a lease 'dock' (terminal-lease): a aba da mãe mostra o
// aviso e, se a modal abrir na mesma sessão, ela fica por cima e devolve a PTY
// ao painel ao fechar. O mapa é um irmão no flex: o enquadrar desconta a largura.
const DOCK_FONT_PX = 14
// Trocar de feature troca a mãe: espera assentar (setas no seletor, cliques
// seguidos) antes de soltar a lease de A e pegar a de B — cada troca remonta o
// xterm e manda um resize para a PTY nova.
const SWITCH_DEBOUNCE_MS = 300

// Abrir e fechar são imediatos; só a troca A→B espera o valor assentar.
function useSettled(value: string | null, ms: number): string | null {
  const [settled, setSettled] = useState(value)
  useEffect(() => {
    if (value === settled) return
    if (value === null || settled === null) {
      setSettled(value)
      return
    }
    const timer = setTimeout(() => setSettled(value), ms)
    return () => clearTimeout(timer)
  }, [value, settled, ms])
  return settled
}

export function MotherDock({
  graph,
  inUse,
  autoId,
  onOpenModal,
  onOpenTab,
  onCenter,
}: {
  graph: SessionGraph
  inUse: ReadonlySet<string>
  // A mãe da feature em foco (SessionMap): o que o painel mostra sem trava.
  autoId: string | null
  onOpenModal: (sessionId: string) => void
  // Sai do mapa para a aba dela em Terminais: desmontar o mapa solta a lease do
  // painel e a aba remonta o xterm (o placeholder da aba fica por baixo do mapa).
  onOpenTab: (sessionId: string) => void
  onCenter: (sessionId: string) => void
}) {
  const pinnedId = useMotherDockStore((s) => s.pinnedId)
  const mode = useMotherDockStore((s) => s.mode)
  const share = useMotherDockStore((s) => s.share)
  const focusNonce = useMotherDockStore((s) => s.focusNonce)
  // Trava numa sessão sem PTY viva (o app reiniciou e ela não voltou): o painel
  // segue a feature em foco em vez de ficar vazio; a trava volta a valer se ela subir.
  const pinnedLive = useAppStore((s) =>
    pinnedId ? s.liveSessions.some((x) => x.id === pinnedId && x.status !== 'ended') : false,
  )
  const targetId = useSettled(
    effectiveMotherId({ pinnedId: pinnedLive ? pinnedId : null, mode, autoId }),
    SWITCH_DEBOUNCE_MS,
  )
  const live = useAppStore((s) =>
    targetId ? s.liveSessions.find((x) => x.id === targetId && x.status !== 'ended') : undefined,
  )
  const prefFontSize = useTerminalPrefsStore((s) => s.fontSize)
  const overrides = useKeybindingsStore((s) => s.overrides)
  const { now, workingSince } = useMapLive()
  // Arrasto do separador: só a guia anda; a largura (e o resize da PTY) muda uma
  // vez, ao soltar.
  const [dragW, setDragW] = useState<number | null>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  // Largura da linha (painel + mapa): o painel cede para o mapa manter um mínimo.
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

  // Quem está no painel agora: o cartão dela diz "está no painel" e o enquadrar
  // a deixa de fora.
  const shownId = live?.id ?? null
  useEffect(() => {
    useMotherDockStore.getState().setShown(shownId)
  }, [shownId])
  useEffect(() => () => useMotherDockStore.getState().setShown(null), [])

  // Mostrar/esconder o painel (mother.togglePanel). Captura: com o foco no xterm
  // o atalho não pode virar um ^P na PTY.
  useEffect(() => {
    const combo = resolveCombo('mother.togglePanel', overrides)
    const onKey = (e: KeyboardEvent) => {
      if (!matchCombo(e, combo)) return
      e.preventDefault()
      e.stopPropagation()
      if (!e.repeat) useMotherDockStore.getState().togglePanel()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [overrides])

  // Bastão: a trava passa para a sucessora. Encerrada sem sucessora, solta (o
  // painel volta a seguir a feature em foco). Sessão ainda não carregada (boot)
  // não conta como encerrada: a preferência persistida espera o grafo chegar.
  useEffect(() => {
    if (!pinnedId) return
    const dock = useMotherDockStore.getState()
    dock.follow(graph.edges, inUse)
    const after = useMotherDockStore.getState().pinnedId
    const ended = graph.nodes.find((n) => n.sessionId === after)?.status === 'ended'
    if (after === pinnedId && ended) dock.unpin()
  }, [pinnedId, graph, inUse])

  // A lease é do painel enquanto ele mostra esta PTY. Na troca A→B o cleanup
  // solta a de A antes de o efeito novo pegar a de B.
  useEffect(() => {
    if (!shownId) return
    useTerminalLease.getState().acquire(shownId, 'dock')
    return () => useTerminalLease.getState().release(shownId, 'dock')
  }, [shownId])

  // Só o atalho (Ctrl+Shift+O) pede foco no xterm do painel — uma vez por pedido.
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      if (useMotherDockStore.getState().takeFocus()) focusDockXterm(bodyRef.current)
    })
    return () => cancelAnimationFrame(raf)
  }, [focusNonce])

  // Bastão trocou a PTY da trava: devolve o foco só se ele estava no painel. A
  // troca por feature em foco NUNCA puxa o foco (digitar na mãe A não pode cair
  // na B). focusin no document: remover o xterm focado não dispara um focusin,
  // então a última posição conhecida do foco sobrevive à troca.
  const hadFocusRef = useRef(false)
  useEffect(() => {
    const onFocusIn = (e: FocusEvent) => {
      hadFocusRef.current = !!bodyRef.current?.contains(e.target as Node)
    }
    document.addEventListener('focusin', onFocusIn)
    return () => document.removeEventListener('focusin', onFocusIn)
  }, [])
  // O debounce separa as duas mudanças: a trava muda já e o painel só 300ms
  // depois. O bastão fica pendente até o painel chegar na sucessora.
  const prevPinnedRef = useRef(pinnedId)
  const batonPendingRef = useRef(false)
  useEffect(() => {
    const prev = prevPinnedRef.current
    prevPinnedRef.current = pinnedId
    if (prev && pinnedId && prev !== pinnedId) batonPendingRef.current = hadFocusRef.current
  }, [pinnedId])
  useEffect(() => {
    if (!batonPendingRef.current || !shownId || shownId !== pinnedId) return
    batonPendingRef.current = false
    // Clicou em outro lugar enquanto esperava: o foco é dele.
    if (!hadFocusRef.current) return
    const raf = requestAnimationFrame(() => focusDockXterm(bodyRef.current))
    return () => cancelAnimationFrame(raf)
  }, [shownId, pinnedId])

  if (!live || !shownId) return null
  const node = graph.nodes.find((n) => n.sessionId === shownId)
  const pinned = pinnedId === shownId
  const width = panelWidth(share, rowW)
  const ind = node ? indicatorFor(node, live, workingSince.get(node.sessionId) ?? null, null) : null
  const childCount = node?.childCount ?? 0
  const focusCombo = formatCombo(resolveCombo('mother.focus', overrides))
  const toggleCombo = formatCombo(resolveCombo('mother.togglePanel', overrides))

  const startResize = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    const startX = e.clientX
    const el = e.currentTarget
    el.setPointerCapture(e.pointerId)
    const next = (ev: PointerEvent) =>
      panelWidth(shareOfWidth(width + ev.clientX - startX, rowW), rowW)
    const move = (ev: PointerEvent) => setDragW(next(ev))
    const up = (ev: PointerEvent) => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      useMotherDockStore.getState().setShare(shareOfWidth(next(ev), rowW))
      setDragW(null)
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
  }

  return (
    <aside
      ref={setAside}
      data-testid="mother-dock"
      data-session-id={shownId}
      data-mode={pinned ? 'pinned' : 'focus'}
      aria-label={`Painel da mãe: ${node ? cardTitle(node) : live.id}`}
      className="pw-rise relative flex h-full shrink-0 flex-col border-r border-[var(--color-border)] bg-[var(--color-surface)]"
      style={{
        width,
        // Sem o translateY(0) que o fill 'both' do pw-rise deixa: nenhum transform
        // acima do xterm depois da entrada (nitidez da fonte).
        animationFillMode: 'backwards',
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
            onClick={() => onCenter(shownId)}
          />
          <DockButton
            testId="mother-dock-modal"
            icon={Maximize2}
            title="Abrir na janela grande do mapa"
            onClick={() => onOpenModal(shownId)}
          />
          <DockButton
            testId="mother-dock-open-tab"
            icon={PanelTop}
            title="Abrir na aba (Terminais)"
            onClick={() => onOpenTab(shownId)}
          />
          <DockButton
            testId={pinned ? 'mother-dock-unpin' : 'mother-dock-pin'}
            icon={pinned ? PinOff : Pin}
            title={
              pinned
                ? 'Soltar: o painel volta a seguir a feature em foco'
                : 'Fixar esta: o painel fica nesta mãe ao trocar de feature'
            }
            onClick={() => {
              const dock = useMotherDockStore.getState()
              if (pinned) dock.unpin()
              else dock.pin(shownId)
            }}
          />
          <DockButton
            testId="mother-dock-hide"
            icon={EyeOff}
            title={`Esconder o painel (${toggleCombo} mostra de novo; ${focusCombo} foca a mãe)`}
            onClick={() => useMotherDockStore.getState().hide()}
          />
        </div>
        <div className="flex min-w-0 items-center gap-2 text-[12px]">
          {ind && (
            <>
              <span
                className="h-2 w-2 shrink-0 rounded-full"
                style={{ background: TONE_COLOR[ind.tone] }}
              />
              <span className="shrink-0 font-medium" style={{ color: TONE_COLOR[ind.tone] }}>
                {indicatorText(ind, now)}
              </span>
            </>
          )}
          <span
            data-testid="mother-dock-mode"
            className="min-w-0 truncate text-[var(--color-text-dim)]"
          >
            · {pinned ? 'fixada' : 'segue a feature em foco'}
            {(ind?.reason ?? ind?.step ?? node?.featureTitle)
              ? ` · ${ind?.reason ?? ind?.step ?? node?.featureTitle}`
              : ''}
          </span>
        </div>
      </header>
      <div ref={bodyRef} className="relative min-h-0 flex-1" data-testid="mother-dock-terminal">
        <div className="absolute inset-0">
          <Terminal
            key={shownId}
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
            hudStatus={
              ind ? { label: indicatorText(ind, now), color: TONE_COLOR[ind.tone] } : undefined
            }
            onClose={() => {
              if (useMotherDockStore.getState().pinnedId === shownId) {
                useMotherDockStore.getState().unpin()
              }
            }}
          />
        </div>
      </div>
      <ChildPills
        graph={graph}
        motherId={shownId}
        inUse={inUse}
        onCenter={onCenter}
        onOpen={onOpenModal}
      />
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Redimensionar o painel da mãe"
        data-testid="mother-dock-resize"
        onPointerDown={startResize}
        // Duplo clique: de volta aos 55% da linha.
        onDoubleClick={() => useMotherDockStore.getState().setShare(PANEL_SHARE)}
        title="Arraste para redimensionar · duplo clique: 55%"
        className={`absolute inset-y-0 -right-1 w-2 cursor-col-resize transition hover:bg-[color-mix(in_srgb,var(--color-accent)_35%,transparent)] ${
          dragW !== null ? 'z-30 bg-[var(--color-accent)]' : 'z-10'
        }`}
        style={dragW !== null ? { transform: `translateX(${dragW - width}px)` } : undefined}
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
