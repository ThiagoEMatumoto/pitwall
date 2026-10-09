import { useEffect, useMemo, useRef, useState } from 'react'
import { useFeatureRoomStore } from '@/features/feature-room/feature-room-store'
import { useRoomPanelStore } from '@/features/feature-room/room-panel-store'
import { markRoomHintSeen, roomHintText, roomHintSeen } from '@/features/feature-room/room-hint'
import { createPortal } from 'react-dom'
import { Crown, Layers } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import { Kbd } from '@/components/ui/ShortcutHints'
import { useCrewDockStore } from '@/features/handoffs/crew-dock-store'
import {
  ensureSessionGraph,
  useSessionGraph,
  useSessionGraphStore,
} from '@/features/sessions/session-graph-store'
import { attentionKeysBlocked } from '@/features/session-switcher/attention-keys'
import { mapSessionIds } from '@/features/session-switcher/useGlobalSessions'
import { formatCombo, matchCombo, resolveCombo, type Combo } from '@/lib/keybindings'
import { pendingEndSessionIds, useAppStore } from '@/store/appStore'
import { useAttentionListStore } from '@/store/attentionStore'
import { useFeaturesStore } from '@/store/featuresStore'
import { openSessionByCc } from '@/features/sessions/open-session'
import { useKeybindingsStore } from '@/lib/keybindings-store'
import { TONE_COLOR } from './card-indicator'
import { tailText } from './card-tail'
import { useCardViewStore } from './card-view-store'
import { useFeaturePanelStore } from './feature-panel-store'
import {
  buildSwitcherEntries,
  isProjectKey,
  leavesScope,
  openIndex,
  stepIndex,
  switcherCurrent,
  switcherKeyLabel,
  switcherKeyNote,
  type SwitcherEntry,
} from './feature-switcher-model'
import { orderByMru, useFeatureMruStore } from './feature-mru-store'
import { useMapFocusStore } from './map-focus-store'
import { useProjectsViewStore } from './projects-view-store'

// Toque rápido (apertar e soltar) não pisca o overlay: ele só aparece se o
// modificador continuar segurado por mais que isto.
const SHOW_DELAY_MS = 120

interface Session {
  keys: string[]
  index: number
  visible: boolean
  // Aberto pelo botão da barra do mapa: não há modificador segurado, então soltar
  // tecla não confirma — só Enter ou o clique numa linha.
  sticky: boolean
  // Quem abriu: pelo botão do mapa, confirmar uma feature fica no mapa (o mapa
  // não muda de comportamento); pelo combo ou pela Room, vai para a Room.
  origin: SwitcherOrigin
  // Primeira abertura pelo combo depois do update: avisa que ele leva à Room.
  roomHint: boolean
}

export type SwitcherOrigin = 'keyboard' | 'map-button' | 'room'

// Soltar o modificador do combo confirma (o "Alt" do Alt+Tab). Combo sem
// modificador (remapeado assim) só confirma com Enter.
function comboHeld(e: KeyboardEvent, c: Combo): boolean {
  if (!c.mod && !c.alt) return true
  return (!c.mod || e.ctrlKey || e.metaKey) && (!c.alt || e.altKey)
}

const isCombo = (e: KeyboardEvent, c: Combo) =>
  matchCombo(e, c) || matchCombo(e, { ...c, shift: true })

// Os listeners de captura entram na janela na CARGA do módulo, antes de qualquer
// efeito de componente: com o seletor aberto eles rodam antes dos outros atalhos
// de captura (painel da mãe, Ctrl+Shift+O do mapa...) e o
// stopImmediatePropagation os cala de fato. Registrados num efeito, ficariam
// depois dos do mapa montado no boot.
let onWindowKeyDown: ((e: KeyboardEvent) => void) | null = null
let onWindowKeyUp: ((e: KeyboardEvent) => void) | null = null
let openFromButton: ((origin: SwitcherOrigin) => void) | null = null
let confirmKey: ((key: string) => void) | null = null
let cancelSwitcher: (() => void) | null = null
if (typeof window !== 'undefined') {
  window.addEventListener('keydown', (e) => onWindowKeyDown?.(e), true)
  window.addEventListener('keyup', (e) => onWindowKeyUp?.(e), true)
}

// As sessões que o mapa desenha (useMapSessionIds). A Room usa a MESMA: com outro
// conjunto o "precisa de você" dela divergiria do card da feature aqui.
export function switcherInUse(
  graph: Parameters<typeof buildSwitcherEntries>[0],
  liveSessions: ReturnType<typeof useAppStore.getState>['liveSessions'],
): Set<string> {
  const graphLive = graph.nodes.filter((n) => n.status !== 'ended').map((n) => n.sessionId)
  return mapSessionIds(liveSessions, graphLive, pendingEndSessionIds())
}

function entriesOf(
  graph: Parameters<typeof buildSwitcherEntries>[0],
  liveSessions: ReturnType<typeof useAppStore.getState>['liveSessions'],
  tails: ReturnType<typeof useCardViewStore.getState>['tails'],
  attention: ReturnType<typeof useAttentionListStore.getState>['items'],
  features: ReturnType<typeof useFeaturesStore.getState>['features'],
): Map<string, SwitcherEntry> {
  const live = new Map(liveSessions.map((s) => [s.id, s]))
  const tailOf = (id: string) => {
    const t = tails[id]
    return t ? tailText(t.lines) : null
  }
  // A mesma regra do mapa (useMapSessionIds): só lista o card que ele desenha.
  const inUse = switcherInUse(graph, liveSessions)
  const titles = new Map(features.map((f) => [f.id, f.title]))
  return new Map(
    buildSwitcherEntries(graph, live, tailOf, inUse, attention, (id) => titles.get(id) ?? null).map(
      (e) => [e.key, e],
    ),
  )
}

// Fechado, o seletor não assina grafo, sessões nem tails (os tails mudam ~50x/s
// com o mapa cheio): a lista é montada só na hora de abrir e de confirmar.
const entriesNow = () =>
  entriesOf(
    useSessionGraphStore.getState().graph,
    useAppStore.getState().liveSessions,
    useCardViewStore.getState().tails,
    useAttentionListStore.getState().items,
    useFeaturesStore.getState().features,
  )

// Seletor rápido de features estilo Alt+Tab (Ctrl+`): um cartão por feature em
// ordem de uso, a feature em foco primeiro. Confirmar uma feature abre a Room
// dela; aberto pelo botão do mapa, leva ao mapa e foca a feature (o mapa enquadra
// o card e o painel troca para a mãe dela).
export function FeatureSwitcher() {
  const overrides = useKeybindingsStore((s) => s.overrides)
  const [session, setSession] = useState<Session | null>(null)
  const sessionRef = useRef<Session | null>(null)
  sessionRef.current = session
  const restoreFocus = useRef<HTMLElement | null>(null)

  useEffect(ensureSessionGraph, [])

  useEffect(() => {
    const combo = resolveCombo('featureSwitcher.open', overrides)
    let showTimer = 0
    // O ref anda junto com o estado: o keyup do toque rápido pode chegar antes do render.
    const update = (fn: (cur: Session | null) => Session | null) => {
      sessionRef.current = fn(sessionRef.current)
      setSession(sessionRef.current)
    }

    const close = (confirm: boolean) => {
      const s = sessionRef.current
      window.clearTimeout(showTimer)
      update(() => null)
      if (!s) return
      const target = confirm ? entriesNow().get(s.keys[s.index]) : undefined
      if (!target) {
        const prev = restoreFocus.current
        if (prev?.isConnected) prev.focus()
        return
      }
      goTo(target, s.origin)
    }

    const open = (backward: boolean, sticky: boolean, origin: SwitcherOrigin) => {
      const order = useFeatureMruStore.getState().order
      const area = useAppStore.getState().area
      const roomState = useFeatureRoomStore.getState()
      const panel = useRoomPanelStore.getState()
      const current = switcherCurrent({
        roomFeature: area === 'room' && roomState.level === 'feature' ? roomState.featureId : null,
        panelFeature: area === 'projects' && panel.open ? panel.featureFilter : null,
        projectsView: useProjectsViewStore.getState().view,
        mruHead: order[0] ?? null,
        mapFocus: useMapFocusStore.getState().featureId,
        isProjectKey,
      })
      const keys = orderByMru([...entriesNow().keys()], order, current, isProjectKey)
      if (keys.length === 0) return false
      // Título da linha de atenção (feature sem card no mapa): o índice de features
      // só é carregado pela área Features; o overlay assina e re-renderiza.
      const features = useFeaturesStore.getState()
      if (features.features.length === 0 && !features.loading) void features.load()
      restoreFocus.current = document.activeElement as HTMLElement | null
      const index = openIndex(keys.length, backward, !!current && keys[0] === current)
      const roomHint = origin === 'keyboard' && !roomHintSeen()
      update(() => ({ keys, index, visible: sticky, sticky, origin, roomHint }))
      return true
    }

    const onKeyDown = (e: KeyboardEvent) => {
      const s = sessionRef.current
      if (!s) {
        if (!isCombo(e, combo)) return
        // Dialog, paleta, composer rápido...: o teclado é deles.
        if (attentionKeysBlocked()) return
        e.preventDefault()
        e.stopImmediatePropagation()
        if (e.repeat) return
        if (!open(e.shiftKey, false, 'keyboard')) return
        showTimer = window.setTimeout(
          () => update((cur) => (cur ? { ...cur, visible: true } : cur)),
          SHOW_DELAY_MS,
        )
        return
      }
      // Aberto: nenhuma tecla chega ao xterm nem aos outros atalhos (este listener
      // é o primeiro de captura da janela, ver onWindowKeyDown).
      e.preventDefault()
      e.stopImmediatePropagation()
      const step = (dir: 1 | -1) =>
        update((cur) =>
          cur ? { ...cur, visible: true, index: stepIndex(cur.index, dir, cur.keys.length) } : cur,
        )
      if (e.key === 'Escape') close(false)
      else if (e.key === 'Enter') close(true)
      else if (e.key === 'Tab' || isCombo(e, combo)) step(e.shiftKey ? -1 : 1)
      else if (e.key === 'ArrowDown' || e.key === 'ArrowRight') step(1)
      else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') step(-1)
    }

    const onKeyUp = (e: KeyboardEvent) => {
      const s = sessionRef.current
      if (!s) return
      e.preventDefault()
      e.stopImmediatePropagation()
      if (!s.sticky && !comboHeld(e, combo)) close(true)
    }
    const onBlur = () => close(false)
    const onButton = (origin: SwitcherOrigin) => {
      if (!sessionRef.current) open(false, true, origin)
    }
    const onPick = (key: string) => {
      const s = sessionRef.current
      if (!s) return
      const index = s.keys.indexOf(key)
      if (index < 0) return
      update(() => ({ ...s, index }))
      close(true)
    }
    const onCancel = () => close(false)

    onWindowKeyDown = onKeyDown
    onWindowKeyUp = onKeyUp
    openFromButton = onButton
    confirmKey = onPick
    cancelSwitcher = onCancel
    window.addEventListener('blur', onBlur)
    return () => {
      window.clearTimeout(showTimer)
      if (onWindowKeyDown === onKeyDown) onWindowKeyDown = null
      if (onWindowKeyUp === onKeyUp) onWindowKeyUp = null
      if (openFromButton === onButton) openFromButton = null
      if (confirmKey === onPick) confirmKey = null
      if (cancelSwitcher === onCancel) cancelSwitcher = null
      window.removeEventListener('blur', onBlur)
    }
  }, [overrides])

  if (!session?.visible) return null
  return (
    <SwitcherOverlay
      keys={session.keys}
      index={session.index}
      sticky={session.sticky}
      roomHint={session.roomHint}
      combo={resolveCombo('featureSwitcher.open', overrides)}
    />
  )
}

// Só montado com o overlay na tela: aí sim acompanha grafo, sessões e tails.
function SwitcherOverlay({
  keys,
  index,
  sticky,
  roomHint,
  combo,
}: {
  keys: string[]
  index: number
  // Aberto pelo botão da barra: soltar tecla não confirma (só Enter ou clique).
  sticky: boolean
  roomHint: boolean
  combo: Combo
}) {
  const graph = useSessionGraph()
  const liveSessions = useAppStore((s) => s.liveSessions)
  const tails = useCardViewStore((s) => s.tails)
  const attention = useAttentionListStore((s) => s.items)
  const features = useFeaturesStore((s) => s.features)
  const entries = useMemo(
    () => entriesOf(graph, liveSessions, tails, attention, features),
    [graph, liveSessions, tails, attention, features],
  )
  const listRef = useRef<HTMLDivElement>(null)

  // O overlay visível tira o foco do xterm: nada digitado vaza pra PTY.
  useEffect(() => {
    listRef.current?.focus()
  }, [])

  // Visto = mostrado: o toque rápido (overlay nem aparece) não gasta a dica.
  useEffect(() => {
    if (roomHint) markRoomHintSeen()
  }, [roomHint])

  const shown = keys.map((k) => entries.get(k)).filter((e): e is SwitcherEntry => !!e)
  const activeKey = keys[index]
  // Do combo de verdade (editável) e com o rótulo da tecla no layout de quem usa.
  const modLabel = formatCombo({ mod: combo.mod, alt: combo.alt })
  const keyLabel = switcherKeyLabel(combo)
  const keyNote = switcherKeyNote(combo)
  // Teclas em <Kbd>: o ` do Backquote sumia solto no meio do texto.
  const hint = (
    <>
      {sticky ? (
        <>
          <Kbd>Enter</Kbd> ou clique abre
        </>
      ) : modLabel ? (
        <>
          Solte o <Kbd>{modLabel}</Kbd> para abrir
        </>
      ) : (
        <>
          <Kbd>Enter</Kbd> abre
        </>
      )}
      {' · '}
      <Kbd>{keyLabel}</Kbd>
      {keyNote && <span className="text-[var(--color-text-dim)]"> ({keyNote})</span>} ou{' '}
      <Kbd>Tab</Kbd> avança · <Kbd>Shift</Kbd> volta · <Kbd>Esc</Kbd> cancela
    </>
  )

  // Portal + z acima de 1000: por cima dos sashes/overlays do dockview (99/999) e
  // da espiada/composer (z-[1000]); senão ele abriria por baixo engolindo as teclas.
  // O backdrop escurece o app inteiro e o clique nele cancela.
  return createPortal(
    <div
      data-modal-overlay
      className="fixed inset-0 z-[1100] flex items-center justify-center p-4"
      data-testid="feature-switcher"
    >
      <div
        aria-hidden
        data-testid="feature-switcher-backdrop"
        className="absolute inset-0 bg-black/60 backdrop-blur-[3px]"
        // Sem o preventDefault, o default do mousedown leva o foco ao <body> logo
        // depois de o cancelar devolvê-lo ao xterm/campo de onde o seletor abriu.
        onMouseDown={(e) => {
          e.preventDefault()
          cancelSwitcher?.()
        }}
      />
      {/* A dica fica fora da rolagem: com muitas features ela sumia no fim da lista. */}
      <div className="relative flex w-[36rem] max-w-full flex-col overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] shadow-2xl">
        <div
          data-testid="feature-switcher-hint"
          className="shrink-0 border-b border-[var(--color-border)] px-3 py-2 text-[11px] text-[var(--color-text-dim)]"
        >
          {hint}
        </div>
        {roomHint && (
          <div
            data-testid="feature-switcher-room-hint"
            className="shrink-0 border-b border-[var(--color-border)] bg-[var(--color-accent)]/10 px-3 py-1.5 text-[11px] text-[var(--color-text)]"
          >
            {roomHintText([modLabel, keyLabel].filter(Boolean).join('+'))}
          </div>
        )}
        <div
          ref={listRef}
          role="listbox"
          aria-label="Trocar de feature"
          aria-activedescendant={activeKey ? optionId(activeKey) : undefined}
          tabIndex={-1}
          // 8 linhas à vista (estilo Alt+Tab): o resto rola, e a ativa entra na vista.
          className="flex flex-col gap-0.5 overflow-y-auto p-1.5 outline-none"
          style={{ maxHeight: `calc(${VISIBLE_ROWS} * ${ROW_REM}rem + 0.75rem)` }}
        >
          {shown.map((entry) => (
            <SwitcherOption key={entry.key} entry={entry} active={entry.key === activeKey} />
          ))}
        </div>
      </div>
    </div>,
    document.body,
  )
}

const VISIBLE_ROWS = 8
const ROW_REM = 2.125

const optionId = (key: string) => `feature-switcher-opt-${key}`

// Uma linha por card: título, pulso truncado, mãe com o tom dela e os contadores.
function SwitcherOption({ entry, active }: { entry: SwitcherEntry; active: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: 'nearest' })
  }, [active])
  const tooltip = [entry.title, entry.pulse, entry.motherTitle && `mãe: ${entry.motherTitle}`]
    .filter(Boolean)
    .join(' — ')
  return (
    <div
      ref={ref}
      id={optionId(entry.key)}
      role="option"
      aria-selected={active}
      data-key={entry.key}
      data-kind={entry.kind}
      title={tooltip}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => confirmKey?.(entry.key)}
      className={`flex shrink-0 cursor-pointer items-center gap-2 rounded-md border px-2.5 text-[12px] ${
        active
          ? 'border-[var(--color-accent)] bg-[var(--color-accent)]/15'
          : 'border-transparent hover:bg-[var(--color-surface-2)]'
      }`}
      style={{ height: `${ROW_REM}rem` }}
    >
      <span
        className={`max-w-[45%] shrink-0 truncate font-medium ${
          entry.kind === 'project' ? 'text-[var(--color-text-dim)]' : 'text-[var(--color-text)]'
        }`}
      >
        {entry.title}
      </span>
      <span
        className="min-w-0 flex-1 truncate text-[11px] text-[var(--color-text-dim)]"
        data-testid="feature-switcher-pulse"
      >
        {entry.pulse}
      </span>
      {entry.motherId && (
        <span
          className="flex max-w-[30%] shrink-0 items-center gap-1 text-[11px] text-[var(--color-text-dim)]"
          data-testid="feature-switcher-mother"
        >
          <Icon as={Crown} size={11} />
          <span className="truncate">{entry.motherTitle}</span>
          {entry.motherTone && (
            <span
              aria-hidden
              className="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
              style={{ background: TONE_COLOR[entry.motherTone] }}
            />
          )}
        </span>
      )}
      {/* Só o que tem: "0 trabalhando · 0 precisa de você" em toda linha era ruído. */}
      {entry.working > 0 && (
        <span
          className="shrink-0 tabular-nums text-[11px] text-[var(--color-text-dim)]"
          title={`${entry.working} trabalhando`}
          data-testid="feature-switcher-working"
        >
          <span style={{ color: TONE_COLOR.working }}>●</span> {entry.working}
        </span>
      )}
      {entry.needsYou > 0 && (
        <span
          className="shrink-0 rounded-full px-1.5 text-[10px] font-semibold tabular-nums text-[var(--color-bg)]"
          style={{ background: TONE_COLOR['needs-you'] }}
          title={`${entry.needsYou} precisa de você`}
          data-testid="feature-switcher-attention"
        >
          {entry.needsYou} precisa de você
        </span>
      )}
    </div>
  )
}

// Onde o usuário descobre o atalho: a barra do mapa. Clicar abre o seletor sem
// modificador segurado (Enter ou clique confirma).
const BUTTON_CLASS =
  'pointer-events-auto flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1.5 text-[12px] text-[var(--color-text-dim)] shadow-lg transition hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text)]'

export function FeatureSwitcherButton({ className = BUTTON_CLASS }: { className?: string }) {
  const overrides = useKeybindingsStore((s) => s.overrides)
  const combo = resolveCombo('featureSwitcher.open', overrides)
  const mod = formatCombo({ mod: combo.mod, alt: combo.alt, shift: combo.shift })
  const shortcut = [mod, switcherKeyLabel(combo)].filter(Boolean).join('+')
  const note = switcherKeyNote(combo)
  const label = `Trocar feature (${shortcut}${note ? `, ${note}` : ''})`
  return (
    <button
      type="button"
      data-testid="map-feature-switcher"
      onClick={() => openFromButton?.('map-button')}
      title={label}
      aria-label={label}
      className={className}
    >
      <Icon as={Layers} size={13} />
      <span className="@max-3xl:hidden">Trocar feature</span>
      <Kbd>{shortcut}</Kbd>
    </button>
  )
}

// O botão "Features" do cabeçalho da Room: o mesmo seletor, confirmando para a Room.
export function openFeatureSwitcher(): void {
  openFromButton?.('room')
}

// Card de feature (fora do botão do mapa) abre a Room. O resto segue para o mapa.
function goTo(target: SwitcherEntry, origin: SwitcherOrigin) {
  const dock = useCrewDockStore.getState()
  // Card de atenção não tem card no mapa para enquadrar: abre o sujeito direto,
  // como o HUD (quick look da filha, senão a aba da sessão).
  if (target.kind === 'attention') {
    if (target.handoffId) {
      dock.openPeek(target.handoffId)
      return
    }
    const live = useAppStore.getState().liveSessions.find((s) => s.id === target.sessionId)
    if (live?.ccSessionId) {
      openSessionByCc(live.ccSessionId)
      return
    }
    if (!target.featureId) return
  }
  if (target.kind === 'feature' && target.featureId && origin !== 'map-button') {
    useFeatureMruStore.getState().touch(target.key)
    if (dock.peekTarget) dock.closePeek({ restoreFocus: false })
    // Destino padrão: a visão de projeto com o painel da Room filtrado na feature
    // e a pane da mãe dela em foco.
    useRoomPanelStore.getState().show({ featureId: target.featureId })
    return
  }
  showFeatureOnMap(target)
}

// Fora do mapa, confirmar leva até ele. Feature: o mapa enquadra o card e o
// painel troca de mãe (map-focus-store). "Sem feature": só enquadra o grupo (não
// há mãe de feature a seguir; o painel fica como está). O foco fica no mapa,
// nunca no xterm. O que estava na frente de outra feature sai: a espiada, e o
// painel da feature (ao montar, o mapa poria a feature dele em foco).
export function showFeatureOnMap(
  target: Pick<SwitcherEntry, 'key' | 'featureId' | 'laneFlowId' | 'projectIds'>,
) {
  const dock = useCrewDockStore.getState()
  useFeatureMruStore.getState().touch(target.key)
  if (dock.peekTarget) dock.closePeek({ restoreFocus: false })
  const panel = useFeaturePanelStore.getState()
  if (panel.openFeatureId && panel.openFeatureId !== target.featureId) panel.close()
  useAppStore.getState().setArea('projects')
  const view = useProjectsViewStore.getState()
  view.setView('map')
  // No escopo de outro projeto o card não está no mapa: abre para "Todos".
  const { activeProjectId } = useAppStore.getState()
  if (view.scopeMode === 'project' && leavesScope(target, activeProjectId)) view.setScopeMode('all')
  if (target.featureId) useMapFocusStore.getState().focusFeature(target.featureId)
  else useMapFocusStore.getState().frameLane(target.laneFlowId)
  const active = document.activeElement as HTMLElement | null
  if (active?.closest('.xterm')) active.blur()
  requestAnimationFrame(() => {
    document.querySelector<HTMLElement>('[data-testid="session-map"]')?.focus()
  })
}
