import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { CornerDownLeft, Crown, CornerDownRight, ExternalLink, MessageSquare, Repeat, SquareTerminal, Target, X } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import { ShortcutHints } from '@/components/ui/ShortcutHints'
import { hintText, type ShortcutHint } from '@/components/ui/shortcut-hints'
import { ChatView } from '@/features/sessions/chat/ChatView'
import { Terminal } from '@/features/sessions/Terminal'
import { handoffsApi } from '@/lib/ipc'
import { matchCombo, resolveCombo } from '@/lib/keybindings'
import { useKeybindingsStore } from '@/lib/keybindings-store'
import { useTerminalPrefsStore } from '@/lib/terminal-prefs-store'
import { useTerminalLease } from '@/features/sessions/terminal-lease'
import { stepLift } from '@/features/session-canvas/card-view'
import { useProjectsViewStore } from '@/features/session-canvas/projects-view-store'
import { canPassBaton } from '@/features/session-canvas/useMapCommands'
import { useSessionGraphStore } from '@/features/sessions/session-graph-store'
import { BatonDialog } from '@/features/sessions/BatonDialog'
import { peekRole, peekRoleLabel, stripOrder, type PeekRole } from './peek-identity'
import { sessionFromLiveSession, useAppStore } from '@/store/appStore'
import { useHandoffsStore } from '@/store/handoffsStore'
import {
  STATUS_COLOR,
  STATUS_LABEL,
  SUCCESSOR_PENDING_BADGE,
  StatusBadge,
  childIdentity,
  contextLabel,
  liveActivityLabel,
  liveBadgeFor,
} from './HandoffCard'
import {
  crewNeedsAttention,
  crewResumedAfterQuestion,
  crewTerminalTarget,
  splitAlias,
} from './crew'
import { useCrewDockStore, type CrewPeekMode, type PeekOrigin } from './crew-dock-store'
import { openMapPeek } from './open-map-peek'
import type { Handoff, LiveSessionInfo } from '../../../shared/types/ipc'
import { CLAUDE_ONLY_REASON, providerSupports } from '../../../shared/agent-providers'

// Quick look de uma sessão-filha: abre por cima de tudo, mostra a filha —
// conversa renderizada ou terminal cru —, deixa responder, e some. O degrau do
// meio entre "ver o dot piscar" e "abrir a aba" — olhar e desbloquear em
// segundos SEM mexer no layout de trabalho (nenhuma pane nasce, o dockview segue
// montado por trás).
//
// Montado como irmão de <main> no AppShell, no mesmo padrão do SessionSwitcher
// (fixed + backdrop + `if (!open) return null`), e não pelo Dialog.tsx — que
// trava max-h-[85vh] sem parametrização e o peek quer a altura toda.
//
// Custo de GPU: zero em chat (o ChatView lê o transcript JSONL por IPC e não
// importa xterm/WebGL). Em terminal, UM contexto dos 8 do cap enquanto a janela
// está aberta — o Terminal solta no unmount (detachWebgl no cleanup do mount
// effect), e fechar o overlay desmonta.
//
// Encerrar a sessão NÃO existe aqui, de propósito: o terminal entra com
// chrome="bare" (sem SessionHeader). Num fluxo de "só vou dar uma olhada", um
// botão de desligar ao alcance do clique é acidente esperando acontecer — quem
// quer de fato trabalhar na filha usa "abrir como aba", no rodapé.
//
// Aberto pelo mapa (origin 'map') vira o LIFT: painel até 1400px × 90vh sobre o
// mapa esmaecido, xterm em 14px e a faixa de troca entre as sessões do mesmo
// agrupamento (Alt+, / Alt+.). A vista e a câmera do mapa não mudam; navegar
// para a aba é só pelo "Abrir na aba". Em terminal, a modal ASSUME a PTY
// (terminal-lease): a aba da mesma sessão desmonta o xterm enquanto ela estiver
// aberta, então não há dois xterms brigando pelo resize.

// Fonte mínima do xterm no lift: o motivo de abrir a modal é LER o terminal.
const LIFT_FONT_PX = 14

// Focáveis do overlay, pro trap do Tab. Consultado NA HORA de cada Tab: o corpo
// do peek é o ChatView, que ganha e perde botões a cada mensagem — uma lista
// congelada na montagem apontaria pra nós que já saíram do DOM.
const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'

// Tab e Shift+Tab circulam DENTRO do overlay. Sem isto, um Tab a partir do peek
// já sai dele e chega aos botões de janela do Electron — um "modal" que não
// contém o teclado não é modal. Só as BORDAS são interceptadas (primeiro e
// último focáveis); no meio, o Tab é o nativo do navegador. Não toca em Escape
// nem no foco de desmontagem: fechar e devolver o foco ao card do dock continua
// sendo dos handlers de sempre.
function trapTab(e: React.KeyboardEvent<HTMLDivElement>): void {
  if (e.key !== 'Tab') return
  // Em modo terminal o teclado é da filha: Tab e Shift+Tab são teclas da TUI
  // (Shift+Tab cicla o modo de permissão). Mover o foco por baixo dela quebraria
  // justamente o que se veio fazer aqui.
  if (e.currentTarget.dataset.peekMode === 'terminal') return
  const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>(FOCUSABLE))
  const first = items[0]
  const last = items[items.length - 1]
  const onPanel = document.activeElement === e.currentTarget
  if (e.shiftKey && (document.activeElement === first || onPanel)) {
    e.preventDefault()
    last.focus()
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault()
    first.focus()
  }
}

// Camada aberta POR CIMA da modal (paleta Ctrl+K, seletor, compositor): o foco
// está num campo fora do painel. O Esc é dela — com o listener em captura, a
// modal fechava e a paleta ficava aberta.
export function escBelongsToUpperLayer(dialog: HTMLElement | null, active: Element | null): boolean {
  if (!dialog || !active || active === document.body) return false
  if (dialog.contains(active)) return false
  return active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement || active.closest('[role="dialog"], [aria-modal="true"]') !== null
}

export function CrewPeek() {
  const target = useCrewDockStore((s) => s.peekTarget)
  const peekMode = useCrewDockStore((s) => s.peekMode)
  const closePeek = useCrewDockStore((s) => s.closePeek)
  const handoffs = useHandoffsStore((s) => s.handoffs)
  const origin = useCrewDockStore((s) => s.peekOrigin)
  const siblings = useCrewDockStore((s) => s.peekSiblings)
  const liveSessions = useAppStore((s) => s.liveSessions)

  const handoff =
    target?.kind === 'handoff' ? (handoffs.find((h) => h.id === target.id) ?? null) : null
  const liveId = target?.kind === 'session' ? target.id : handoff?.childSessionId
  const live = liveId ? (liveSessions.find((s) => s.id === liveId) ?? null) : null

  // Fecha sozinho se o alvo sumiu enquanto o overlay estava aberto — o handoff
  // saiu da lista (concluiu, falhou) ou a sessão avulsa terminou. Melhor que
  // deixar um painel órfão na tela.
  const gone = target?.kind === 'handoff' ? !handoff : target?.kind === 'session' && !live
  useEffect(() => {
    if (gone) closePeek()
  }, [gone, closePeek])

  // Quem estava focado quando o peek abriu (o card do dock, o cartão do mapa, ou
  // o botão clicado). Vive aqui, e não no painel, porque trocar de sessão pela
  // faixa remonta o painel: a origem é a da abertura, não a do último painel.
  // Layout effect: roda antes do foco que o painel agenda no mount.
  // Fechar sem restaurar (pulo da fila de atenção, "Abrir na aba") deixa o foco
  // com quem o levou.
  const open = !!target
  useEffect(() => {
    if (!open) releaseModalLeases()
  }, [open])
  const originRef = useRef<HTMLElement | null>(null)
  useLayoutEffect(() => {
    if (!open) return
    const active = document.activeElement
    originRef.current = active instanceof HTMLElement ? active : null
    return () => {
      if (!useCrewDockStore.getState().peekRestoreFocus) return
      const el = originRef.current
      requestAnimationFrame(() => {
        // preventScroll: o lift devolve o foco ao cartão com a câmera intacta.
        if (el?.isConnected) el.focus({ preventScroll: true })
      })
    }
  }, [open])

  // A entrada (pw-rise) é da abertura: trocar de sessão pela faixa remonta o
  // painel, e repetir o fade a cada Alt+. deixava o mapa vazar por trás.
  const targetKey = target ? `${target.kind}:${target.id}` : null
  const openedKeyRef = useRef<string | null>(null)
  if (!targetKey) openedKeyRef.current = null
  else if (openedKeyRef.current === null) openedKeyRef.current = targetKey

  if (!target || gone) return null
  // key: trocar de alvo remonta o painel (e o ChatView), zerando o transcript
  // assinado e o texto meio digitado do anterior.
  return (
    <CrewPeekPanel
      key={targetKey}
      animateIn={targetKey === openedKeyRef.current}
      handoff={handoff}
      live={live}
      // Sem Chat View no provider (Codex): o peek abre direto no terminal.
      mode={providerSupports(live?.provider).chatView ? peekMode : 'terminal'}
      origin={origin}
      siblings={siblings}
      onClose={closePeek}
    />
  )
}

// Fechou a modal: toda PTY que ela segurou (a atual e as visitadas pela faixa)
// volta pra aba, que remonta e refaz a tela pelo replay.
function releaseModalLeases() {
  const { leases, release } = useTerminalLease.getState()
  for (const [id, host] of Object.entries(leases)) {
    if (host === 'modal') release(id, 'modal')
  }
}

interface PanelProps {
  // null = peek de sessão avulsa (sem handoff): sem briefing, sem pergunta, e a
  // resposta vai pelo terminal da própria sessão.
  handoff: Handoff | null
  live: LiveSessionInfo | null
  mode: CrewPeekMode
  origin: PeekOrigin
  siblings: string[]
  onClose: (opts?: { restoreFocus?: boolean }) => void
  animateIn: boolean
}

function CrewPeekPanel({ handoff, live, mode, origin, siblings, onClose, animateIn }: PanelProps) {
  const focusOrOpenSession = useAppStore((s) => s.focusOrOpenSession)
  const liveSessions = useAppStore((s) => s.liveSessions)
  const prefFontSize = useTerminalPrefsStore((s) => s.fontSize)
  const setPeekMode = useCrewDockStore((s) => s.setPeekMode)
  const lift = origin === 'map'
  const load = useHandoffsStore((s) => s.load)
  const [message, setMessage] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showBriefing, setShowBriefing] = useState(false)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  // Corpo do overlay (chat ou terminal). Delimita de quem é o Escape: dentro do
  // terminal ele pertence à filha — ver o handler abaixo.
  const bodyRef = useRef<HTMLDivElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    // rAF: mesmo padrão do refocus do Composer — foca depois do paint. Em modo
    // terminal quem toma o foco é o xterm (effect do próprio Terminal): digitar
    // na TUI é o motivo de se estar ali.
    // Peek de sessão (sem handoff) não tem campo de resposta: o foco entra no
    // painel, senão fica atrás do backdrop e o trap do Tab nunca roda.
    requestAnimationFrame(() => {
      if (inputRef.current) inputRef.current.focus()
      else if (useCrewDockStore.getState().peekMode === 'chat') dialogRef.current?.focus()
    })
  }, [])

  // A modal em terminal assume a PTY: enquanto ela segura a lease, a aba da mesma
  // sessão desmonta o xterm (placeholder "Aberto no mapa") e não manda resize.
  // Só quando o terminal mora AQUI (crewTerminalTarget = 'modal'): pelo dock, com
  // aba aberta, o terminal da filha é a aba — inclusive no provider sem Chat View,
  // que abre o peek já em modo terminal. Nesse caso o peek leva até a aba.
  const panes = useAppStore((s) => s.panes)
  const terminalHere = mode === 'terminal' && crewTerminalTarget(live, panes, origin) === 'modal'
  const leaseId = terminalHere ? live?.id : undefined
  const sendToTab = mode === 'terminal' && crewTerminalTarget(live, panes, origin) === 'pane'
  useEffect(() => {
    if (sendToTab) promoteToTab()
    // Só na abertura: depois disso a aba já é a dona.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  // A lease volta pra aba quando a modal FECHA (ver releaseModalLeases), ou quando
  // este painel deixa o modo terminal. Trocar de sessão pela faixa remonta o
  // painel mas não devolve a PTY: cada passo do Alt+./Alt+, remontaria um xterm
  // (replay, fit, resize, contexto WebGL) numa aba que ninguém está vendo.
  useEffect(() => {
    if (!leaseId) return
    useTerminalLease.getState().acquire(leaseId, 'modal')
    return () => {
      const next = useCrewDockStore.getState().peekTarget
      const nextSession =
        next?.kind === 'handoff'
          ? useHandoffsStore.getState().handoffs.find((h) => h.id === next.id)?.childSessionId
          : next?.id
      const switching = next !== null && nextSession !== leaseId
      if (!switching || useCrewDockStore.getState().peekMode !== 'terminal') {
        useTerminalLease.getState().release(leaseId, 'modal')
      }
    }
  }, [leaseId])

  // Faixa de troca do lift: só as irmãs ainda vivas. Alt+, / Alt+. andam por ela
  // (os mesmos atalhos das relações; o AppShell cede a tecla com o lift aberto).
  const graphNodes = useSessionGraphStore((s) => s.graph.nodes)
  const roleOf = (id: string): PeekRole => peekRole(graphNodes.find((n) => n.sessionId === id))
  const strip = lift
    ? stripOrder(
        siblings.filter((id) => liveSessions.some((s) => s.id === id && s.status !== 'ended')),
        roleOf,
      )
    : []
  const graphNode = live ? graphNodes.find((n) => n.sessionId === live.id) : undefined
  const role = peekRole(graphNode)
  const roleLabel = peekRoleLabel(role)
  const [batonOpen, setBatonOpen] = useState(false)
  const currentId = live?.id ?? null
  useEffect(() => {
    if (strip.length < 2 || !currentId) return
    const onKey = (e: KeyboardEvent) => {
      const kb = useKeybindingsStore.getState().overrides
      const delta = matchCombo(e, resolveCombo('session.linkNext', kb))
        ? 1
        : matchCombo(e, resolveCombo('session.linkPrev', kb))
          ? -1
          : 0
      if (!delta) return
      e.preventDefault()
      e.stopPropagation()
      if (e.repeat) return
      switchTo(stepLift(strip, currentId, delta))
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [strip.join('|'), currentId, mode])

  function switchTo(sessionId: string) {
    if (sessionId === currentId) return
    openMapPeek(sessionId, mode, siblings)
  }

  // Esc fecha de qualquer lugar do overlay (inclusive de dentro do textarea).
  // Listener de janela em capture porque o peek é a camada de cima: nenhum outro
  // handler de Esc deve ver esta tecla antes.
  //
  // EXCEÇÃO em modo terminal: com o foco no corpo, o Esc é da filha (cancelar na
  // TUI, sair de menu). Roubá-lo faria do terminal do overlay um terminal pela
  // metade. A saída pelo teclado vira Shift+Esc — anunciada no rodapé.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      // O diálogo do bastão é montado dentro do painel: o Esc é dele.
      if (batonOpen) return
      if (escBelongsToUpperLayer(dialogRef.current, document.activeElement)) return
      if (mode === 'terminal' && !e.shiftKey && bodyRef.current?.contains(document.activeElement)) {
        return
      }
      e.preventDefault()
      e.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose, mode, batonOpen])

  const titleId = useId()
  // Bastão de uma filha: a sucessora pode ainda não estar em liveSessions.
  // Mesma identidade do card (childIdentity), senão o header e o HUD diziam
  // "filha encerrou" no meio de uma troca que deu certo.
  const identity = handoff ? childIdentity(handoff, liveSessions) : null
  const alias = splitAlias(live?.title ?? identity?.title)
  const repoLabel = handoff
    ? (handoff.targetRepoLabel ?? handoff.targetRepoId)
    : (live?.repo?.label ?? 'Avulsa')
  const badge = identity?.successorPending ? SUCCESSOR_PENDING_BADGE : liveBadgeFor(live ?? undefined)
  const activityLabel = liveActivityLabel(live?.lastActivityAt ?? null, Date.now())
  const ctxLabel = contextLabel(live?.tokens)

  // A filha está bloqueada esperando a mãe. É o único momento em que pode haver
  // um menu TUI aberto na tela dela — e o único em que o aviso de read-only
  // (abaixo) tem serventia. Mesma pergunta que o dock faz pra ordenar e acender
  // o âmbar: uma função só, senão as duas superfícies divergem.
  const answering = handoff ? crewNeedsAttention(handoff, live ?? undefined) : false
  // A pergunta ficou pendente no banco mas a filha já seguiu (respondida fora do
  // app). O registro continua visível abaixo, em tom neutro — o que ele não pode
  // mais fazer é comandar o selo.
  const resumed = handoff ? crewResumedAfterQuestion(handoff) : false
  // needs_input vence o status do PTY no selo (mesma regra do HandoffCard): quem
  // está travado esperando você não está "trabalhando". Sem isto o cabeçalho
  // contradiz o corpo — "trabalhando" a dois centímetros de "A filha perguntou".
  const blocked = handoff?.status === 'needs_input' && !resumed

  // "Ver o terminal": alterna o overlay pra modo terminal, aqui na janela. Pelo
  // dock, com aba aberta, leva até a aba (ver crewTerminalTarget).
  function showTerminal() {
    const target = crewTerminalTarget(live, useAppStore.getState().panes, origin)
    if (target === 'none') return
    if (target === 'pane') {
      promoteToTab()
      return
    }
    setPeekMode('terminal')
  }

  // Promover a sessão a aba de verdade: ação explícita, e a ÚNICA que navega. É a
  // porta pro header completo de sessão (com encerrar) — de propósito. A lease
  // sai antes, pra aba remontar o xterm já como dona da PTY; e o foco não volta
  // à origem: ele pertence ao terminal recém aberto.
  function promoteToTab() {
    if (!live) return
    useTerminalLease.getState().release(live.id, 'modal')
    onClose({ restoreFocus: false })
    if (lift) useProjectsViewStore.getState().setView('terminals')
    void focusOrOpenSession(live)
  }

  // RESPOSTA: handoffs:send-message, chaveado pelo handoffId — NUNCA
  // sessionsApi.write. Só este caminho chama store.resume(id) e encerra o
  // needs_input; qualquer outro canal entregaria o texto mas deixaria o card
  // âmbar aceso à toa (o main não observa o SendMessage do MCP).
  async function send() {
    const text = message.trim()
    if (!handoff || !text || sending) return
    setSending(true)
    setError(null)
    try {
      await handoffsApi.sendMessage({ id: handoff.id, text })
      setMessage('')
    } catch (err) {
      // Filha morreu entre o render e o envio é o caso comum: mostra o motivo e
      // preserva o texto pro usuário não perder o que digitou.
      setError(err instanceof Error ? err.message : 'Não foi possível entregar a mensagem.')
    } finally {
      setSending(false)
      await load()
    }
  }

  return (
    <div
      // z-[1000] é o mesmo do Dialog e pelo mesmo motivo: o dockview desenha
      // .dv-sash em 99 e seus overlays em 999 (--dv-overlay-z-index). Qualquer
      // valor abaixo disso põe o peek por baixo das divisórias assim que houver
      // split — não reproduz com painel único, mas quebra na primeira divisão.
      className={`fixed inset-0 z-[1000] flex items-center justify-center p-6 ${
        lift ? 'bg-black/70' : 'bg-black/60'
      }`}
      data-testid="peek-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      {/* role/aria-modal no painel, não no backdrop (padrão do Dialog e do APG):
          o backdrop é área de clique-pra-fechar, não conteúdo do diálogo. */}
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-peek-mode={mode}
        data-peek-lift={lift ? 'true' : undefined}
        tabIndex={-1}
        onKeyDown={trapTab}
        className={`${animateIn ? 'pw-rise ' : ''}flex outline-none flex-col overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] shadow-2xl ${
          lift ? 'h-[90vh] w-[min(1400px,94vw)]' : 'h-[88vh] w-[56rem] max-w-[92vw]'
        }`}
      >
        <header
          data-testid="peek-header"
          className={`flex shrink-0 gap-3 border-b border-[var(--color-border)] px-4 ${
            lift ? 'h-10 items-center' : 'items-start py-3'
          }`}
        >
          <div className="min-w-0 flex-1">
            {/* No lift o header é uma linha só (36-40px, como o Maestri): o
                motivo de abrir a modal é o terminal, não o cabeçalho. */}
            <div className={`flex items-center gap-x-2 gap-y-1 ${lift ? 'min-w-0 flex-nowrap' : 'flex-wrap'}`}>
              <span id={titleId} className="truncate text-base font-medium text-[var(--color-text)]">
                {!handoff
                  ? (live?.title ?? live?.name ?? repoLabel)
                  : (live?.title ?? (alias ? alias.name : `→ ${repoLabel}`))}
              </span>
              {roleLabel && (
                <span
                  data-testid="peek-role"
                  data-role={role?.kind}
                  title={
                    role?.kind === 'mother'
                      ? `Mãe: lidera ${role.children} ${role.children === 1 ? 'filha' : 'filhas'} de handoff`
                      : 'Filha de handoff'
                  }
                  className="inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
                  style={
                    role?.kind === 'mother'
                      ? { color: 'var(--color-bg)', background: 'var(--color-accent)' }
                      : { color: 'var(--color-text-dim)', background: 'var(--color-surface-2)' }
                  }
                >
                  <Icon as={role?.kind === 'mother' ? Crown : CornerDownRight} size={11} />
                  {roleLabel}
                </span>
              )}
              {graphNode?.featureTitle && (
                <span
                  data-testid="peek-feature"
                  title={`Feature: ${graphNode.featureTitle}`}
                  className="inline-flex min-w-0 max-w-[16rem] shrink items-center gap-1 rounded-full border border-[var(--color-border)] px-1.5 py-0.5 text-[11px] text-[var(--color-text-dim)]"
                >
                  <Icon as={Target} size={11} className="shrink-0" />
                  <span className="truncate">{graphNode.featureTitle}</span>
                </span>
              )}
              {blocked && handoff ? (
                <span className="shrink-0" title="A filha está bloqueada esperando sua resposta">
                  <StatusBadge status={handoff.status} />
                </span>
              ) : (
                <span
                  className="inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-0.5 text-[11px] font-medium"
                  style={{
                    color: badge.color,
                    borderColor: `color-mix(in srgb, ${badge.color} 45%, transparent)`,
                    background: `color-mix(in srgb, ${badge.color} 12%, transparent)`,
                  }}
                  data-testid="peek-live-badge"
                  title="Estado ao vivo da sessão-filha"
                >
                  <span className="h-1.5 w-1.5 rounded-full" style={{ background: badge.color }} />
                  {badge.label}
                </span>
              )}
              {lift && (
                <span
                  data-testid="peek-header-meta"
                  className="min-w-0 truncate text-[11px] text-[var(--color-text-dim)]"
                >
                  {[
                    !handoff
                      ? [live?.projectName, repoLabel].filter(Boolean).join('/')
                      : alias
                        ? `${alias.name}/${repoLabel}`
                        : repoLabel,
                    activityLabel,
                    ctxLabel,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              )}
            </div>
            {!lift && (<>
            <div className="truncate text-[11px] text-[var(--color-text-dim)]">
              {!handoff
                ? [live?.projectName, repoLabel].filter(Boolean).join(' · ')
                : alias
                  ? `${alias.name} · ${repoLabel}`
                  : `→ ${repoLabel}`}
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-2 font-mono text-[11px] tabular-nums text-[var(--color-text-dim)]">
              {activityLabel && <span title="Última atividade da filha">{activityLabel}</span>}
              {ctxLabel && <span title="Tokens de contexto em uso">{ctxLabel}</span>}
              {/* O card do dock clampa o briefing em duas linhas; o integral vive
                  AQUI. Truncar sem caminho pro completo seria trocar um problema
                  por outro — fechado por padrão porque o peek é pra conversa. */}
              {handoff && (
                <button
                  type="button"
                  onClick={() => setShowBriefing((v) => !v)}
                  aria-expanded={showBriefing}
                  className="font-sans text-[var(--color-accent)] hover:underline"
                >
                  {showBriefing ? 'ocultar briefing' : 'ver briefing'}
                </button>
              )}
            </div>
            {showBriefing && handoff && (
              <div className="mt-1.5 max-h-32 overflow-y-auto whitespace-pre-wrap rounded-md border border-[var(--color-border)] bg-[var(--color-bg)]/60 px-2 py-1.5 text-xs text-[var(--color-text)]">
                {handoff.task}
              </div>
            )}
            </>)}
          </div>

          <div className="flex shrink-0 items-center gap-1">
            {/* Chat ⇄ Terminal, os dois DENTRO da janela. Segmentado (e não um
                ícone que alterna) porque aqui os dois modos são destinos de
                mesmo peso: ler a conversa e mexer na TUI. */}
            {live && (
              <div
                role="group"
                aria-label="Modo de exibição da filha"
                className="flex items-center gap-0.5 rounded border border-[var(--color-border)] p-0.5 text-[11px]"
              >
                <PeekModeButton
                  active={mode === 'chat'}
                  icon={MessageSquare}
                  label="Chat"
                  disabled={!providerSupports(live.provider).chatView}
                  title={
                    providerSupports(live.provider).chatView
                      ? 'Conversa renderizada do transcript (a PTY segue viva)'
                      : CLAUDE_ONLY_REASON
                  }
                  onClick={() => setPeekMode('chat')}
                />
                <PeekModeButton
                  active={mode === 'terminal'}
                  icon={SquareTerminal}
                  label="Terminal"
                  title="Terminal cru da sessão, aqui na janela (menus TUI clicáveis)"
                  onClick={showTerminal}
                />
              </div>
            )}
            {lift && graphNode && canPassBaton(graphNode) && (
              <button
                type="button"
                data-testid="peek-baton"
                onClick={() => setBatonOpen(true)}
                title={
                  role?.kind === 'mother'
                    ? 'A sucessora assume a liderança das filhas, com endereço novo'
                    : 'Destila o contexto e sobe uma sucessora limpa'
                }
                className="flex items-center gap-1 rounded border border-[var(--color-border)] px-1.5 py-0.5 text-[11px] text-[var(--color-text-dim)] transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
              >
                <Icon as={Repeat} size={12} />
                Passar o bastão
              </button>
            )}
            {lift && live && (
              <button
                type="button"
                data-testid="peek-open-tab"
                onClick={promoteToTab}
                title="Sai do mapa e leva até a aba da sessão (o header completo, com encerrar, fica lá)"
                className="flex items-center gap-1 rounded border border-[var(--color-border)] px-1.5 py-0.5 text-[11px] text-[var(--color-text-dim)] transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
              >
                <Icon as={ExternalLink} size={12} />
                Abrir na aba
              </button>
            )}
            <button
              type="button"
              onClick={() => onClose()}
              title="Fechar (Esc)"
              aria-label="Fechar"
              className="rounded p-1 text-[var(--color-text-dim)] transition hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text)]"
            >
              <Icon as={X} size={16} />
            </button>
          </div>
        </header>

        {/* relative + min-h-0: ChatView e Terminal se posicionam com absolute inset-0. */}
        <div ref={bodyRef} className="relative min-h-0 flex-1">
          {mode === 'terminal' && live ? (
            <div className="absolute inset-0">
              {/* chrome="bare": o header de sessão (com ENCERRAR) fica de fora —
                  a moldura é a desta janela. Anexa à MESMA PTY viva, sem pane e
                  sem segundo processo claude; o backlog é replicado no mount. */}
              <Terminal
                session={sessionFromLiveSession(live, null)}
                repoLabel={live.repo?.label ?? 'Avulsa'}
                repoPath={live.repo?.path ?? ''}
                projectName={live.projectName ?? ''}
                projectIcon={live.projectIcon}
                projectColor={live.projectColor}
                mode="terminal"
                chrome="bare"
                leaseHost="modal"
                fontSize={lift ? Math.max(LIFT_FONT_PX, prefFontSize) : undefined}
                hudStatus={
                  blocked && handoff
                    ? { label: STATUS_LABEL.needs_input, color: STATUS_COLOR.needs_input }
                    : badge
                }
                onClose={() => onClose()}
              />
            </div>
          ) : (live?.id ?? handoff?.childSessionId) ? (
            <ChatView
              sessionId={(live?.id ?? handoff?.childSessionId)!}
              status={live?.status}
              // Sem onRespond: os cards interativos ficam read-only aqui (o
              // clique deles digita no xterm, que o modo chat não monta). O botão
              // do banner de espera do ChatView troca pro modo terminal — mesma
              // janela, onde o menu TUI é de fato clicável.
              onToggleMode={live ? showTerminal : undefined}
              emptyHint="Sem conversa ainda. Escreva abaixo para mandar a primeira mensagem."
            />
          ) : (
            <div className="flex h-full items-center justify-center px-6 text-center text-sm text-[var(--color-text-dim)]">
              A sessão-filha ainda não subiu — não há conversa pra mostrar.
            </div>
          )}
        </div>

        {batonOpen && graphNode?.ccSessionId && (
          <BatonDialog
            open
            onClose={() => setBatonOpen(false)}
            sessionId={graphNode.sessionId}
            ccSessionId={graphNode.ccSessionId}
            repoLabel={graphNode.repoLabel ?? undefined}
          />
        )}
        {strip.length > 1 && (
          <LiftStrip
            ids={strip}
            roleOf={roleOf}
            currentId={currentId}
            onPick={switchTo}
            escHint={mode === 'terminal' ? escHints(!!handoff) : null}
          />
        )}

        {/* Em modo terminal o rodapé encolhe: o input é o composer do próprio
            Terminal, e a pergunta pendente está desenhada na TUI ali em cima.
            Dois campos de texto empilhados seriam duas verdades competindo. Com
            a faixa de troca, as dicas vão nela (uma linha só). */}
        {mode === 'terminal' ? (
          strip.length > 1 ? null : (
            <div className="flex h-8 shrink-0 items-center gap-3 border-t border-[var(--color-border)] px-3 text-[10px] text-[var(--color-text-dim)]">
              <ShortcutHints hints={escHints(!!handoff)} />
              {!lift && <PromoteToTabLink live={live} onClick={promoteToTab} />}
            </div>
          )
        ) : !handoff ? (
          <SessionChatFooter
            live={live}
            onTerminal={showTerminal}
            onPromote={lift ? undefined : promoteToTab}
          />
        ) : (
        <div className="shrink-0 border-t border-[var(--color-border)] p-3">
          {/* Limitação assumida: menu TUI (escolher opção numerada) é desenhado
              no xterm e parseado do buffer dele — sem xterm, o card é só leitura.
              Dizer isso na cara, com a saída ao lado, em vez de deixar o usuário
              clicando em algo inerte. */}
          {answering && (
            <div
              className="mb-2 flex items-center gap-2 rounded-md border px-3 py-2 text-xs"
              style={{
                borderColor: 'color-mix(in srgb, var(--color-warning) 45%, transparent)',
                background: 'color-mix(in srgb, var(--color-warning) 8%, transparent)',
                color: 'var(--color-text)',
              }}
            >
              <span className="flex-1">
                Responder em texto funciona daqui. Escolher opção de menu (plano, permissão,
                pergunta numerada) só no terminal — o menu é desenhado por ele.
              </span>
              {live && (
                <button
                  type="button"
                  onClick={showTerminal}
                  className="flex shrink-0 items-center gap-1 rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 font-medium transition hover:border-[var(--color-warning)]"
                >
                  <Icon as={SquareTerminal} size={13} />
                  Ver o terminal
                </button>
              )}
            </div>
          )}

          {/* A pergunta continua aqui mesmo depois de respondida fora do app — o
              registro é o histórico da conversa. O que muda é o TOM: âmbar
              enquanto ela de fato bloqueia; neutro quando a filha já retomou. */}
          {handoff.status === 'needs_input' && handoff.pendingQuestion && (
            <div
              data-testid="peek-question"
              className="mb-2 max-h-32 overflow-y-auto whitespace-pre-wrap rounded-md border px-3 py-2 text-sm"
              style={{
                borderColor: resumed ? 'var(--color-border)' : 'var(--color-warning)',
                background: resumed
                  ? undefined
                  : 'color-mix(in srgb, var(--color-warning) 10%, transparent)',
                color: resumed ? 'var(--color-text-dim)' : 'var(--color-text)',
              }}
            >
              <div
                className="mb-1 text-[11px] font-medium"
                style={{ color: resumed ? 'var(--color-text-dim)' : 'var(--color-warning)' }}
              >
                {resumed
                  ? 'A filha perguntou (e já retomou — respondida fora do app):'
                  : 'A filha perguntou:'}
              </div>
              {handoff.pendingQuestion}
            </div>
          )}

          {error && <div className="mb-2 text-xs text-[var(--color-danger)]">{error}</div>}

          <form
            className="flex items-start gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              void send()
            }}
          >
            <textarea
              ref={inputRef}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  void send()
                }
              }}
              rows={2}
              disabled={!live}
              placeholder={
                live
                  ? answering
                    ? 'Responder à filha…'
                    : 'Enviar mensagem para a filha…'
                  : 'A sessão-filha não está mais viva.'
              }
              className="min-h-[44px] flex-1 resize-y rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-sm text-[var(--color-text)] outline-none focus:border-[var(--color-accent)] disabled:opacity-50"
            />
            <button
              type="submit"
              disabled={!live || sending || message.trim().length === 0}
              title="Enviar (Enter)"
              className="flex shrink-0 items-center gap-1 rounded border px-3 py-2 text-xs font-medium transition disabled:opacity-40"
              style={{
                color: answering ? 'var(--color-warning)' : 'var(--color-accent)',
                borderColor: answering ? 'var(--color-warning)' : 'var(--color-accent)',
              }}
            >
              <Icon as={CornerDownLeft} size={13} />
              {sending ? 'Enviando…' : answering ? 'Responder' : 'Enviar'}
            </button>
          </form>

          <div className="mt-2 flex items-center gap-3 text-[10px] text-[var(--color-text-dim)]">
            <span>↵ enviar</span>
            <span>shift+↵ nova linha</span>
            <span>esc fechar</span>
            <PromoteToTabLink live={live} onClick={promoteToTab} />
          </div>
        </div>
        )}
      </div>
    </div>
  )
}

// Segmento do alternador Chat/Terminal. Ativo = fundo de superfície + texto
// pleno; inativo = só texto apagado, sem borda — a borda é do grupo.
function PeekModeButton({
  active,
  icon,
  label,
  title,
  onClick,
  disabled = false,
}: {
  active: boolean
  icon: typeof MessageSquare
  label: string
  title: string
  onClick: () => void
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      title={title}
      className={`flex items-center gap-1 rounded px-1.5 py-0.5 transition disabled:cursor-not-allowed disabled:opacity-40 ${
        active
          ? 'bg-[var(--color-surface-2)] text-[var(--color-text)]'
          : 'text-[var(--color-text-dim)] hover:text-[var(--color-text)]'
      }`}
    >
      <Icon as={icon} size={12} />
      {label}
    </button>
  )
}

// Faixa de troca do lift: as sessões do mesmo agrupamento do mapa, na ordem dele.
// Trocar remonta o painel no mesmo modo (terminal continua terminal).
// Em modo terminal o Esc é da TUI (cancelar, sair de menu, interromper): fechar
// a modal com ele deixaria o terminal pela metade. Daí o Shift+Esc.
export function escHints(child: boolean): ShortcutHint[] {
  return [
    { keys: ['Esc'], label: `vai à ${child ? 'filha' : 'sessão'}` },
    { keys: ['Shift+Esc'], label: 'fecha' },
  ]
}

export function escHintFor(child: boolean): string {
  return hintText(escHints(child))
}

const LIFT_SWITCH_HINTS: ShortcutHint[] = [{ keys: ['Alt+,', 'Alt+.'], label: 'trocar' }]
export const LIFT_SWITCH_HINT = hintText(LIFT_SWITCH_HINTS)

function LiftStrip({
  ids,
  roleOf,
  currentId,
  onPick,
  escHint,
}: {
  ids: string[]
  roleOf: (id: string) => PeekRole
  currentId: string | null
  onPick: (id: string) => void
  escHint: ShortcutHint[] | null
}) {
  const liveSessions = useAppStore((s) => s.liveSessions)
  return (
    <div
      data-testid="peek-lift-strip"
      className="flex h-8 shrink-0 items-center gap-1 overflow-x-auto border-t border-[var(--color-border)] px-3 [scrollbar-width:none]"
    >
      {ids.map((id) => {
        const s = liveSessions.find((x) => x.id === id)
        const active = id === currentId
        const r = roleOf(id)
        return (
          <button
            key={id}
            type="button"
            data-lift-session={id}
            data-role={r?.kind}
            aria-pressed={active}
            onClick={() => onPick(id)}
            title={s?.title ?? s?.name ?? id}
            className={`flex max-w-[14rem] shrink-0 items-center gap-1 rounded px-2 py-0.5 text-[11px] transition ${
              active
                ? 'bg-[var(--color-surface-2)] text-[var(--color-text)]'
                : 'text-[var(--color-text-dim)] hover:text-[var(--color-text)]'
            }`}
          >
            {r && (
              <Icon
                as={r.kind === 'mother' ? Crown : CornerDownRight}
                size={11}
                className={`shrink-0 ${r.kind === 'mother' ? 'text-[var(--color-accent)]' : ''}`}
              />
            )}
            <span className="truncate">{s?.title ?? s?.name ?? s?.repo?.label ?? 'Sessão'}</span>
          </button>
        )
      })}
      <ShortcutHints
        testId="peek-lift-hints"
        className="ml-auto shrink-0 pl-2"
        hints={[...LIFT_SWITCH_HINTS, ...(escHint ?? [])]}
      />
    </div>
  )
}

// Rodapé do peek de sessão avulsa em modo chat: não há canal de handoff pra
// responder, então escrever é no terminal da própria sessão (mesma janela).
function SessionChatFooter({
  live,
  onTerminal,
  onPromote,
}: {
  live: LiveSessionInfo | null
  onTerminal: () => void
  // Ausente no lift: lá o "Abrir na aba" mora no cabeçalho.
  onPromote?: () => void
}) {
  return (
    <div className="flex shrink-0 items-center gap-3 border-t border-[var(--color-border)] px-3 py-2 text-[11px] text-[var(--color-text-dim)]">
      <span className="flex-1">Para escrever para a sessão, use o terminal dela.</span>
      {live && (
        <button
          type="button"
          onClick={onTerminal}
          className="flex shrink-0 items-center gap-1 rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 font-medium text-[var(--color-text)] transition hover:border-[var(--color-accent)]"
        >
          <Icon as={SquareTerminal} size={13} />
          Ver o terminal
        </button>
      )}
      <span>esc fechar</span>
      {onPromote && <PromoteToTabLink live={live} onClick={onPromote} />}
    </div>
  )
}

// Promover a filha a aba de verdade. Fica no rodapé, em texto, e não junto do
// alternador: quem só está espiando não deve esbarrar nela — é ela que abre o
// header completo de sessão, com encerrar.
function PromoteToTabLink({ live, onClick }: { live: LiveSessionInfo | null; onClick: () => void }) {
  if (!live) return null
  return (
    <button
      type="button"
      onClick={onClick}
      title="Promover a filha a aba de trabalho (re-attacha a PTY viva; só lá aparece o header completo da sessão)"
      className="ml-auto text-[var(--color-accent)] hover:underline"
    >
      abrir como aba
    </button>
  )
}
