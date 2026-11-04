import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { ChatMessage, SessionActivity } from '../../../../shared/types/ipc'
import { ChatStatusStrip } from './ChatStatusStrip'
import { CommandCard, CommandOutputCard } from './CommandCard'
import { ChatEmptyState } from './ChatEmptyState'
import { CompactSummaryCard } from './CompactSummaryCard'
import { ConfigCard } from './ConfigCard'
import { HistorySearchCard } from './HistorySearchCard'
import { CliDraftBanner } from './CliDraftBanner'
import { useRewind } from './useRewind'
import type { InputBoxState } from '../../../../shared/tui/input-draft'
import {
  historyAcceptKeys,
  historyCancelKeys,
  historyFillKeys,
  historyNewerKeys,
  historyOlderKeys,
  historyQueryKeys,
  historyScopeKeys,
  historySelectKeys,
} from '../history-search-keys'
import { MessageBubble } from './MessageBubble'
import { HandoffUpdateCard } from './HandoffUpdateCard'
import { parseHandoffWakeEnvelope } from '../../../../shared/handoff-wake-envelope'
import { MetaCard } from './MetaCard'
import { ModelChangeChip } from './ModelChangeChip'
import { ModelPickerCard } from './ModelPickerCard'
import { PermissionCard } from './PermissionCard'
import { PendingElsewhereChip } from './PendingElsewhereChip'
import { useMainPermissionMenu, usePermissionResponder } from './usePermissionResponder'
import { PlanCard, type PlanDecision } from './PlanCard'
import { planAcceptsFeedback, planApprovalMode, planChoices } from './plan-choices'
import type { PermissionMode } from '../../../../shared/types/ipc'
import { PLAN_PLACEHOLDER, TranscriptPlanCard } from './TranscriptPlanCard'
import { ChatWaitBanners } from './ChatWaitBanners'
import { QuestionCard } from './QuestionCard'
import { GenericMenuCard } from './GenericMenuCard'
import { actionKeyDelay, keysForAction } from '../../../../shared/tui/menu-actions'
import { QuestionReviewCard } from './QuestionReviewCard'
import { SubagentCard } from './SubagentCard'
import { SystemCard } from './SystemCard'
import { ThemePickerCard } from './ThemePickerCard'
import { ThinkingCard } from './ThinkingCard'
import { ToolGroup, ToolResultCard } from './ToolCard'
import { buildChatRows, rowRhythm, rowSpacing, type RowRhythm } from './chat-rows'
import { JumpToLatest, WorkingIndicator } from './ChatLiveIndicators'
import { useChatTranscript, usePlanFile } from './useChatTranscript'
import { ArtifactCard } from './artifacts/ArtifactCard'
import { ArtifactSidePanel } from './artifacts/ArtifactSidePanel'
import { ArtifactConsultChip } from './artifacts/ArtifactConsultChip'
import { artifactRefKey, planArtifacts } from './artifacts/artifact-refs'
import { useArtifactPanelStore } from './artifacts/artifactPanelStore'
import { useSidePanelFits } from './artifacts/useSidePanelFits'
import {
  buildArrowKeys,
  buildChatKeys,
  buildCtrlTKey,
  buildEnterKey,
  buildEscKey,
  buildGenericScrollKeys,
  buildFilterKeys,
  buildMultiSelectSubmitKeys,
  buildMultiSubmitKeys,
  buildPickerSelectKeys,
  buildPlanKeys,
  PLAN_KEY_DELAY_MS,
  QUESTION_KEY_DELAY_MS,
  buildQuestionOtherKeys,
  buildReviewKeys,
  buildSelectKeys,
  buildSpaceKey,
  buildQuestionTabKeys,
  buildToggleKeys,
} from './respond-keys'
import { gateMenuByStatus, menuFingerprint, type TuiMenu } from '../tui-menu-parser'
import { pickerFingerprint, type TuiHistorySearch, type TuiPicker } from '../tui-picker-parser'
import {
  decidedPlanText,
  isAtBottom,
  liveMenuCoversPending,
  nextResolveAt,
  pendingInteractive,
  reconcileEchoes,
  resolveChatViewState,
  resolveInteractive,
  settleDialogEchoes,
  userLines,
  visibleEchoes,
  showTerminalWaitBanner,
  type ChatViewState,
  type Echo,
} from './chat-logic'

export interface ChatViewHandle {
  // Eco otimista: chamado pelo Terminal ao enviar pelo composer em modo chat.
  pushEcho: (text: string) => void
}

interface Props {
  sessionId: string
  // Status da sessão (do broadcast session:activity, via Terminal) pra mostrar um
  // indicador discreto de "trabalhando" enquanto o claude computa a resposta.
  status?: SessionActivity['status']
  // Alterna pro modo terminal. Usado pelo banner de espera genérica (ex.: prompt
  // de permissão y/n, TTY-only) pra levar o usuário ao único lugar que o renderiza.
  onToggleMode?: () => void
  // Reproduz sequências de teclas no PTY vivo (mesmo write() do onForwardKey do
  // composer). Vem do Terminal; ausente = cards ficam read-only. Consumido pelo
  // caminho de clique baseado no menu TUI parseado. delayMs: respiro entre as
  // sequências quando a TUI precisa redesenhar entre elas (campo de feedback).
  // Resolve quando a última tecla saiu; false = o Terminal recusou (outra resposta
  // ainda tocando, ex. pelo composer) e nada foi escrito.
  onRespond?: (seqs: string[], delayMs?: number) => void | Promise<boolean | void>
  // Plano aprovado pelo card: o modo de permissão que a opção liga (palpite do pill
  // até o rodapé do xterm voltar a aparecer).
  onPlanApproved?: (mode: PermissionMode) => void
  // Menu TUI pendente parseado do buffer do xterm (Terminal, debounced). É a
  // FONTE do momento pendente clicável. null = sem menu íntegro parseado.
  tuiMenu?: TuiMenu | null
  // Re-parse FRESCO do buffer, chamado imediatamente antes de digitar (guard de
  // clique: o menu pode ter fechado/mudado desde o último debounce).
  reparseMenu?: () => TuiMenu | null
  // Picker de /model, /theme, /config ou busca de histórico (Ctrl+R) parseado
  // do buffer — Fase 2, família separada de tuiMenu (layout de tela diferente,
  // ver tui-picker-parser). null = nenhum picker íntegro no momento.
  tuiPicker?: TuiPicker | null
  // Re-parse fresco do picker, mesmo papel de reparseMenu.
  reparsePicker?: () => TuiPicker | null
  // Texto que ficou na caixa de input da CLI (null = vazia) e o leitor fresco dela.
  cliDraft?: string | null
  readCliInput?: () => InputBoxState
  // Estado vazio de quem só LÊ (peek): "digite abaixo" mentiria, não há campo.
  emptyHint?: string
  // O menu pendente é respondido por um painel fora do chat (quick look da filha).
  menuAnsweredElsewhere?: boolean
  // Sem ele no mount o main não arma o watch; quando chega, o watch é refeito.
  ccSessionId?: string | null
  // Sessão filha ativa: o card oferece "Sempre permitir para filhas".
  isChild?: boolean
  // Sem xterm (quick look em chat): o pedido de permissão vem do espelho do main.
  menuFromMain?: boolean
  // false = sem painel lateral de artefato (a gaveta "Sessão" dos editores já
  // está ao lado do artefato); os cards abrem direto no editor.
  artifactSide?: boolean
}

// O "Restore conversation" do /rewind não grava nada no JSONL: o ramo novo só aparece no
// disco com a próxima mensagem (sonda e2e-rewind-restore). Até lá o chat mostra o antigo.
const RESTORED_NOTICE =
  'A conversa voltou no terminal. O chat esconde as mensagens desfeitas quando a próxima mensagem chegar; a mensagem restaurada ficou na caixa do terminal (aviso abaixo).'

function restoresConversation(menu: TuiMenu, optionIndex: number): boolean {
  const label = menu.options.find((o) => o.index === optionIndex)?.label ?? ''
  return menu.question === 'Rewind' && /^Restore (code and )?conversation$/.test(label)
}

// Render híbrido do transcript JSONL. O PTY segue vivo por baixo (xterm oculto no
// Terminal); esta view só LÊ o transcript e adiciona ecos otimistas das mensagens
// recém-enviadas até o disco alcançar.
// A sonda viu o tool_use chegar ao JSONL até ~10s depois do diálogo (awaitUseMs).
export const ANSWER_HOLD_MS = 10_000

export const ChatView = forwardRef<ChatViewHandle, Props>(function ChatView({ sessionId, status, onToggleMode, onRespond, onPlanApproved, tuiMenu: tuiMenuProp, reparseMenu, tuiPicker, reparsePicker, cliDraft = null, readCliInput, emptyHint, menuAnsweredElsewhere, ccSessionId, isChild, menuFromMain, artifactSide = true }, ref) {
  const mainMenu = useMainPermissionMenu(sessionId, !!menuFromMain && tuiMenuProp == null, status)
  const tuiMenu = tuiMenuProp ?? mainMenu
  const { messages, loading, transcriptExists, lastPlanFilePath } = useChatTranscript(sessionId, ccSessionId ?? null)
  const [echoes, setEchoes] = useState<Echo[]>([])
  const scrollRef = useRef<HTMLDivElement>(null)
  // Só auto-scrollamos se o usuário já estava colado no fim (não roubamos a
  // rolagem de quem subiu pra reler).
  const stickRef = useRef(true)

  const diskLines = useMemo(() => userLines(messages), [messages])
  const diskUserCount = diskLines.length
  // Restore conversation pelo card: o terminal desfez mensagens que o chat só tira quando o
  // próximo prompt chegar ao disco. Até as linhas do disco mudarem, as paradas do /rewind
  // não são as mensagens que o chat mostra.
  const diskKey = useMemo(() => JSON.stringify(diskLines), [diskLines])
  const [restoredAt, setRestoredAt] = useState<string | null>(null)
  useEffect(() => {
    if (restoredAt != null && diskKey !== restoredAt) setRestoredAt(null)
  }, [diskKey, restoredAt])
  const shownEchoes = useMemo(() => visibleEchoes(echoes), [echoes])

  useImperativeHandle(
    ref,
    () => ({
      pushEcho: (text: string) => {
        stickRef.current = true
        setEchoes((prev) => [
          ...prev,
          { text, resolveAt: nextResolveAt(diskUserCount, visibleEchoes(prev).length) },
        ])
      },
    }),
    [diskUserCount],
  )

  // Poda ecos resolvidos a cada leitura do disco. Comparar as linhas (e não só a contagem)
  // cobre o rewind, que tira mensagens do chat na mesma leitura em que o prompt novo chega.
  const seenDiskLines = useRef(diskLines)
  useEffect(() => {
    const prev = seenDiskLines.current
    seenDiskLines.current = diskLines
    setEchoes((cur) => reconcileEchoes(cur, prev, diskLines))
  }, [diskLines])

  // Espelho em estado do stickRef, só pra mostrar o atalho "Ir para o fim".
  const [stuck, setStuck] = useState(true)
  const [unseen, setUnseen] = useState(false)
  // Salto suave em andamento: os scroll events intermediários ainda não estão no
  // fim e não podem desengatar o "colado" (o botão piscaria e o auto-scroll pararia).
  const jumpingRef = useRef(false)
  function onScroll() {
    const el = scrollRef.current
    if (!el) return
    const at = isAtBottom(el)
    if (jumpingRef.current) {
      if (at) jumpingRef.current = false
      return
    }
    stickRef.current = at
    setStuck(at)
    if (at) setUnseen(false)
  }
  function jumpToLatest() {
    const el = scrollRef.current
    if (!el) return
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    stickRef.current = true
    jumpingRef.current = true
    setStuck(true)
    setUnseen(false)
    const done = () => {
      jumpingRef.current = false
    }
    el.addEventListener('scrollend', done, { once: true })
    // Sem scrollend (ou salto interrompido): não deixa a trava presa.
    window.setTimeout(done, 1500)
    el.scrollTo({ top: el.scrollHeight, behavior: reduce ? 'auto' : 'smooth' })
  }

  const rendered = useMemo<ChatMessage[]>(
    () => [...messages, ...shownEchoes.map((e) => ({ kind: 'user', text: e.text }) as ChatMessage)],
    [messages, shownEchoes],
  )

  // Conteúdo novo com o usuário lendo lá em cima: não puxamos a rolagem, avisamos.
  const prevCountRef = useRef(0)

  // Troca de sessão na mesma instância (peek/gaveta): no 1º render o hook ainda
  // devolve as mensagens da sessão anterior (e loading=false). Até elas serem
  // trocadas a vista é 'loading' e a contagem de "já pintado" recomeça — senão a
  // conversa nova entraria em cascata animada a partir do tamanho da antiga.
  const firstCountRef = useRef<number | null>(null)
  const sessionRef = useRef(sessionId)
  const lastMessagesRef = useRef(messages)
  const staleRef = useRef<{ messages: ChatMessage[]; sawLoading: boolean } | null>(null)
  if (sessionRef.current !== sessionId) {
    sessionRef.current = sessionId
    staleRef.current = { messages: lastMessagesRef.current, sawLoading: false }
    firstCountRef.current = null
    prevCountRef.current = 0
    stickRef.current = true
  }
  if (staleRef.current) {
    if (loading) staleRef.current.sawLoading = true
    // Chegou outro transcript, ou a carga terminou sem trocar (falha de leitura).
    if (messages !== staleRef.current.messages || (staleRef.current.sawLoading && !loading)) {
      staleRef.current = null
    }
  }
  lastMessagesRef.current = messages
  const stale = staleRef.current !== null
  useEffect(() => {
    setStuck(true)
    setUnseen(false)
  }, [sessionId])
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (el && stickRef.current) el.scrollTop = el.scrollHeight
    else if (rendered.length > prevCountRef.current) setUnseen(true)
    prevCountRef.current = rendered.length
  }, [rendered])

  // Re-pina no fim quando a ALTURA do conteúdo cresce de forma assíncrona (syntax
  // highlight, imagens, web-font swap, expand de card) — o effect de [rendered] acima
  // só roda no commit do React e perde esse crescimento. Observa o div de conteúdo via
  // callback ref (que só existe no estado 'ready') e reusa o MESMO stickRef, então o
  // scroll-up desengata daqui também.
  const observerRef = useRef<ResizeObserver | null>(null)
  const contentRef = useCallback((node: HTMLDivElement | null) => {
    observerRef.current?.disconnect()
    if (!node) return
    const ro = new ResizeObserver(() => {
      const el = scrollRef.current
      if (el && stickRef.current) el.scrollTop = el.scrollHeight
    })
    ro.observe(node)
    observerRef.current = ro
  }, [])
  useEffect(() => () => observerRef.current?.disconnect(), [])

  // Liga cada pergunta/plano (por id) à resposta/decisão posterior, pra fundir
  // ambos no mesmo card e não renderizar a mensagem de resposta solta. Sobre as
  // mensagens de disco: ecos otimistas são só texto do usuário.
  const interactive = useMemo(() => resolveInteractive(messages), [messages])
  const artifactPlan = useMemo(() => planArtifacts(rendered), [rendered])
  const sidePanel = useArtifactPanelStore((s) => s.sessions[sessionId])
  const showArtifactSide = useArtifactPanelStore((s) => s.show)
  const sideKey = sidePanel?.open ? artifactRefKey(sidePanel.ref) : null
  const rootRef = useRef<HTMLDivElement>(null)
  const sideFits = useSidePanelFits(rootRef)
  const sideEnabled = artifactSide && sideFits
  const pendingPrompt = useMemo(() => pendingInteractive(messages), [messages])
  // Chamadas pareadas com o resultado e sequências agrupadas. Índices com card
  // de artefato ficam fora dos grupos (o despacho deles é do ArtifactCard).
  const rows = useMemo(() => {
    const own = new Set<number>([...artifactPlan.cards.keys(), ...artifactPlan.consults.keys()])
    return buildChatRows(rendered, artifactPlan.hidden, own)
  }, [rendered, artifactPlan])
  // Grupo do turno em andamento: o último, desde que nenhuma resposta ou mensagem
  // do disco tenha vindo depois (linhas que não renderizam e ecos não contam).
  const runningRow = useMemo(() => {
    if (status !== 'working') return -1
    for (let r = rows.length - 1; r >= 0; r--) {
      const row = rows[r]
      if (row.type === 'tools') return r
      const kind = rendered[row.index].kind
      const fromDisk = row.index < messages.length
      if (kind === 'assistant' || (fromDisk && (kind === 'user' || kind === 'command'))) return -1
    }
    return -1
  }, [status, rows, rendered, messages.length])

  // Acabou de mandar ou está raciocinando: "Pensando"; senão está agindo.
  const lastKind = rendered[rendered.length - 1]?.kind
  const lastIsThinking = lastKind === 'user' || lastKind === 'thinking'

  // Início do turno em andamento, pro tempo decorrido do indicador.
  const [workingSince, setWorkingSince] = useState<number | null>(null)
  useEffect(() => {
    setWorkingSince((cur) => (status === 'working' ? (cur ?? Date.now()) : null))
  }, [status])

  // Último subagente do transcript (nome + status) pra faixa de estado. Dado real
  // do transcript; o status vem do mesmo mapa que o SubagentCard consome.
  const lastSubagent = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (m.kind === 'subagent') {
        return { name: m.name, error: interactive.subagents.get(m.id) === true }
      }
    }
    return null
  }, [messages, interactive])

  // ── Momento pendente vindo do menu TUI parseado do buffer ──────────────────
  const menuFp = tuiMenu ? menuFingerprint(tuiMenu) : null
  // Clique já enviado pro menu atual (identificado por fingerprint) + contagem
  // de respostas resolvidas no momento do envio, pra detectar a resposta real.
  const [tuiSent, setTuiSent] = useState<{
    fp: string
    label?: string
    resolvedCount: number
  } | null>(null)
  // Fingerprint do menu cuja resposta JÁ chegou no JSONL: enquanto o menu
  // (idêntico) ainda não sumiu do buffer, o card sintetizado não renderiza —
  // senão duplicaria com o card respondido que o transcript acabou de trazer.
  const [consumedFp, setConsumedFp] = useState<string | null>(null)
  const resolvedCount = interactive.answers.size + interactive.plans.size

  useEffect(() => {
    if (menuFp == null) setConsumedFp(null)
  }, [menuFp])

  // Reconciliação do clique otimista: resposta real chegou (contagem avançou) →
  // menu consumido; menu mudou/sumiu sem resposta (ex.: Esc no terminal) → limpa
  // o sent pra não bloquear cliques num menu novo.
  // O diálogo sai da tela antes do tool_result chegar no JSONL (gravação preguiçosa
  // do 2.1.317 + debounce do watcher): nesse intervalo o pendente do transcript
  // voltaria sem botões e com o banner de "responda". Segura o estado de enviado
  // até a resposta chegar ou ANSWER_HOLD_MS passar.
  const lastCoveredRef = useRef<{ id: string; plan: string | null } | null>(null)
  // Último conteúdo do plan file mostrado no diálogo, por id: é o plano que o usuário
  // decidiu, e o card decidido cai nele quando a decisão não traz o plano (rejeição).
  const shownPlanRef = useRef(new Map<string, string>())
  const [answered, setAnswered] = useState<{
    id: string
    plan: string | null
    resolvedCount: number
  } | null>(null)

  useEffect(() => {
    if (!tuiSent) return
    if (resolvedCount > tuiSent.resolvedCount) {
      setConsumedFp(tuiSent.fp)
      setTuiSent(null)
    } else if (menuFp !== tuiSent.fp) {
      const covered = lastCoveredRef.current
      if (menuFp == null && covered && covered.id === pendingPrompt?.id) {
        setAnswered({ ...covered, resolvedCount: tuiSent.resolvedCount })
      }
      setTuiSent(null)
    }
  }, [tuiSent, resolvedCount, menuFp, pendingPrompt?.id])

  useEffect(() => {
    if (!answered) return
    if (resolvedCount > answered.resolvedCount || menuFp != null || pendingPrompt?.id !== answered.id) {
      setAnswered(null)
      return
    }
    const t = setTimeout(() => setAnswered(null), ANSWER_HOLD_MS)
    return () => clearTimeout(t)
  }, [answered, resolvedCount, menuFp, pendingPrompt?.id])
  const heldPending = answered != null && answered.id === pendingPrompt?.id ? answered : null

  // Dados sintetizados pro QuestionCard: a sentinela 'chat' fica fora das opções
  // (vira o botão "Conversar sobre isso"); 'other' (texto livre) fica dentro, no
  // single e no multi-select (teclas das sondas 2.1.317/318, ver respond-keys).
  const tuiQuestion = useMemo(() => {
    if (!tuiMenu || tuiMenu.kind !== 'question') return null
    const clickable = tuiMenu.options.filter((o) => o.sentinel !== 'chat')
    if (clickable.length === 0) return null
    return {
      clickable,
      questions: [
        {
          question: tuiMenu.question ?? 'Claude fez uma pergunta (veja o terminal).',
          header: '',
          multiSelect: tuiMenu.multiSelect,
          options: clickable.map((o) => ({
            label: o.label,
            description: o.description ?? '',
            sentinel: o.sentinel,
            checked: o.checked,
            preview: o.preview,
            otherText: o.otherText,
          })),
        },
      ],
    }
  }, [tuiMenu])

  const tuiPlanChoices = useMemo(
    () => (tuiMenu?.kind === 'plan' ? planChoices(tuiMenu) : []),
    [tuiMenu],
  )
  const [planNotice, setPlanNotice] = useState<string | null>(null)
  useEffect(() => setPlanNotice(null), [menuFp])

  // Prompt TTY-only (permissão de tool / trust de diretório) espelhado do buffer:
  // as opções vão inteiras pro card (não há sentinelas nesses menus).
  const tuiPermission =
    tuiMenu && (tuiMenu.kind === 'permission' || tuiMenu.kind === 'trust') ? tuiMenu : null
  const permission = usePermissionResponder({
    sessionId,
    menu: tuiPermission,
    isChild,
    reparseMenu,
    onRespond,
  })

  // Tela final de revisão ("Review your answers") do multi-select/multi-
  // pergunta — kind próprio no parser, card dedicado (QuestionReviewCard).
  const tuiReview = tuiMenu && tuiMenu.kind === 'question_review' ? tuiMenu : null
  // Diálogo da CLI lido pelo parser tolerante (ou o nudge do auto mode). Os pickers de
  // /model, /theme, /config e Ctrl+R têm card próprio, que tem precedência.
  const tuiGeneric =
    tuiMenu && (tuiMenu.kind === 'menu' || tuiMenu.kind === 'nudge') && !tuiPicker ? tuiMenu : null

  // Conteúdo do plano pro card PENDENTE, sempre do arquivo: o input.plan do JSONL
  // pode trazer o plano anterior (Write e ExitPlanMode saem em paralelo). O path
  // vem do rodapé do diálogo, senão do último Write/Edit em ~/.claude/plans/. O
  // fingerprint relê na hora quando o replanejamento regrava o mesmo path; o poll do
  // usePlanFile pega a edição por Ctrl+G. Sem path ou leitura falhou → placeholder.
  const pendingPlanText = usePlanFile(
    tuiMenu?.kind === 'plan' ? (tuiMenu.planFile ?? lastPlanFilePath) : null,
    menuFp,
  )

  // Card sintetizado só quando: menu íntegro + status elegível pro kind
  // ('waiting' pra qualquer um; 'starting'/'idle' pré-transcript só pra
  // permission/trust — mesmo gate do Terminal, defesa em profundidade) + o menu
  // não foi consumido. O menu vivo precede o pendente do transcript (ver
  // liveMenuCoversPending): esconder o card aqui deixava o plano sem botões.
  const showTuiCard =
    tuiMenu != null &&
    gateMenuByStatus(tuiMenu, status) != null &&
    menuFp !== consumedFp &&
    (tuiMenu.kind === 'plan' ||
      tuiQuestion != null ||
      tuiPermission != null ||
      tuiReview != null ||
      tuiGeneric != null)
  const coveredPendingId =
    showTuiCard && liveMenuCoversPending(pendingPrompt, tuiMenu?.kind) ? pendingPrompt?.id : null
  // Diálogo da CLI na tela (menu genérico, picker): o slash command que o abriu chegou,
  // e o disco pode nunca gravá-lo. Sem isto a bolha do /hooks ficava em "enviando…".
  const cliDialogOpen = (showTuiCard && tuiMenu?.kind === 'menu') || tuiPicker != null
  useEffect(() => {
    if (cliDialogOpen) setEchoes(settleDialogEchoes)
  }, [cliDialogOpen])
  // Teclas de uma resposta ainda tocando (o Other do multi-select leva ~1,2 s). O
  // cursor não entra no fingerprint, então um 2º clique nesse meio passaria no guard
  // e calcularia as setas de um cursor a caminho: as duas sequências se intercalam.
  const keysInFlightRef = useRef(false)
  const canRespondTui = onRespond != null && showTuiCard && tuiSent == null
  useEffect(() => {
    if (coveredPendingId) lastCoveredRef.current = { id: coveredPendingId, plan: pendingPlanText }
    if (coveredPendingId && pendingPlanText) shownPlanRef.current.set(coveredPendingId, pendingPlanText)
  }, [coveredPendingId, pendingPlanText])

  // Guard de clique: RE-PARSE fresco do buffer imediatamente antes de digitar.
  // Menu fechou/mudou (respondido pelo terminal, resize) → fingerprint diverge →
  // NÃO digita nada no PTY.
  function freshMenuMatches(): TuiMenu | null {
    if (keysInFlightRef.current) return null
    const fresh = reparseMenu?.() ?? null
    if (!fresh || menuFp == null || menuFingerprint(fresh) !== menuFp) return null
    return fresh
  }

  // Toda resposta do card passa por aqui: trava o card até a última tecla sair e a TUI
  // ter um respiro pra redesenhar (o próximo clique relê o cursor já parado).
  function sendKeys(...args: [keys: string[], delayMs?: number]) {
    if (!onRespond || keysInFlightRef.current) return
    const delayMs = args[1]
    keysInFlightRef.current = true
    void Promise.resolve(onRespond(...args))
      .then(async (ok) => {
        if (ok === false) setTuiSent(null)
        else if (delayMs) await new Promise((r) => setTimeout(r, delayMs))
      })
      .finally(() => {
        keysInFlightRef.current = false
      })
  }

  // Single-select: buildSelectKeys decide dígito-só ou dígito+Enter conforme
  // submitOnDigit, que fica FORA do fingerprint — por isso lê o re-parse fresco,
  // não o estado (senão o clique "seleciona mas não envia", Bug 2).
  function respondTuiQuestion(clickIndex: number, label: string) {
    if (!canRespondTui || !tuiQuestion || menuFp == null || tuiMenu?.multiSelect) return
    const target = tuiQuestion.clickable[clickIndex]
    if (!target) return
    const fresh = freshMenuMatches()
    if (!fresh) return
    const keys = buildSelectKeys(fresh, target.index)
    if (keys.length === 0) return
    setTuiSent({ fp: menuFp, label, resolvedCount })
    sendKeys(keys)
  }

  // Checkbox de multi-select: dígito faz TOGGLE, NUNCA é resposta final — não
  // marca tuiSent (o card segue interativo; o re-parse do Terminal já traz o
  // `checked` atualizado no próximo tuiMenu). Submeter de fato é só na aba
  // "Submit" → tela de revisão (respondTuiReview).
  function respondTuiToggle(clickIndex: number) {
    if (!canRespondTui || !tuiQuestion || menuFp == null || !tuiMenu?.multiSelect) return
    const target = tuiQuestion.clickable[clickIndex]
    const fresh = target ? freshMenuMatches() : null
    if (!target || !fresh) return
    const keys = buildToggleKeys(target.index, fresh)
    if (keys.length === 0) return
    sendKeys(keys)
  }

  // "Other" (texto livre). Single-select: é a resposta FINAL, marca tuiSent.
  // Multi-select: só marca a opção com o texto e leva o cursor ao Submit — o card
  // segue interativo e o re-parse traz "[✔] <texto>".
  function respondTuiOther(clickIndex: number, text: string) {
    if (!canRespondTui || !tuiQuestion || menuFp == null) return
    const target = tuiQuestion.clickable[clickIndex]
    const fresh = target ? freshMenuMatches() : null
    if (!target || !fresh) return
    const keys = buildQuestionOtherKeys(fresh, target.index, text)
    if (keys.length === 0) return
    if (fresh.multiSelect) {
      sendKeys(keys, QUESTION_KEY_DELAY_MS)
      return
    }
    setTuiSent({ fp: menuFp, label: text, resolvedCount })
    sendKeys(keys)
  }

  // "Chat about this": recusa a pergunta pra conversar (FINAL).
  function respondTuiChat() {
    if (!canRespondTui || menuFp == null) return
    const fresh = freshMenuMatches()
    const keys = fresh ? buildChatKeys(fresh) : []
    if (keys.length === 0) return
    setTuiSent({ fp: menuFp, label: 'Chat about this', resolvedCount })
    sendKeys(keys)
  }

  // Navegação de aba: nunca é resposta final (não marca tuiSent) — só move o
  // cursor entre perguntas/Submit da barra de abas.
  function respondTuiTabNav(direction: 'next' | 'prev') {
    if (!canRespondTui || !tuiMenu?.tabs) return
    const fresh = freshMenuMatches()
    const keys = fresh ? buildQuestionTabKeys(fresh, direction) : []
    if (keys.length > 0) sendKeys(keys)
  }

  // Multi-select PURO (Bug 3): botão dedicado "Enviar respostas" — over-navega
  // até "Submit" (buildMultiSelectSubmitKeys clampa, não depende de saber a
  // aba atual) + Enter, que É o passo que faltava pra sair da tela de
  // checkboxes. Resposta FINAL, marca tuiSent. Não oferecido em multi-pergunta
  // (tabs de perguntas — esse fluxo já resolve via digit-por-pergunta).
  // 2.1.317+: ↓ até a linha "Submit" e Enter, que abre a revisão (QuestionReviewCard).
  // Sem a linha (versões antigas), o caminho por abas de antes.
  function respondTuiSubmitMulti() {
    if (!canRespondTui || !tuiMenu?.multiSelect || !tuiMenu.tabs || menuFp == null) return
    const fresh = freshMenuMatches()
    if (!fresh?.tabs) return
    const keys = fresh.submitRow ? buildMultiSubmitKeys(fresh) : buildMultiSelectSubmitKeys(fresh.tabs.length)
    if (keys.length === 0) return
    setTuiSent({ fp: menuFp, resolvedCount })
    sendKeys(keys, fresh.submitRow ? QUESTION_KEY_DELAY_MS : undefined)
  }

  // Tela de revisão final: dígito 1 (Submit answers) ou 2 (Cancel) — resposta
  // FINAL de todo o fluxo de abas, marca tuiSent. O dígito vem do RE-PARSE
  // (não do menu do estado), mesma cautela do plano.
  function respondTuiReview(decision: 'submit' | 'cancel') {
    if (!canRespondTui || !tuiReview || menuFp == null) return
    const fresh = freshMenuMatches()
    if (!fresh) return
    const keys = buildReviewKeys(fresh, decision)
    if (keys.length === 0) return
    setTuiSent({ fp: menuFp, resolvedCount })
    sendKeys(keys)
  }

  // Menu genérico: opção (dígito ou setas+Enter, ver buildGenericSelectKeys) e Esc são
  // finais pra este menu — um submenu que abrir é outro fingerprint. Aba é passo.
  function respondGeneric(action: { kind: 'select'; optionIndex: number } | { kind: 'esc' }) {
    if (!canRespondTui || menuFp == null) return
    const fresh = freshMenuMatches()
    const keys = fresh ? keysForAction(fresh, action) : []
    if (keys.length === 0) return
    setTuiSent({ fp: menuFp, resolvedCount })
    sendKeys(keys)
    if (action.kind === 'select' && restoresConversation(fresh!, action.optionIndex)) {
      rewind.announce(RESTORED_NOTICE)
      setRestoredAt(diskKey)
    }
  }
  function respondGenericInput(optionIndex: number, text: string) {
    if (!canRespondTui || menuFp == null) return
    const fresh = freshMenuMatches()
    const action = { kind: 'other' as const, optionIndex, text }
    const keys = fresh ? keysForAction(fresh, action) : []
    if (keys.length === 0) return
    setTuiSent({ fp: menuFp, resolvedCount })
    sendKeys(keys, actionKeyDelay(fresh!, action))
  }
  // Passo: o cursor anda até a janela rolar; o menu segue aberto (sem tuiSent).
  function respondGenericScroll(direction: 'up' | 'down') {
    if (!canRespondTui) return
    const fresh = freshMenuMatches()
    const keys = fresh ? buildGenericScrollKeys(fresh, direction) : []
    if (keys.length > 0) sendKeys(keys)
  }
  function respondGenericTab(direction: 'next' | 'prev') {
    if (!canRespondTui) return
    const fresh = freshMenuMatches()
    const keys = fresh ? keysForAction(fresh, { kind: 'tab', direction }) : []
    if (keys.length > 0) sendKeys(keys)
  }

  function respondTuiPlan(d: PlanDecision, feedback?: string) {
    if (!canRespondTui || menuFp == null) return
    const fresh = freshMenuMatches()
    if (!fresh) {
      setPlanNotice('O diálogo mudou no terminal — confira as opções de novo.')
      return
    }
    // O dígito vem do RE-PARSE (não do menu do estado): se a opção sumiu/mudou de
    // posição, buildPlanKeys devolve [] e nada é enviado.
    const keys = buildPlanKeys(fresh, d, feedback)
    if (keys.length === 0) {
      setPlanNotice(
        d === 'feedback'
          ? 'O campo de mudanças no terminal já tem texto: envie ou apague por lá.'
          : 'Essa opção não está mais no diálogo.',
      )
      return
    }
    setTuiSent({ fp: menuFp, resolvedCount })
    sendKeys(keys, keys.length > 1 ? PLAN_KEY_DELAY_MS : undefined)
    const mode = planApprovalMode(fresh, d)
    if (mode) onPlanApproved?.(mode)
  }

  // ── Pickers de /model, /theme, /config e busca de histórico (Ctrl+R) ──────
  // Família separada do menu TUI acima: layout de tela diferente (tabs, caixa
  // de busca, effort/preview inline), sem gate de status (são UI local do
  // CLI, disparada pelo próprio usuário — não há ambiguidade com "aguardando
  // Claude" que justifique restringir por status, ao contrário do trio da
  // Fase 1).
  const pickerFp = tuiPicker ? pickerFingerprint(tuiPicker) : null
  const [pickerSent, setPickerSent] = useState<{ fp: string } | null>(null)

  useEffect(() => {
    if (pickerSent && pickerFp !== pickerSent.fp) setPickerSent(null)
  }, [pickerFp, pickerSent])

  const canRespondPicker = onRespond != null && tuiPicker != null && pickerSent == null

  function freshPickerMatches(): TuiPicker | null {
    const fresh = reparsePicker?.() ?? null
    if (!fresh || pickerFp == null || pickerFingerprint(fresh) !== pickerFp) return null
    return fresh
  }

  // /model: clique numa opção navega (setas) + Enter aplica — composto em
  // buildPickerSelectKeys a partir do highlight ATUAL do re-parse fresco.
  function respondModelSelect(targetIndex: number) {
    if (!canRespondPicker) return
    const fresh = freshPickerMatches()
    if (!fresh || fresh.kind !== 'model') return
    onRespond?.(buildPickerSelectKeys(fresh.highlightIndex, targetIndex))
  }
  // Effort é um eixo à parte (←/→) — nunca resposta final, não marca sent.
  function respondModelEffort(direction: 'left' | 'right') {
    if (!canRespondPicker || !freshPickerMatches()) return
    onRespond?.(buildArrowKeys(direction))
  }
  function respondModelApply() {
    if (!canRespondPicker || pickerFp == null || !freshPickerMatches()) return
    setPickerSent({ fp: pickerFp })
    onRespond?.(buildEnterKey())
  }
  function respondModelCancel() {
    if (!canRespondPicker || pickerFp == null || !freshPickerMatches()) return
    setPickerSent({ fp: pickerFp })
    onRespond?.(buildEscKey())
  }

  // /theme: mesmo padrão de navegação por seta do /model.
  function respondThemeSelect(targetIndex: number) {
    if (!canRespondPicker) return
    const fresh = freshPickerMatches()
    if (!fresh || fresh.kind !== 'theme') return
    onRespond?.(buildPickerSelectKeys(fresh.highlightIndex, targetIndex))
  }
  function respondThemeTogglePreview() {
    if (!canRespondPicker || !freshPickerMatches()) return
    onRespond?.(buildCtrlTKey())
  }
  function respondThemeApply() {
    if (!canRespondPicker || pickerFp == null || !freshPickerMatches()) return
    setPickerSent({ fp: pickerFp })
    onRespond?.(buildEnterKey())
  }
  function respondThemeCancel() {
    if (!canRespondPicker || pickerFp == null || !freshPickerMatches()) return
    setPickerSent({ fp: pickerFp })
    onRespond?.(buildEscKey())
  }

  // /config: nenhuma ação aqui é "final" (o dialog fecha só depois de 1-3 Esc
  // em sequência) — nunca marca pickerSent, o card renderiza de novo a cada
  // re-parse até o picker sumir do buffer.
  function respondConfigFilter(text: string) {
    if (!canRespondPicker || !freshPickerMatches()) return
    onRespond?.(buildFilterKeys(text))
  }
  // Navega do item destacado ATUAL (re-parse fresco) até o alvo + Space
  // alterna. Sem highlight ainda (foco na busca) → 1 down primeiro (valida:
  // busca→lista pousa no primeiro item), depois navega a partir dele.
  function respondConfigToggle(targetIndex: number) {
    if (!canRespondPicker) return
    const fresh = freshPickerMatches()
    if (!fresh || fresh.kind !== 'config') return
    const keys: string[] = []
    let fromIndex = fresh.items.findIndex((i) => i.highlighted)
    if (fromIndex < 0) {
      keys.push(...buildArrowKeys('down', 1))
      fromIndex = 0
    }
    const delta = targetIndex - fromIndex
    if (delta !== 0) keys.push(...buildArrowKeys(delta > 0 ? 'down' : 'up', Math.abs(delta)))
    keys.push(...buildSpaceKey())
    onRespond?.(keys)
  }
  function respondConfigFocusSearch() {
    if (!canRespondPicker || !freshPickerMatches()) return
    onRespond?.(['/'])
  }
  function respondConfigClose() {
    if (!canRespondPicker || !freshPickerMatches()) return
    onRespond?.(buildEscKey())
  }

  // Ctrl+R: digitar, andar e trocar o escopo são passos (a busca segue aberta, o
  // fingerprint muda a cada tecla), então só exigem que a mesma busca siga na tela.
  // Aceitar, preencher e cancelar fecham a busca: guard estrito, como os outros pickers.
  function freshHistory(): TuiHistorySearch | null {
    const fresh = reparsePicker?.() ?? null
    if (fresh?.kind !== 'history_search' || tuiPicker?.kind !== 'history_search') return null
    return fresh.mode === tuiPicker.mode ? fresh : null
  }
  // false = nada foi escrito (busca fechou, ou o PTY recusou porque outra resposta tocava).
  async function historyStep(keysOf: (p: TuiHistorySearch) => string[]): Promise<boolean> {
    if (!canRespondPicker || !onRespond) return false
    const fresh = freshHistory()
    if (!fresh) return false
    const keys = keysOf(fresh)
    if (keys.length === 0) return true
    return (await onRespond(keys)) !== false
  }
  function historyFinal(keysOf: (p: TuiHistorySearch) => string[]) {
    if (!canRespondPicker || pickerFp == null) return
    const fresh = freshPickerMatches()
    const keys = fresh?.kind === 'history_search' ? keysOf(fresh) : []
    if (keys.length === 0) return
    setPickerSent({ fp: pickerFp })
    onRespond?.(keys)
  }

  // "Voltar a este ponto": a posição da mensagem a partir do fim é a parada do seletor do
  // /rewind (uma por mensagem do usuário, a última antes de "(current)"). O seletor ainda
  // confere o texto na tela antes do Enter (useRewind).
  const rewind = useRewind({ status, onRespond, reparseMenu, pickerOpen: tuiPicker != null, readCliInput })
  const userFromEnd = useMemo(() => {
    const out = new Map<number, number>()
    let n = 0
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].kind === 'user') out.set(i, ++n)
    }
    return out
  }, [messages])
  const chatPrompts = useMemo(
    () => messages.flatMap((m) => (m.kind === 'user' ? [m.text] : [])),
    [messages],
  )
  const rewindDisabled = rewind.busy
    ? 'Abrindo o rewind…'
    : status !== 'idle'
      ? 'Disponível com o Claude parado'
      : tuiMenu != null || tuiPicker != null
        ? 'Feche o diálogo aberto antes'
        : restoredAt != null
          ? 'O chat ainda mostra o que o terminal desfez: mande a próxima mensagem antes'
          : cliDraft
          ? 'A caixa do terminal tem texto'
          : null
  const rewindNoticeNode = rewind.notice ? (
    <div
      data-testid="rewind-notice"
      className="flex items-start gap-2 rounded-md border border-[var(--color-border)] px-3 py-2 text-xs text-[var(--color-text-dim)]"
    >
      <span className="flex-1">{rewind.notice}</span>
      <button type="button" onClick={rewind.dismiss} className="text-[var(--color-text-dim)] hover:text-[var(--color-text)]">
        Ok
      </button>
    </div>
  ) : null
  const cliDraftNode =
    cliDraft && tuiMenu == null && tuiPicker == null ? (
      <CliDraftBanner
        draft={cliDraft}
        onSend={onRespond && status === 'idle' ? () => sendCliDraft(cliDraft) : undefined}
        onClear={onRespond && status === 'idle' ? () => clearCliDraft(cliDraft) : undefined}
      />
    ) : null
  // Só com o mesmo texto ainda na caixa: Enter vazio não faz nada, mas Esc-Esc com a caixa
  // vazia abriria o rewind.
  function sendCliDraft(draft: string) {
    if (readCliInput?.().draft !== draft) return
    onRespond?.(['\r'])
  }
  function clearCliDraft(draft: string) {
    if (readCliInput?.().draft !== draft) return
    onRespond?.(['\x1b', '\x1b'], 200)
  }

  const tuiPickerCardNode = tuiPicker ? (
    <>
      {tuiPicker.kind === 'model' && (
        <ModelPickerCard
          options={tuiPicker.options}
          highlightIndex={tuiPicker.highlightIndex}
          effortLabel={tuiPicker.effortLabel}
          onSelect={canRespondPicker ? respondModelSelect : undefined}
          onEffort={canRespondPicker ? respondModelEffort : undefined}
          onApply={canRespondPicker ? respondModelApply : undefined}
          onCancel={canRespondPicker ? respondModelCancel : undefined}
          sent={pickerSent != null && pickerSent.fp === pickerFp}
        />
      )}
      {tuiPicker.kind === 'theme' && (
        <ThemePickerCard
          options={tuiPicker.options}
          highlightIndex={tuiPicker.highlightIndex}
          preview={tuiPicker.preview}
          syntaxTheme={tuiPicker.syntaxTheme}
          previewOn={tuiPicker.previewOn}
          onSelect={canRespondPicker ? respondThemeSelect : undefined}
          onTogglePreview={canRespondPicker ? respondThemeTogglePreview : undefined}
          onApply={canRespondPicker ? respondThemeApply : undefined}
          onCancel={canRespondPicker ? respondThemeCancel : undefined}
          sent={pickerSent != null && pickerSent.fp === pickerFp}
        />
      )}
      {tuiPicker.kind === 'config' && (
        <ConfigCard
          tabs={tuiPicker.tabs}
          activeTab={tuiPicker.activeTab}
          searchQuery={tuiPicker.searchQuery}
          searchFocused={tuiPicker.searchFocused}
          items={tuiPicker.items}
          hasMoreBelow={tuiPicker.hasMoreBelow}
          onFilter={canRespondPicker ? respondConfigFilter : undefined}
          onToggle={canRespondPicker ? respondConfigToggle : undefined}
          onFocusSearch={canRespondPicker ? respondConfigFocusSearch : undefined}
          onClose={canRespondPicker ? respondConfigClose : undefined}
        />
      )}
      {tuiPicker.kind === 'history_search' && (
        <HistorySearchCard
          picker={tuiPicker}
          onQuery={canRespondPicker ? (prev, next) => historyStep(() => historyQueryKeys(prev, next)) : undefined}
          onOlder={canRespondPicker ? () => void historyStep(historyOlderKeys) : undefined}
          onNewer={canRespondPicker ? () => void historyStep(historyNewerKeys) : undefined}
          onSelect={canRespondPicker ? (i) => void historyStep((p) => historySelectKeys(p, i)) : undefined}
          onScope={canRespondPicker ? () => void historyStep(historyScopeKeys) : undefined}
          onAccept={canRespondPicker ? () => historyFinal(historyAcceptKeys) : undefined}
          onFill={canRespondPicker ? () => historyFinal(historyFillKeys) : undefined}
          onCancel={canRespondPicker ? () => historyFinal(historyCancelKeys) : undefined}
          sent={pickerSent != null && pickerSent.fp === pickerFp}
        />
      )}
    </>
  ) : null

  // Espera que o chat não consegue representar: 'waiting' sem card do transcript
  // nem do menu TUI (que tem precedência sobre o banner).
  const waitInTerminal =
    showTerminalWaitBanner({
      status,
      pending: pendingPrompt,
      answeredElsewhere: menuAnsweredElsewhere,
    }) && !showTuiCard

  const viewState: ChatViewState = stale ? 'loading' : resolveChatViewState({
    loading,
    transcriptExists,
    messageCount: rendered.length,
  })

  /* Card pendente sintetizado do menu TUI do buffer (permission/trust nunca chegam
     ao JSONL). Renderiza também pré-transcript: o trust aparece antes da 1ª mensagem. */
  const tuiCardNode = showTuiCard ? (
    <>
      {tuiMenu?.kind === 'question' && tuiQuestion && (
        <QuestionCard
          questions={tuiQuestion.questions}
          onRespond={canRespondTui && !tuiMenu.multiSelect ? respondTuiQuestion : undefined}
          onToggle={canRespondTui && tuiMenu.multiSelect ? respondTuiToggle : undefined}
          onOtherSubmit={canRespondTui ? respondTuiOther : undefined}
          sentLabel={tuiSent && tuiSent.fp === menuFp ? tuiSent.label : undefined}
          tabs={tuiMenu.tabs}
          onTabNav={canRespondTui && tuiMenu.tabs ? respondTuiTabNav : undefined}
          onSubmitMulti={
            canRespondTui && tuiMenu.multiSelect && tuiMenu.tabs ? respondTuiSubmitMulti : undefined
          }
          onChat={
            canRespondTui && tuiMenu.options.some((o) => o.sentinel === 'chat')
              ? respondTuiChat
              : undefined
          }
        />
      )}
      {tuiReview && (
        <QuestionReviewCard
          summary={tuiReview.context}
          onDecide={canRespondTui ? respondTuiReview : undefined}
          sent={tuiSent != null && tuiSent.fp === menuFp}
        />
      )}
      {tuiMenu?.kind === 'plan' && (
        <PlanCard
          plan={pendingPlanText ?? PLAN_PLACEHOLDER}
          onDecide={canRespondTui ? respondTuiPlan : undefined}
          sent={tuiSent != null && tuiSent.fp === menuFp}
          choices={tuiPlanChoices}
          canFeedback={planAcceptsFeedback(tuiMenu)}
          notice={planNotice}
        />
      )}
      {tuiGeneric && (
        <GenericMenuCard
          menu={tuiGeneric}
          onSelect={canRespondTui ? (optionIndex) => respondGeneric({ kind: 'select', optionIndex }) : undefined}
          onInput={canRespondTui ? respondGenericInput : undefined}
          onScroll={canRespondTui ? respondGenericScroll : undefined}
          onEsc={canRespondTui ? () => respondGeneric({ kind: 'esc' }) : undefined}
          onTab={canRespondTui ? respondGenericTab : undefined}
          sent={tuiSent != null && tuiSent.fp === menuFp}
        />
      )}
      {tuiPermission && (
        // Resposta pelo caminho guardado do main (não depende do xterm desta view).
        <PermissionCard
          menu={tuiPermission}
          onDecide={permission.decide}
          sentLabel={permission.sentLabel}
          notice={permission.notice}
          childRule={permission.childRule}
        />
      )}
    </>
  ) : null

  // Só o que chega DEPOIS da primeira pintura entra animado: abrir uma conversa
  // longa não pode virar uma cascata de 500 linhas subindo.
  if (viewState === 'ready' && firstCountRef.current === null)
    firstCountRef.current = rendered.length

  function renderMessage(m: ChatMessage, i: number) {
    // Ecos otimistas vêm DEPOIS das mensagens de disco; marcamos como pendentes.
    const echoPending = i >= messages.length
    if (artifactPlan.hidden.has(i)) return null
    const artifactCard = artifactPlan.cards.get(i)
    if (artifactCard) {
      return (
        <ArtifactCard
          key={i}
          plan={artifactCard}
          onShowSide={sideEnabled ? (ref) => showArtifactSide(sessionId, ref) : undefined}
          sideActive={sideKey === artifactRefKey(artifactCard.ref)}
        />
      )
    }
    const consult = artifactPlan.consults.get(i)
    if (consult) {
      return (
        <ArtifactConsultChip
          key={i}
          plan={consult}
          onShowSide={sideEnabled ? (ref) => showArtifactSide(sessionId, ref) : undefined}
        />
      )
    }
    switch (m.kind) {
      case 'user': {
        const wake = parseHandoffWakeEnvelope(m.text)
        if (wake) return <HandoffUpdateCard key={i} envelope={wake} />
        const fromEnd = userFromEnd.get(i)
        return (
          <MessageBubble
            key={i}
            role="user"
            text={m.text}
            pending={echoPending}
            onRewind={rewind.available && fromEnd != null ? () => void rewind.start({ text: m.text, fromEnd, chat: chatPrompts }) : undefined}
            rewindDisabled={rewindDisabled}
          />
        )
      }
      case 'assistant':
        return <MessageBubble key={i} role="assistant" text={m.text} interrupted={m.interrupted} />
      case 'thinking':
        return <ThinkingCard key={i} text={m.text} />
      case 'system':
        return (
          <SystemCard
            key={i}
            label={m.label}
            detail={m.detail}
            level={m.level}
            trigger={m.trigger}
            preTokens={m.preTokens}
            postTokens={m.postTokens}
          />
        )
      case 'compact_summary':
        return <CompactSummaryCard key={i} text={m.text} />
      case 'model_change':
        return <ModelChangeChip key={i} from={m.from} to={m.to} />
      case 'command':
        return <CommandCard key={i} name={m.name} args={m.args} />
      case 'command_output':
        return <CommandOutputCard key={i} text={m.text} />
      case 'meta':
        return <MetaCard key={i} text={m.text} label={m.label} />
      // tool_use comum vira linha de grupo (buildChatRows); aqui só chega o que
      // tem card de artefato, já despachado acima.
      case 'tool_use':
        return null
      case 'subagent':
        return (
          <SubagentCard
            key={i}
            name={m.name}
            description={m.description}
            turnCount={m.turnCount}
            turns={m.turns}
            status={
              interactive.subagents.has(m.id)
                ? interactive.subagents.get(m.id)
                  ? 'error'
                  : 'ok'
                : undefined
            }
          />
        )
      case 'tool_result':
        return (
          <ToolResultCard
            key={i}
            content={m.content}
            isError={m.isError}
            interrupted={m.interrupted}
          />
        )
      // O momento pendente (clicável) vem do menu TUI parseado do buffer. Quando o
      // tool_use pendente já chegou ao JSONL, o card do menu vivo o substitui.
      case 'ask_user_question':
        if (m.id === coveredPendingId) return null
        return (
          <QuestionCard key={i} questions={m.questions} answers={interactive.answers.get(m.id)} />
        )
      case 'exit_plan_mode':
        if (m.id === coveredPendingId) return null
        return (
          <TranscriptPlanCard
            key={i}
            plan={
              (m.id === heldPending?.id && heldPending.plan) ||
              decidedPlanText(m.id, interactive, shownPlanRef.current) ||
              m.plan
            }
            planFilePath={m.planFilePath}
            decision={interactive.plans.get(m.id)}
            sent={m.id === heldPending?.id}
          />
        )

      // Resposta/decisão/status são fundidos no card acima (por forId) — não
      // renderizam sozinhos.
      case 'ask_user_question_answered':
      case 'plan_decision':
      case 'subagent_result':
        return null
    }
  }

  let prevRhythm: RowRhythm | null = null

  if (viewState !== 'ready') {
    return (
      <ChatEmptyState viewState={viewState} hint={emptyHint}>
        {/* Prompt TTY-only pré-transcript (ex.: trust de diretório): o card
            precisa aparecer MESMO sem nenhuma mensagem — é o que destrava a
            sessão pra própria conversa nascer. */}
        {tuiCardNode && <div className="w-full max-w-3xl text-left">{tuiCardNode}</div>}
        {tuiPickerCardNode && <div className="w-full max-w-3xl text-left">{tuiPickerCardNode}</div>}
        {rewindNoticeNode && <div className="w-full max-w-3xl text-left">{rewindNoticeNode}</div>}
        {cliDraftNode && <div className="w-full max-w-3xl text-left">{cliDraftNode}</div>}
      </ChatEmptyState>
    )
  }

  return (
    <div ref={rootRef} className="absolute inset-0 z-10 flex bg-[var(--color-bg)]">
      <div className="relative flex min-w-0 flex-1 flex-col">
        <PendingElsewhereChip sessionId={sessionId} />
        <div
          ref={scrollRef}
          onScroll={onScroll}
          className="min-h-0 flex-1 overflow-y-auto py-[18px]"
          style={{
            background:
              'radial-gradient(90% 40% at 50% 0%, color-mix(in srgb, var(--color-accent) 5%, transparent), transparent 60%)',
          }}
        >
          <div
            ref={contentRef}
            className="mx-auto flex w-full min-w-0 max-w-[780px] flex-col gap-3.5 px-6 @container/chat"
          >
            <div className="flex min-w-0 flex-col">
              {rows.map((row, r) => {
                const node =
                  row.type === 'tools' ? (
                    <ToolGroup
                      entries={row.entries}
                      running={r === runningRow}
                    />
                  ) : (
                    renderMessage(rendered[row.index], row.index)
                  )
                if (node == null) return null
                const rhythm = rowRhythm(row, rendered)
                const spacing = rowSpacing(prevRhythm, rhythm)
                prevRhythm = rhythm
                const isNew = firstCountRef.current != null && row.index >= firstCountRef.current
                return (
                  <div
                    key={row.index}
                    className={`min-w-0 ${spacing} ${isNew ? 'chat-row-in' : ''}`}
                  >
                    {node}
                  </div>
                )
              })}
            </div>
            {rewindNoticeNode}
            {tuiCardNode}
            {tuiPickerCardNode}
            {cliDraftNode}
            <ChatWaitBanners
              pendingPrompt={showTuiCard || heldPending ? null : pendingPrompt}
              waitInTerminal={waitInTerminal}
              menuKind={tuiMenu?.kind}
              onToggleMode={onToggleMode}
            />
            {/* Indicador discreto de atividade. Suprimido quando há um prompt pendente
            (status 'waiting'), pra não competir com o banner acima. */}
            {status === 'working' && (!pendingPrompt || heldPending) && workingSince != null && (
              <WorkingIndicator since={workingSince} thinking={lastIsThinking} />
            )}
          </div>
        </div>
        {!stuck && <JumpToLatest unseen={unseen} onClick={jumpToLatest} />}
        <ChatStatusStrip
          status={status}
          subagentName={lastSubagent?.name}
          subagentError={lastSubagent?.error}
        />
      </div>
      {sideEnabled && <ArtifactSidePanel sessionId={sessionId} />}
    </div>
  )
})
