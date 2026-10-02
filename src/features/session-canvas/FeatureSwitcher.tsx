import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Crown } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import { Kbd } from '@/components/ui/ShortcutHints'
import { useCrewDockStore } from '@/features/handoffs/crew-dock-store'
import {
  ensureSessionGraph,
  useSessionGraph,
  useSessionGraphStore,
} from '@/features/sessions/session-graph-store'
import { attentionKeysBlocked } from '@/features/session-switcher/attention-keys'
import { formatCombo, matchCombo, resolveCombo, type Combo } from '@/lib/keybindings'
import { useAppStore } from '@/store/appStore'
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
}

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
if (typeof window !== 'undefined') {
  window.addEventListener('keydown', (e) => onWindowKeyDown?.(e), true)
  window.addEventListener('keyup', (e) => onWindowKeyUp?.(e), true)
}

function entriesOf(
  graph: Parameters<typeof buildSwitcherEntries>[0],
  liveSessions: ReturnType<typeof useAppStore.getState>['liveSessions'],
  tails: ReturnType<typeof useCardViewStore.getState>['tails'],
): Map<string, SwitcherEntry> {
  const live = new Map(liveSessions.map((s) => [s.id, s]))
  const tailOf = (id: string) => {
    const t = tails[id]
    return t ? tailText(t.lines) : null
  }
  return new Map(buildSwitcherEntries(graph, live, tailOf).map((e) => [e.key, e]))
}

// Fechado, o seletor não assina grafo, sessões nem tails (os tails mudam ~50x/s
// com o mapa cheio): a lista é montada só na hora de abrir e de confirmar.
const entriesNow = () =>
  entriesOf(
    useSessionGraphStore.getState().graph,
    useAppStore.getState().liveSessions,
    useCardViewStore.getState().tails,
  )

// Seletor rápido de features estilo Alt+Tab (Ctrl+`): um cartão por feature em
// ordem de uso, a feature em foco primeiro. Confirmar leva ao mapa e foca a
// feature (o mapa enquadra o card e o painel troca para a mãe dela).
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
      goTo(target)
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
        // O atual: o grupo "Sem feature" recém-escolhido (ele não muda a feature
        // em foco), senão a feature em foco.
        const order = useFeatureMruStore.getState().order
        const current =
          order[0] && isProjectKey(order[0]) ? order[0] : useMapFocusStore.getState().featureId
        const keys = orderByMru([...entriesNow().keys()], order, current, isProjectKey)
        if (keys.length === 0) return
        restoreFocus.current = document.activeElement as HTMLElement | null
        const index = openIndex(keys.length, e.shiftKey, !!current && keys[0] === current)
        update(() => ({ keys, index, visible: false }))
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
      if (!sessionRef.current) return
      e.preventDefault()
      e.stopImmediatePropagation()
      if (!comboHeld(e, combo)) close(true)
    }
    const onBlur = () => close(false)

    onWindowKeyDown = onKeyDown
    onWindowKeyUp = onKeyUp
    window.addEventListener('blur', onBlur)
    return () => {
      window.clearTimeout(showTimer)
      if (onWindowKeyDown === onKeyDown) onWindowKeyDown = null
      if (onWindowKeyUp === onKeyUp) onWindowKeyUp = null
      window.removeEventListener('blur', onBlur)
    }
  }, [overrides])

  if (!session?.visible) return null
  return (
    <SwitcherOverlay
      keys={session.keys}
      index={session.index}
      combo={resolveCombo('featureSwitcher.open', overrides)}
    />
  )
}

// Só montado com o overlay na tela: aí sim acompanha grafo, sessões e tails.
function SwitcherOverlay({ keys, index, combo }: { keys: string[]; index: number; combo: Combo }) {
  const graph = useSessionGraph()
  const liveSessions = useAppStore((s) => s.liveSessions)
  const tails = useCardViewStore((s) => s.tails)
  const entries = useMemo(() => entriesOf(graph, liveSessions, tails), [graph, liveSessions, tails])
  const listRef = useRef<HTMLDivElement>(null)

  // O overlay visível tira o foco do xterm: nada digitado vaza pra PTY.
  useEffect(() => {
    listRef.current?.focus()
  }, [])

  const shown = keys.map((k) => entries.get(k)).filter((e): e is SwitcherEntry => !!e)
  const activeKey = keys[index]
  // Do combo de verdade (editável) e com o rótulo da tecla no layout de quem usa.
  const modLabel = formatCombo({ mod: combo.mod, alt: combo.alt })
  const keyLabel = formatCombo({ code: combo.code, key: combo.key })
  // Teclas em <Kbd>: o ' do Backquote no ABNT2 sumia solto no meio do texto.
  const hint = (
    <>
      {modLabel ? (
        <>
          Solte o <Kbd>{modLabel}</Kbd> para abrir
        </>
      ) : (
        <>
          <Kbd>Enter</Kbd> abre
        </>
      )}
      {' · '}
      <Kbd>{keyLabel}</Kbd> ou <Kbd>Tab</Kbd> avança · <Kbd>Shift</Kbd> volta · <Kbd>Esc</Kbd>{' '}
      cancela
    </>
  )

  // Portal + z acima de 1000: por cima dos sashes/overlays do dockview (99/999) e
  // da espiada/composer (z-[1000]); senão ele abriria por baixo engolindo as teclas.
  return createPortal(
    <div
      data-modal-overlay
      className="fixed inset-0 z-[1100] flex items-center justify-center bg-black/60 backdrop-blur-[3px]"
      data-testid="feature-switcher"
    >
      {/* A dica fica fora da rolagem: com muitas features ela sumia no fim da lista. */}
      <div className="flex max-h-[70vh] w-[44rem] max-w-[90vw] flex-col overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] shadow-2xl">
        <div className="shrink-0 border-b border-[var(--color-border)] px-4 py-2 text-[11px] text-[var(--color-text-dim)]">
          {hint}
        </div>
        <div
          ref={listRef}
          role="listbox"
          aria-label="Trocar de feature"
          aria-activedescendant={activeKey ? optionId(activeKey) : undefined}
          tabIndex={-1}
          className="flex min-h-0 flex-col gap-1 overflow-y-auto p-2 outline-none"
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

const optionId = (key: string) => `feature-switcher-opt-${key}`

function SwitcherOption({ entry, active }: { entry: SwitcherEntry; active: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: 'nearest' })
  }, [active])
  return (
    <div
      ref={ref}
      id={optionId(entry.key)}
      role="option"
      aria-selected={active}
      data-key={entry.key}
      className={`flex flex-col gap-0.5 rounded-md border px-3 py-2 ${
        active ? 'border-[var(--color-accent)] bg-[var(--color-accent)]/15' : 'border-transparent'
      }`}
    >
      <div className="flex items-center gap-2">
        <span
          className={`min-w-0 flex-1 truncate text-sm font-medium ${
            entry.kind === 'project' ? 'text-[var(--color-text-dim)]' : 'text-[var(--color-text)]'
          }`}
        >
          {entry.title}
        </span>
        {entry.needsYou > 0 && (
          <span
            className="rounded-full px-1.5 text-[10px] font-semibold text-[var(--color-bg)]"
            style={{ background: TONE_COLOR['needs-you'] }}
            data-testid="feature-switcher-attention"
          >
            precisa de você
          </span>
        )}
      </div>
      {entry.pulse && (
        <div className="truncate text-xs text-[var(--color-text-dim)]">{entry.pulse}</div>
      )}
      <div className="flex items-center gap-3 text-[11px] text-[var(--color-text-dim)]">
        {entry.motherId && (
          <span className="flex min-w-0 items-center gap-1" data-testid="feature-switcher-mother">
            <Icon as={Crown} size={12} />
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
        {entry.working > 0 && <span className="ml-auto shrink-0">{entry.working} trabalhando</span>}
      </div>
    </div>
  )
}

// Fora do mapa, confirmar leva até ele. Feature: o mapa enquadra o card e o
// painel troca de mãe (map-focus-store). "Sem feature": só enquadra o grupo (não
// há mãe de feature a seguir; o painel fica como está). O foco fica no mapa,
// nunca no xterm. O que estava na frente de outra feature sai: a espiada, e o
// painel da feature (ao montar, o mapa poria a feature dele em foco).
function goTo(target: SwitcherEntry) {
  useFeatureMruStore.getState().touch(target.key)
  const dock = useCrewDockStore.getState()
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
