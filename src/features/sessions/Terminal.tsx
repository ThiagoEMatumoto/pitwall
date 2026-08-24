import '@xterm/xterm/css/xterm.css'

import { useEffect, useRef, useState } from 'react'
import { Terminal as Xterm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { SearchAddon } from '@xterm/addon-search'
import { ClipboardAddon } from '@xterm/addon-clipboard'
import { WebglAddon } from '@xterm/addon-webgl'
import { gpuApi, sessionsApi } from '@/lib/ipc'
import { matchCombo, resolveCombo } from '@/lib/keybindings'
import { useKeybindingsStore } from '@/lib/keybindings-store'
import { useAppStore, type PaneMode } from '@/store/appStore'
import { showToast } from '@/features/notifications/toast-store'
import { useSession } from './useSession'
import { Composer, type ComposerHandle } from './Composer'
import { ComposerToolbar } from './ComposerToolbar'
import { SessionHeader } from './SessionHeader'
import { BatonDialog } from './BatonDialog'
import { AdoptSessionDialog } from '@/features/handoffs/AdoptSessionDialog'
import { childSessionIds, useHandoffsStore } from '@/store/handoffsStore'
import { AgentHud } from './AgentHud'
import { ChatView, type ChatViewHandle } from './chat/ChatView'
import { playKeys } from './chat/respond-keys'
import { buildPromptBytes } from './chat/prompt-bytes'
import { MODEL_ALIASES, EFFORT_LEVELS, type ModelAlias, type EffortLevel } from './ModelPill'
import { MODEL_LABELS } from '../../../shared/models'
import { mergePending, nextPendingApply, type PendingSelection } from './model-queue'
import { detectFooterMode, shouldNotifyModeChange } from './permission-mode-parser'
import { permissionModeLabel } from './permission-modes'
import { jumpDecision } from './permission-jump'
import { gateMenuByStatus, menuFingerprint, parseTuiMenu, type TuiMenu } from './tui-menu-parser'
import { parseTuiPicker, pickerFingerprint, type TuiPicker } from './tui-picker-parser'
import { parseWithGrowingWindow } from './tui-read-window'
import { modelSupportsXhigh } from './model-context-limits'
import { useTerminalPrefsStore } from '@/lib/terminal-prefs-store'
import { TERMINAL_FONT_FAMILY } from '@/lib/terminal-font'
import { useFilesStore } from '@/lib/files-store'
import { xtermTheme } from '@/lib/themes'
import { getCurrentThemeTokens, onThemeChange } from '@/app/useTheme'
import type { GpuStatus, PermissionMode, Session, SessionActivity } from '../../../shared/types/ipc'

// Cache módulo-level: o status de GPU é imutável durante o processo (decidido no
// boot do main), então 1 IPC atende todos os panes/remounts.
let gpuStatusPromise: Promise<GpuStatus> | null = null
function getGpuStatus(): Promise<GpuStatus> {
  gpuStatusPromise ??= gpuApi.status()
  return gpuStatusPromise
}

// Espera máxima pela woff2 no gate de open do Terminal — vencido o timeout, abre
// com a fallback e o safety net (document.fonts.ready) re-mede quando ela chegar.
const FONT_LOAD_TIMEOUT_MS = 800

// Cap global de contextos WebGL vivos: o Chromium limita ~16 contextos WebGL por
// processo — estourar derruba o contexto mais antigo (outra pane). Acima do cap
// a pane fica no DOM renderer (v1: sem promoção automática ao liberar slot).
const MAX_WEBGL_INSTANCES = 8
let liveWebglCount = 0

interface Props {
  session: Session
  repoLabel: string
  repoPath: string
  projectName: string
  projectIcon?: string | null
  projectColor?: string | null
  // Display da pane (híbrido): 'terminal' mostra o xterm; 'chat' mostra o ChatView
  // renderizado do transcript com o xterm/PTY vivo por baixo. Default 'terminal'.
  mode?: PaneMode
  onToggleMode?: () => void
  // Moldura em volta do terminal. 'full' (default) traz o SessionHeader completo
  // — identidade, rename, minimizar, ENCERRAR. 'bare' omite o header inteiro: é
  // o modo de quem já tem uma moldura própria por fora (o quick look da equipe),
  // e onde encerrar a sessão NÃO deve estar a um clique de distância num fluxo
  // de "só vou dar uma olhada".
  chrome?: 'full' | 'bare'
  onClose: () => void
  onTitleChange?: (title: string) => void
  onReopen?: () => void
  onOpenSettings?: () => void
}

// Casa paths impressos no terminal: absolutos (/...), home (~/...) e relativos
// (./..., ../..., ou sem prefixo). Exige conter `/` (o `\/` no meio garante isso).
const PATH_RE = /(?:~|\.{1,2})?\/[\w./\-+@]+/g
// Pontuação de fim de frase grudada no path não faz parte dele.
const TRAILING = /[.,:;)\]}>'"]+$/

// Resolução simples de path no renderer (sem `path` do node): junta um path
// relativo ao cwd e colapsa segmentos `.`/`..`. Não toca em absolutos/`~`.
function resolvePath(raw: string, cwd: string | null): string | null {
  if (raw.startsWith('/') || raw.startsWith('~')) return raw
  if (!cwd) return null
  const base = cwd.replace(/\/+$/, '')
  const parts = `${base}/${raw}`.split('/')
  const out: string[] = []
  for (const seg of parts) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') out.pop()
    else out.push(seg)
  }
  return '/' + out.join('/')
}

// Lê as últimas `n` linhas do buffer do xterm como texto plano (uma linha por \n,
// trim à direita). IBuffer.length = total de linhas (scrollback + viewport), com
// getLine 0-based — o tail são as linhas [length - n, length). É a fonte de texto
// pra detectar o modo de permissão E pra parsear o menu TUI pendente (a TUI
// desenha pergunta + opções no fundo do buffer).
function readTailText(term: Xterm, n = 40): string {
  const buf = term.buffer.active
  let text = ''
  for (let y = Math.max(0, buf.length - n); y < buf.length; y++) {
    const line = buf.getLine(y)
    if (line) text += line.translateToString(true) + '\n'
  }
  return text
}

// Rodapé da TUI (input box / status lines): as últimas linhas do VIEWPORT, pra
// detectar o modo de permissão ATUAL (inclusive 'default', sem indicador) sem
// depender de bytes acumulados do PTY. min(rows, 10) preserva a semântica antiga
// (nunca lê acima do viewport quando o terminal tem menos de 10 rows).
function readFooterText(term: Xterm): string {
  return readTailText(term, Math.min(term.rows, 10))
}

export function Terminal({
  session,
  repoLabel,
  repoPath,
  projectName,
  projectIcon,
  projectColor,
  mode = 'terminal',
  onToggleMode,
  chrome = 'full',
  onClose,
  onTitleChange,
  onReopen,
  onOpenSettings,
}: Props) {
  const { exited, exitCode, error, write, resize, setDataHandler } = useSession(session.id)
  const endSession = useAppStore((s) => s.endSession)
  const hostRef = useRef<HTMLDivElement>(null)
  const xtermRef = useRef<Xterm | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const searchRef = useRef<SearchAddon | null>(null)
  const fontSize = useTerminalPrefsStore((s) => s.fontSize)
  const scrollback = useTerminalPrefsStore((s) => s.scrollback)
  // Heurístico de "claude não encontrado": registramos se algum byte chegou do PTY.
  // Se o processo saiu rápido com código != 0 e nunca emitiu nada, provavelmente o
  // comando não foi resolvido (ENOENT) em vez de uma sessão de verdade ter morrido.
  const gotDataRef = useRef(false)
  // Instante do exit, pra medir quanto tempo a sessão viveu (heurístico abaixo).
  const exitAtRef = useRef<number | null>(null)
  // Detecção do modo de permissão: lemos o rodapé REAL renderizado no xterm (detectFooterMode),
  // não bytes acumulados — assim 'default' (sem indicador) é detectável e indicadores velhos não
  // grudam. permTimerRef = debounce; statusRef gateia (não lê durante 'working': rodapé escondido).
  const permTimerRef = useRef<number | null>(null)
  const statusRef = useRef<SessionActivity['status'] | undefined>(undefined)
  // Timer do "pular até o modo alvo" (loop em selectPermission que lê o rodapé do xterm
  // após cada Shift+Tab). Permite cancelar um jump em voo. null = nenhum em curso.
  const jumpTimerRef = useRef<number | null>(null)
  // Último currentMode visto pelo effect de notificação (banner efêmero de transição,
  // ver useEffect abaixo). null = ainda sem baseline (mount ou 1ª detecção real) —
  // shouldNotifyModeChange usa isso pra nunca notificar no carregamento inicial.
  const prevModeForToastRef = useRef<PermissionMode | null>(null)

  const [title, setTitle] = useState<string | null>(null)
  // Origem do título: 'manual' (rename do usuário) nunca é sobrescrito pelo
  // name automático do CC. Local pra refletir o rename na hora, sem refetch.
  const [titleSource, setTitleSource] = useState<Session['titleSource']>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; hasSelection: boolean } | null>(null)
  const [activity, setActivity] = useState<SessionActivity | null>(null)
  // Modo de permissão ativo (lido do rodapé do xterm via detectFooterMode).
  const [currentMode, setCurrentMode] = useState<PermissionMode | null>(null)
  // Menu TUI pendente (AskUserQuestion/aprovação de plano) parseado do tail do
  // buffer do xterm — a fonte do card clicável no modo chat. Só existe com a
  // sessão em 'waiting'; null = sem menu íntegro (fail-closed no parser).
  const [pendingTuiMenu, setPendingTuiMenu] = useState<TuiMenu | null>(null)
  // Picker de /model, /theme, /config ou busca de histórico (Ctrl+R) — Fase 2,
  // parseado em paralelo ao menu TUI (família de tela diferente, sem gate de
  // status: é UI local do CLI, sempre segura de mostrar quando o parse bate).
  const [pendingTuiPicker, setPendingTuiPicker] = useState<TuiPicker | null>(null)
  // Esforço ativo e ultracode são rastreados localmente — não há campo no transcript
  // pra eles. Refletem o último valor que ESTE app injetou (null = ainda não definido).
  const [activeEffort, setActiveEffort] = useState<EffortLevel | null>(null)
  const [ultracodeActive, setUltracodeActive] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [batonOpen, setBatonOpen] = useState(false)
  const [adoptOpen, setAdoptOpen] = useState(false)
  // Adotável = tem transcript no disco (mesmo gate do main). Sem ele, relançar
  // por --resume jogaria a conversa fora — então a ação aparece desabilitada
  // com o motivo, em vez de sumir sem explicar.
  const [hasTranscript, setHasTranscript] = useState(false)
  // Já é filha de um handoff ativo? Adotar de novo criaria um 2º card pro mesmo
  // processo. Boolean derivado (não Set) pra não re-renderizar à toa.
  const isCrewChild = useHandoffsStore((s) => childSessionIds(s.handoffs).has(session.id))
  const composerRef = useRef<ComposerHandle>(null)
  const chatViewRef = useRef<ChatViewHandle>(null)
  // WebGL addon vivo deste mount (null = DOM renderer). Ref (não var local do
  // effect) pra outros effects (heal em resume/focus, crash de GPU) alcançarem.
  const webglRef = useRef<WebglAddon | null>(null)
  // Contexto WebGL já morreu neste mount? Nunca recriar (padrão VS Code): um
  // driver que perdeu contexto tende a perder de novo — DOM renderer até remount.
  const webglFailedRef = useRef(false)
  // Guards de attach lidos dentro de callbacks/async: modo atual da pane e
  // visibilidade do host no viewport (IntersectionObserver do mount effect).
  const modeRef = useRef(mode)
  modeRef.current = mode
  const visibleRef = useRef(true)

  // Dispose do WebGL vivo (se houver): devolve ao DOM renderer, repinta a tela
  // toda (remove restos do atlas) e libera o slot do cap global.
  function detachWebgl() {
    const addon = webglRef.current
    if (!addon) return
    webglRef.current = null
    addon.dispose()
    liveWebglCount = Math.max(0, liveWebglCount - 1)
    const term = xtermRef.current
    term?.refresh(0, term.rows - 1)
  }

  // Ativa o renderer WebGL no term JÁ aberto, com todos os guards: GPU ligada,
  // mount não marcado como failed, pane em modo terminal, host visível e slot
  // livre no cap global. Async (status de GPU) — os guards re-checam após o await.
  function attachWebgl() {
    const term = xtermRef.current
    if (!term || !term.element) return // exige term.open() já feito
    if (webglRef.current || webglFailedRef.current) return
    if (modeRef.current === 'chat' || !visibleRef.current) return
    if (liveWebglCount >= MAX_WEBGL_INSTANCES) return
    void getGpuStatus().then((status) => {
      if (status.hwAccelDisabled) return
      // Re-checa: o mount pode ter morrido (StrictMode/unmount), outro caminho
      // pode ter attachado, o modo/visibilidade/cap podem ter mudado no meio.
      if (xtermRef.current !== term) return
      if (webglRef.current || webglFailedRef.current) return
      if (modeRef.current === 'chat' || !visibleRef.current) return
      if (liveWebglCount >= MAX_WEBGL_INSTANCES) return
      try {
        const addon = new WebglAddon()
        addon.onContextLoss(() => {
          // Perda de contexto (driver reset/GPU suspensa): dispose devolve ao DOM
          // e o refresh repinta a tela inteira — sem ele ficam os fragmentos do
          // atlas corrompido. Marca o mount como failed: nunca recriar WebGL aqui.
          webglFailedRef.current = true
          detachWebgl()
          console.warn('[terminal] WebGL context lost — fallback DOM renderer', ccSessionId)
        })
        term.loadAddon(addon)
        webglRef.current = addon
        liveWebglCount += 1
        term.refresh(0, term.rows - 1)
      } catch (err) {
        console.warn('[terminal] WebGL indisponível, seguindo com DOM renderer:', err)
      }
    })
  }

  // cwd da sessão pra resolver paths relativos clicados no terminal. É o path do
  // repo do pane; vazio em sessões avulsas (aí só linkamos absolutos/`~`). Ref pra
  // o link provider ler o valor atual sem recriar o xterm.
  const cwdRef = useRef(repoPath)
  cwdRef.current = repoPath

  // Parse fresco do menu TUI direto do buffer (também exposto ao ChatView como
  // guard de clique — re-parse imediatamente antes de digitar). A janela cresce
  // só quando 40 linhas não bastam: menus altos (preview/wrap) ficavam cortados
  // e o parser fail-closava, empurrando o usuário pro terminal.
  function readTuiMenuFrom(t: Xterm): TuiMenu | null {
    return parseWithGrowingWindow(
      (n) => readTailText(t, n),
      parseTuiMenu,
      t.buffer.active.length,
    )
  }
  function readTuiMenu(): TuiMenu | null {
    const t = xtermRef.current
    return t ? readTuiMenuFrom(t) : null
  }

  // Aplica um parse novo preservando a referência quando o menu não mudou
  // (fingerprint igual) — evita re-render/reset do card a cada burst do PTY.
  function applyTuiMenu(menu: TuiMenu | null) {
    setPendingTuiMenu((prev) =>
      prev && menu && menuFingerprint(prev) === menuFingerprint(menu) ? prev : menu,
    )
  }

  // Parse fresco do picker (/model, /theme, /config, Ctrl+R) direto do
  // buffer — mesmo papel de readTuiMenu, exposto ao ChatView como guard. Mesma
  // janela adaptativa: a lista do /config e o preview do /theme passam de 40
  // linhas com facilidade.
  function readTuiPickerFrom(t: Xterm): TuiPicker | null {
    return parseWithGrowingWindow(
      (n) => readTailText(t, n),
      parseTuiPicker,
      t.buffer.active.length,
    )
  }
  function readTuiPicker(): TuiPicker | null {
    const t = xtermRef.current
    return t ? readTuiPickerFrom(t) : null
  }

  function applyTuiPicker(picker: TuiPicker | null) {
    setPendingTuiPicker((prev) =>
      prev && picker && pickerFingerprint(prev) === pickerFingerprint(picker) ? prev : picker,
    )
  }

  // Menu TUI: parse na TRANSIÇÃO de status. Entrou num status elegível → tenta
  // parsear o que já está desenhado (o debounce do PTY cobre desenhos
  // posteriores); status inelegível → gate devolve null e limpa. 'waiting'
  // aceita qualquer kind; 'starting'/'idle' (pré-transcript, ex.: trust prompt
  // antes do 1º flush do JSONL) só permission/trust — ver gateMenuByStatus.
  useEffect(() => {
    if (exited) {
      setPendingTuiMenu(null)
      setPendingTuiPicker(null)
      return
    }
    applyTuiMenu(gateMenuByStatus(readTuiMenu(), activity?.status))
    applyTuiPicker(readTuiPicker())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activity?.status, exited])

  useEffect(() => {
    setTitle(session.title ?? null)
    setTitleSource(session.titleSource ?? null)
  }, [session.title, session.titleSource])

  // O ccSessionId é o próprio session.id (ver sessions:spawn no main).
  const ccSessionId = session.ccSessionId ?? null

  useEffect(() => {
    if (!ccSessionId || exited) return
    void sessionsApi.watchActivity(ccSessionId)
    const off = sessionsApi.onActivity((a) => {
      if (a.ccSessionId === ccSessionId) {
        setActivity(a)
        statusRef.current = a.status
      }
    })
    return () => {
      off()
      void sessionsApi.unwatchActivity(ccSessionId)
    }
  }, [ccSessionId, exited])

  // Tick para manter o "há Xs" relativo atualizado sem novos broadcasts.
  useEffect(() => {
    if (!activity?.lastActivityAt || exited) return
    const id = setInterval(() => setNow(Date.now()), 5000)
    return () => clearInterval(id)
  }, [activity?.lastActivityAt, exited])

  // Precedência do nome em destaque: rename MANUAL do usuário > name automático
  // do CC (live) > rename salvo no DB > label do repo. Uma vez manual, o name do
  // CC nunca mais reescreve o displayTitle.
  const manualTitle = titleSource === 'manual' ? title : null
  const displayTitle = manualTitle ?? activity?.name ?? title ?? repoLabel
  // A sessão tem nome próprio (não é só o fallback pro label da pasta)? Só então o
  // título é exibido no header — a aba do dockview já mostra o nome da sessão, então
  // sem nome custom o header mostra só o projeto + path (evita o nome repetido).
  // Rename manual conta como nomeada mesmo que coincida com o label do repo.
  const isNamed =
    manualTitle != null ||
    ((activity?.name ?? title) != null && (activity?.name ?? title) !== repoLabel)

  // Reflete o nome legível na aba do dockview. Ref pra callback evita re-disparar
  // quando o wrapper recria onTitleChange a cada render (dep só no displayTitle).
  const onTitleChangeRef = useRef(onTitleChange)
  onTitleChangeRef.current = onTitleChange
  useEffect(() => {
    onTitleChangeRef.current?.(displayTitle)
  }, [displayTitle])

  // Só dá pra injetar /rename quando o claude está no prompt; em 'working' ele
  // está ocupado e a injeção concatenaria no meio de um comando/output.
  const canRename = !activity || activity.status !== 'working'

  // Troca de modelo/esforço é mais restrita que o rename: só em 'idle'. Em
  // 'waiting' pode haver um prompt de permissão aberto — injetar texto ali
  // responderia o prompt errado.
  const canSwitchModel = !exited && activity?.status === 'idle'

  // O modelo ativo suporta xhigh? Gate do 'ultracode' no menu do EffortPill
  // (opus/sonnet sim, haiku não; modelo ainda desconhecido → false).
  const xhighCapable = modelSupportsXhigh(activity?.model ?? null)

  // Injeção sanitizada: os valores vêm EXCLUSIVAMENTE das whitelists literais
  // do ModelPill — nunca texto livre. \x15 (Ctrl+U) limpa a linha do prompt
  // antes, pra não concatenar com algo já digitado (mesmo padrão do /rename).
  // Ponto único de injeção de /model (troca imediata e flush da fila de
  // pendências abaixo passam por aqui) — o toast dispara pros dois casos.
  function injectModel(alias: ModelAlias) {
    if (!MODEL_ALIASES.includes(alias)) return
    write('\x15/model ' + alias + '\r')
    showToast({
      title: `Trocando para ${MODEL_LABELS[alias]}`,
      body: 'A troca de modelo pode disparar um /compact automático da conversa.',
    })
  }
  function injectEffort(level: EffortLevel) {
    if (EFFORT_LEVELS.includes(level)) write('\x15/effort ' + level + '\r')
  }
  // 'ultracode' é um comando literal (não interpola texto livre) — mesmo padrão de
  // \x15 (Ctrl+U) pra limpar a linha antes. Exige modelo xhigh-capable (gate no menu).
  function injectUltracode() {
    write('\x15/effort ultracode\r')
  }

  // Troca enfileirada enquanto a sessão está ocupada; aplicada no próximo idle.
  const [pending, setPending] = useState<PendingSelection>({})
  const pendingRef = useRef(pending)
  pendingRef.current = pending
  const prevStatusRef = useRef<SessionActivity['status'] | null>(null)

  // Em idle injeta direto; ocupada, enfileira (última troca de cada tipo vence).
  function selectModel(alias: ModelAlias) {
    if (!MODEL_ALIASES.includes(alias)) return
    if (canSwitchModel) injectModel(alias)
    else setPending((p) => mergePending(p, { model: alias }))
  }
  // Cobre os níveis de --effort e o pseudo-nível nativo 'ultracode'. São mutuamente
  // exclusivos: escolher um nível numérico desliga o ultracode e vice-versa. Em idle
  // injeta direto; ocupada, enfileira (aplicado no próximo idle pelo flush abaixo).
  function selectEffort(level: EffortLevel | 'ultracode') {
    if (level === 'ultracode') {
      if (canSwitchModel) {
        injectUltracode()
        setUltracodeActive(true)
      } else {
        setPending((p) => mergePending(p, { effort: undefined, ultracode: true }))
      }
      return
    }
    if (!EFFORT_LEVELS.includes(level)) return
    if (canSwitchModel) {
      injectEffort(level)
      setActiveEffort(level)
      setUltracodeActive(false)
    } else {
      setPending((p) => mergePending(p, { effort: level, ultracode: false }))
    }
  }

  // Flush da fila na transição → idle (único estado seguro p/ injetar), uma vez.
  // Lê a pendência via ref pra não re-rodar quando ela muda — só na troca de status.
  useEffect(() => {
    const prev = prevStatusRef.current
    const current = activity?.status ?? null
    prevStatusRef.current = current
    if (exited) return
    const { apply, pending: rest } = nextPendingApply(prev, current, pendingRef.current)
    if (!apply) return
    if (apply.model) injectModel(apply.model)
    if (apply.effort) {
      injectEffort(apply.effort)
      setActiveEffort(apply.effort)
      setUltracodeActive(false)
    }
    if (apply.ultracode) {
      injectUltracode()
      setUltracodeActive(true)
    }
    setPending(rest)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activity?.status, exited])

  // Seleção DIRETA de modo de permissão: a CLI só cicla (Shift+Tab), sem set-exato. "Pulamos"
  // mandando Shift+Tab e, APÓS cada um, lendo o modo do rodapé REAL renderizado no buffer do
  // xterm (detectFooterMode: sem indicador = 'default'). Robusto a cruzar/parar no 'default'
  // (que o parser-sobre-stream não enxerga). Trava pelo helper puro jumpDecision (max passos +
  // voltou ao início = alvo inalcançável). Atualiza o pill a cada passo. jumpTimerRef cancela
  // um jump em voo (clique novo / unmount).
  function selectPermission(target: PermissionMode) {
    if (jumpTimerRef.current != null) {
      clearTimeout(jumpTimerRef.current)
      jumpTimerRef.current = null
    }
    const term = xtermRef.current
    if (!term) return
    const start = detectFooterMode(readFooterText(term))
    if (start === target) return
    let steps = 0
    write('\x1b[Z')
    const tick = () => {
      const t = xtermRef.current
      if (!t) return
      steps += 1
      const cur = detectFooterMode(readFooterText(t))
      setCurrentMode(cur)
      if (jumpDecision(cur, target, start, steps) !== 'step') {
        jumpTimerRef.current = null
        return
      }
      write('\x1b[Z')
      jumpTimerRef.current = window.setTimeout(tick, 140)
    }
    jumpTimerRef.current = window.setTimeout(tick, 140)
  }

  // Cancela os timers de permissão (jump + debounce do tracking) ao desmontar.
  useEffect(() => {
    return () => {
      if (jumpTimerRef.current != null) clearTimeout(jumpTimerRef.current)
      if (permTimerRef.current != null) clearTimeout(permTimerRef.current)
    }
  }, [])

  // Banner efêmero de transição de permission-mode: o VALOR atual já é sempre visível
  // (PermissionPill/ComposerToolbar), este effect só reage à MUDANÇA. shouldNotifyModeChange
  // suprime mount e a 1ª detecção real (baseline) — só dispara em transições subsequentes de
  // fato (ex.: usuário cicla via Shift+Tab, ou a CLI muda de modo sozinha).
  useEffect(() => {
    if (currentMode != null && shouldNotifyModeChange(prevModeForToastRef.current, currentMode)) {
      showToast({ title: `Modo alterado para ${permissionModeLabel(currentMode)}` })
    }
    prevModeForToastRef.current = currentMode
  }, [currentMode])

  // Saiu em < 3s do start, com código != 0 e sem nunca ter emitido bytes →
  // tratamos como "claude não encontrado". Não é detecção perfeita, mas evita o
  // críptico "exited (127)" pro caso mais comum (comando não instalado / errado).
  if (exited && exitAtRef.current === null) exitAtRef.current = Date.now()
  const claudeNotFound =
    exited &&
    exitCode !== 0 &&
    !gotDataRef.current &&
    (exitAtRef.current ?? Date.now()) - session.startedAt < 3000

  // Sessão encerrada não fica como pane morta: toast dismissível + auto-close
  // (o histórico vive no filtro "Encerradas" do seletor de sessões). Exceção:
  // claude não encontrado — mantém o banner com o CTA de Configurações.
  const autoClosedRef = useRef(false)
  useEffect(() => {
    if (!exited || claudeNotFound || autoClosedRef.current) return
    autoClosedRef.current = true
    showToast({
      title: 'Sessão encerrada',
      body: `${displayTitle}${exitCode != null && exitCode !== 0 ? ` (código ${exitCode})` : ''} — retome pelo seletor de sessões, em Encerradas.`,
    })
    onClose()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exited, claudeNotFound])

  function copySelection() {
    const sel = xtermRef.current?.getSelection()
    if (sel) void navigator.clipboard.writeText(sel)
  }

  // Compose box → PTY direto, sem tocar o xterm. O input é desacoplado do terminal:
  // buildPromptBytes normaliza as quebras de linha e envolve em bracketed-paste
  // (quando o TUI tem o modo ativo) pra preservar multilinha sem auto-submeter;
  // write() manda direto pro PTY. O xterm fica display-only permanente. sendPrompt
  // adiciona o \r final que submete.
  function insertPrompt(text: string) {
    const bracketed = xtermRef.current?.modes.bracketedPasteMode ?? true
    write(buildPromptBytes(text, bracketed))
  }
  function sendPrompt(text: string) {
    insertPrompt(text)
    write('\r')
    // Eco otimista: em modo chat, a bolha do usuário aparece na hora; o ChatView
    // a reconcilia quando o transcript de disco alcança (ver chat-logic).
    if (mode === 'chat') chatViewRef.current?.pushEcho(text)
  }

  // Chamado pelo SessionHeader ao commitar um rename (Enter/blur no input com
  // valor não-vazio). Cache no nosso DB (Fase 4/listagem) — a exibição prioriza
  // activity.name; fonte de verdade do nome é o próprio claude via /rename.
  // \x15 (Ctrl+U) limpa a linha atual do prompt pra não concatenar com algo que
  // o usuário digitou.
  function commitRename(next: string) {
    // Otimista: reflete o novo título e a origem manual na hora (o DB é a fonte
    // de verdade via sessions:rename, que também marca title_source='manual').
    setTitle(next)
    setTitleSource('manual')
    void sessionsApi.rename(session.id, next)
    if (canRename) write('\x15/rename ' + next + '\r')
  }

  useEffect(() => {
    if (!menu) return
    const close = () => setMenu(null)
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenu(null)
    }
    window.addEventListener('click', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [menu])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const term = new Xterm({
      // Tema derivado dos tokens do app (Ember reproduz o antigo hardcoded).
      theme: xtermTheme(getCurrentThemeTokens()),
      fontFamily: TERMINAL_FONT_FAMILY,
      fontSize: useTerminalPrefsStore.getState().fontSize,
      scrollback: useTerminalPrefsStore.getState().scrollback,
      // Nitidez: sem espaçamento fracionário entre células, glifos de box-drawing
      // desenhados pelo próprio xterm (bordas de TUI contínuas) e re-escala de
      // glifos que estouram a célula (powerline/nerd font não recortam).
      letterSpacing: 0,
      customGlyphs: true,
      rescaleOverlappingGlyphs: true,
      cursorBlink: true,
      allowProposedApi: true,
      // O xterm é INTERATIVO: digitar aqui flui via onData→write (abaixo) direto pro PTY.
      // O Composer é um input ADITIVO/opcional que também escreve no PTY (texto via
      // insertPrompt em bracketed-paste; teclas de controle via onForwardKey quando vazio)
      // — útil pra prompt multilinha, mas não é o único input.
      disableStdin: false,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.loadAddon(new WebLinksAddon())
    const search = new SearchAddon()
    term.loadAddon(search)
    searchRef.current = search
    term.loadAddon(new ClipboardAddon())

    // Linkifica PATHS de arquivo impressos no terminal → abre no painel de arquivos
    // (o WebLinksAddon acima cuida de URLs http, que continuam abrindo externamente).
    // Barato por design: só regex no texto da linha; nenhum I/O em provideLinks (o
    // I/O — ler o arquivo — só acontece no activate via openPath).
    const linkProvider = term.registerLinkProvider({
      provideLinks(lineNumber, cb) {
        const line = term.buffer.active.getLine(lineNumber - 1)
        const text = line?.translateToString(true)
        if (!text) return cb(undefined)
        const links: import('@xterm/xterm').ILink[] = []
        PATH_RE.lastIndex = 0
        let m: RegExpExecArray | null
        while ((m = PATH_RE.exec(text)) !== null) {
          let matched = m[0]
          const trimmed = matched.replace(TRAILING, '')
          if (trimmed.length < 2) continue // só "/" ou similar — ignora
          matched = trimmed
          const startX = m.index + 1 // coords do xterm são 1-based
          const endX = m.index + matched.length + 1
          const cwd = cwdRef.current || null
          const resolved = resolvePath(matched, cwd)
          if (!resolved) continue // relativo sem cwd disponível — não linka
          links.push({
            range: { start: { x: startX, y: lineNumber }, end: { x: endX, y: lineNumber } },
            text: matched,
            decorations: { underline: true, pointerCursor: true },
            activate() {
              void useFilesStore.getState().openPath(resolved)
            },
          })
        }
        cb(links.length ? links : undefined)
      },
    })

    xtermRef.current = term
    fitRef.current = fit

    // Gate do open: espera a JetBrains Mono (bounded) pra medição de célula e o
    // atlas de glifos nascerem com a fonte certa — sem isso o grid mede a
    // fallback e o texto troca/borra depois. `cancelled` cobre o double-mount do
    // StrictMode (o cleanup roda antes da promise resolver). Escrever no term
    // antes do open é seguro: o xterm bufferiza e renderiza ao abrir.
    let cancelled = false
    const fontPx = useTerminalPrefsStore.getState().fontSize
    void Promise.race([
      Promise.all([
        document.fonts.load(`${fontPx}px "JetBrains Mono"`),
        document.fonts.load(`bold ${fontPx}px "JetBrains Mono"`),
      ]),
      new Promise((resolve) => setTimeout(resolve, FONT_LOAD_TIMEOUT_MS)),
    ]).then(() => {
      if (cancelled) return
      term.open(host)
      fit.fit()
      resize(term.cols, term.rows)
      term.scrollToBottom()
      observer.observe(host)

      // Renderer WebGL: glifos nítidos e scroll mais fluido que o DOM renderer.
      // Carrega DEPOIS do open (o addon exige o elemento montado). attachWebgl
      // aplica os guards (GPU ligada, modo, visibilidade, cap global) e qualquer
      // falha volta pro DOM renderer sem quebrar o terminal.
      attachWebgl()

      // Safety net: se o timeout venceu a corrida (fonte ainda baixando), refaz
      // atlas e medidas quando todas as fonts do documento assentarem.
      void document.fonts.ready.then(() => {
        if (cancelled) return
        term.clearTextureAtlas()
        fit.fit()
        resize(term.cols, term.rows)
        term.scrollToBottom()
      })
    })

    // O processo já foi spawnado no clique, então pode já ter emitido bytes.
    // Para o replay: acumulamos a saída live num buffer (`liveTotal`) e buscamos
    // o backlog (snapshot do histórico no main). O backlog é prefixo do que vimos
    // até agora; escrevemos o backlog inteiro, depois só a cauda do live que ele
    // ainda não cobria. Assim não duplicamos os bytes que entraram em `liveTotal`
    // enquanto o IPC do backlog estava em voo. Idempotente em remounts (StrictMode)
    // porque o term é novo e zerado a cada mount.
    let flushed = false
    let liveTotal = ''
    setDataHandler((data) => {
      gotDataRef.current = true
      // Modo de permissão: relê o rodapé REAL do xterm (debounced) depois que a saída assenta.
      // detectFooterMode enxerga inclusive 'default' (sem indicador). O gate de status evita ler
      // durante 'working'/'starting' (quando o input box/rodapé não está visível).
      if (permTimerRef.current != null) clearTimeout(permTimerRef.current)
      permTimerRef.current = window.setTimeout(() => {
        const t = xtermRef.current
        if (!t) return
        // Menu TUI pendente: o parse roda no MESMO debounce (a saída assentou).
        // gateMenuByStatus decide por status × kind: 'waiting' aceita qualquer
        // menu; 'starting'/'idle' (pré-transcript) só permission/trust; outros
        // status limpam (null).
        applyTuiMenu(gateMenuByStatus(readTuiMenuFrom(t), statusRef.current))
        applyTuiPicker(readTuiPickerFrom(t))
        if (statusRef.current === 'working' || statusRef.current === 'starting') return
        setCurrentMode(detectFooterMode(readFooterText(t)))
      }, 150)
      if (flushed) term.write(data)
      else liveTotal += data
    })
    term.onData((d) => write(d))

    void sessionsApi.getBacklog(session.id).then((backlog) => {
      if (xtermRef.current !== term) return
      term.write(backlog)
      if (liveTotal.length > backlog.length) term.write(liveTotal.slice(backlog.length))
      liveTotal = ''
      flushed = true
      // Seed do modo de permissão a partir do rodapé já renderizado (o backlog acabou de ser
      // escrito no term). Gate de status: não lê durante 'working'/'starting'.
      if (statusRef.current !== 'working' && statusRef.current !== 'starting') {
        setCurrentMode(detectFooterMode(readFooterText(term)))
      }
      // Seed do menu TUI: um prompt já desenhado ANTES do mount (ex.: trust
      // prompt numa pane remontada) não gera data event novo — sem este seed o
      // card só apareceria no próximo byte do PTY.
      applyTuiMenu(gateMenuByStatus(readTuiMenuFrom(term), statusRef.current))
      applyTuiPicker(readTuiPickerFrom(term))
    })

    // Copy-on-select: copiar automaticamente o que for selecionado.
    term.onSelectionChange(() => {
      const sel = term.getSelection()
      if (sel) void navigator.clipboard.writeText(sel)
    })

    const isMac = /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent)

    // Display-only (modelo Warp): o teclado não vai mais pro PTY (disableStdin). Este
    // handler só sobra pros atalhos que fazem sentido num terminal de leitura — e só
    // disparam quando o xterm está focado (ex: depois de clicar pra selecionar texto).
    // Todo o input (texto + teclas de controle) é responsabilidade do Composer.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true

      // Copiar: Ctrl+Shift+C (todas plataformas), ou Cmd+C no mac só se houver seleção.
      if ((e.ctrlKey && e.shiftKey && e.key === 'C') || (e.shiftKey && e.key === 'C' && e.metaKey)) {
        const sel = term.getSelection()
        if (sel) void navigator.clipboard.writeText(sel)
        return false
      }
      if (isMac && e.metaKey && !e.shiftKey && e.key === 'c') {
        const sel = term.getSelection()
        if (!sel) return true // sem seleção, deixa o Cmd+C passar
        void navigator.clipboard.writeText(sel)
        return false
      }

      const kbOverrides = useKeybindingsStore.getState().overrides

      // Voltar o foco pro composer (default Ctrl+Shift+E) — o input único da sessão.
      if (matchCombo(e, resolveCombo('terminal.compose', kbOverrides))) {
        composerRef.current?.focus()
        return false
      }

      // Busca no terminal: combo configurável (default Ctrl/Cmd+F). Abre o overlay
      // por-pane ligado ao SearchAddon deste terminal.
      if (matchCombo(e, resolveCombo('terminal.search', kbOverrides))) {
        setSearchOpen(true)
        return false
      }

      // Limpar terminal: combo configurável (default Ctrl+Shift+K).
      if (matchCombo(e, resolveCombo('terminal.clear', kbOverrides))) {
        xtermRef.current?.clear()
        return false
      }

      return true
    })

    const onContextMenu = (e: MouseEvent) => {
      e.preventDefault()
      setMenu({ x: e.clientX, y: e.clientY, hasSelection: term.hasSelection() })
    }
    host.addEventListener('contextmenu', onContextMenu)

    // Criado aqui, mas só observa o host DEPOIS do open (no gate acima) — fit
    // num terminal ainda não aberto não tem o que medir. Coalescido via rAF:
    // o textarea do Composer crescendo dispara rajadas de resize e o fit sem
    // debounce thrasharia o grid. scrollToBottom re-pina o fundo — no shrink o
    // viewport pode ficar 1 row acima e as status lines da TUI somem sob o
    // overflow-hidden.
    let resizeRaf: number | null = null
    const observer = new ResizeObserver(() => {
      if (resizeRaf != null) cancelAnimationFrame(resizeRaf)
      resizeRaf = requestAnimationFrame(() => {
        resizeRaf = null
        const t = xtermRef.current
        const f = fitRef.current
        if (!t || !f) return
        f.fit()
        resize(t.cols, t.rows)
        t.scrollToBottom()
      })
    })

    // Tema ao vivo: quando o tema do app muda (Configurações), re-deriva o
    // tema do xterm sem recriar o terminal.
    const offTheme = onThemeChange((tokens) => {
      term.options.theme = xtermTheme(tokens)
    })

    // WebGL só em pane visível: host fora do viewport (aba oculta do dockview,
    // grid rolado) → dispose libera o slot do cap; voltou a aparecer → re-attach.
    // threshold 0: qualquer pixel visível conta como visível.
    const io = new IntersectionObserver(
      (entries) => {
        const visible = entries[entries.length - 1]?.isIntersecting ?? true
        visibleRef.current = visible
        if (visible) attachWebgl()
        else detachWebgl()
      },
      { threshold: 0 },
    )
    io.observe(host)

    // O cleanup NÃO mata a sessão — só desfaz o xterm e os listeners. A sessão
    // morre quando a pane é fechada (App.closePane → sessions:kill) ou via botão kill.
    return () => {
      cancelled = true
      host.removeEventListener('contextmenu', onContextMenu)
      if (resizeRaf != null) cancelAnimationFrame(resizeRaf)
      observer.disconnect()
      io.disconnect()
      offTheme()
      linkProvider.dispose()
      setDataHandler(null)
      detachWebgl()
      term.dispose()
      xtermRef.current = null
      fitRef.current = null
      searchRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id])

  // Foco no xterm ao (re)entrar no modo terminal, pra digitar direto na TUI sem clicar
  // primeiro. Em chat o host é invisible (não-focável), então não rouba foco lá.
  useEffect(() => {
    if (mode !== 'chat' && !exited) xtermRef.current?.focus()
  }, [mode, exited])

  // WebGL só no modo terminal: em chat o xterm fica invisible sob o ChatView —
  // manter um contexto WebGL ali gasta VRAM e ocupa slot do cap global à toa.
  // Voltando pro terminal, re-attach (attachWebgl re-aplica todos os guards).
  useEffect(() => {
    if (mode === 'chat') detachWebgl()
    else attachWebgl()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode])

  // Zoom ao vivo: atualiza a fonte do xterm já montado quando o store muda, sem
  // recriar o terminal (a criação lê o tamanho via getState()).
  useEffect(() => {
    const term = xtermRef.current
    const fit = fitRef.current
    if (!term || !fit) return
    term.options.fontSize = fontSize
    fit.fit()
    resize(term.cols, term.rows)
    term.scrollToBottom()
  }, [fontSize, resize])

  // Scrollback ao vivo: atualiza o histórico do xterm já montado quando o store muda,
  // sem recriar o terminal (a criação lê o valor via getState()).
  useEffect(() => {
    const term = xtermRef.current
    if (!term) return
    term.options.scrollback = scrollback
  }, [scrollback])

  // Mudança de devicePixelRatio (janela movida entre monitores com escalas
  // diferentes, zoom do SO): refaz o atlas de glifos e re-mede — sem isso o
  // texto fica borrado no monitor novo. matchMedia de resolução dispara UMA vez
  // por mudança, então o listener é re-registrado pro dpr novo a cada disparo.
  useEffect(() => {
    let disposed = false
    let mql: MediaQueryList
    let onChange: () => void
    const subscribe = () => {
      mql = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`)
      onChange = () => {
        if (disposed) return
        const term = xtermRef.current
        const fit = fitRef.current
        if (term && fit) {
          term.clearTextureAtlas()
          fit.fit()
          resize(term.cols, term.rows)
          term.scrollToBottom()
        }
        subscribe()
      }
      mql.addEventListener('change', onChange, { once: true })
    }
    subscribe()
    return () => {
      disposed = true
      mql.removeEventListener('change', onChange)
    }
  }, [resize])

  // Cura pós-suspend/focus: no NVIDIA/Wayland o contexto WebGL pode acordar com
  // o glyph atlas corrompido SEM disparar onContextLoss. Em gpu:resumed (main,
  // powerMonitor) e no focus da janela: com WebGL vivo refaz o atlas + repinta;
  // sem WebGL só repinta. Throttle de 5s — focus dispara em rajada e o heal
  // completo (atlas + refresh full) não é de graça.
  useEffect(() => {
    let lastHealAt = 0
    const heal = () => {
      const now = Date.now()
      if (now - lastHealAt < 5000) return
      lastHealAt = now
      const term = xtermRef.current
      if (!term) return
      if (webglRef.current) term.clearTextureAtlas()
      term.refresh(0, term.rows - 1)
    }
    const offResumed = gpuApi.onResumed(heal)
    window.addEventListener('focus', heal)
    return () => {
      offResumed()
      window.removeEventListener('focus', heal)
    }
  }, [])

  // Crash do processo de GPU (broadcast do main): o contexto WebGL morreu por
  // baixo — larga o addon e segue em DOM renderer NA MESMA sessão, sem recriar
  // WebGL neste mount (o driver acabou de provar que não aguenta).
  useEffect(() => {
    const off = gpuApi.onCrashed(() => {
      webglFailedRef.current = true
      detachWebgl()
    })
    return off
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Gate de adotabilidade consultado no main (findTranscriptPath). Roda quando o
  // ccSessionId aparece — sessão recém-nascida ainda não tem transcript.
  useEffect(() => {
    let alive = true
    if (!session.ccSessionId) {
      setHasTranscript(false)
      return
    }
    void sessionsApi.isResumable(session.ccSessionId).then((ok) => {
      if (alive) setHasTranscript(ok)
    })
    return () => {
      alive = false
    }
  }, [session.ccSessionId])

  const adoptDisabledReason = isCrewChild
    ? 'Esta sessão já é filha de um handoff — ela já vive no painel da equipe'
    : !session.ccSessionId || !hasTranscript
      ? 'Sem transcript no disco ainda — relançar como filha perderia o histórico'
      : null

  return (
    <div className="flex h-full flex-col">
      {chrome === 'full' && (
        <SessionHeader
          projectName={projectName}
          projectIcon={projectIcon}
          projectColor={projectColor}
          repoLabel={repoLabel}
          repoPath={repoPath}
          displayTitle={displayTitle}
          nameValue={manualTitle ?? activity?.name ?? title ?? ''}
          isNamed={isNamed}
          canRename={canRename}
          onCommitRename={commitRename}
          exited={exited}
          activity={activity}
          now={now}
          claudeNotFound={claudeNotFound}
          exitCode={exitCode}
          error={error}
          mode={mode}
          onToggleMode={onToggleMode}
          onMinimize={onClose}
          onEndSession={() => endSession(session.id)}
          // Sem ccSessionId não há transcript pra destilar (sessão sem 1ª
          // resposta ainda) — a ação some em vez de abrir um diálogo que já
          // nasceria em erro.
          onPassBaton={session.ccSessionId ? () => setBatonOpen(true) : undefined}
          onAdopt={() => setAdoptOpen(true)}
          adoptDisabledReason={adoptDisabledReason}
        />
      )}

      {/* Adotada: a sessão passa a viver no painel da equipe, então a pane sai
          da vista (detach, não kill — o processo relançado segue vivo). O
          caminho de volta é o promoteToTab do quick look. */}
      <AdoptSessionDialog
        open={adoptOpen}
        onClose={() => setAdoptOpen(false)}
        sessionId={session.id}
        displayTitle={displayTitle}
        onAdopted={() => onClose()}
      />

      <BatonDialog
        open={batonOpen}
        onClose={() => setBatonOpen(false)}
        sessionId={session.id}
        ccSessionId={session.ccSessionId}
        repoLabel={repoLabel}
      />

      {/* Banner só pro caso "claude não encontrado" (precisa do CTA de config);
          exit normal fecha a pane sozinho com toast (effect acima). */}
      {exited && claudeNotFound && (
        <div
          className="flex items-center justify-between gap-3 border-b border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-2 text-xs"
          style={{ color: 'var(--color-text-dim)' }}
        >
          <span className="text-[var(--color-text)]">
            <span className="text-[var(--color-danger)]">claude não encontrado</span> — verifique a instalação
            ou configure o comando em Configurações.
          </span>
          <div className="flex shrink-0 items-center gap-2">
            {onOpenSettings && (
              <button
                type="button"
                onClick={onOpenSettings}
                className="rounded border border-[var(--color-border)] px-2 py-0.5 hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text)]"
              >
                Configurações
              </button>
            )}
            {onReopen && (
              <button
                type="button"
                onClick={onReopen}
                className="rounded border border-[var(--color-border)] px-2 py-0.5 text-[var(--color-text)] hover:bg-[var(--color-surface-2)] hover:text-[var(--color-accent)]"
              >
                Reabrir
              </button>
            )}
          </div>
        </div>
      )}

      {/* min-h-[200px] (~11 rows na fonte default): garante espaço pra TUI
          desenhar a caixa de input + status lines mesmo com o composer expandido. */}
      <div className="relative min-h-[200px] flex-1 overflow-hidden">
        {/* xterm SEMPRE montado: em modo chat só ocultamos visualmente (invisible,
            não hidden, pra a caixa de layout sobreviver e o fit() seguir medindo
            certo). O PTY e o scrollback seguem vivos por baixo. */}
        <div
          ref={hostRef}
          className={`h-full bg-[var(--color-bg)] p-2 ${mode === 'chat' ? 'invisible' : ''}`}
        />


        {mode === 'chat' && (
          <ChatView
            ref={chatViewRef}
            sessionId={session.id}
            status={activity?.status}
            onToggleMode={onToggleMode}
            // Cliques nos cards interativos → teclas no PTY vivo, mesmo write()
            // do onForwardKey do composer (ver respond-keys).
            onRespond={(seqs) => void playKeys(seqs, write)}
            // Momento pendente clicável: menu TUI parseado do buffer do xterm
            // (o transcript não expõe perguntas pendentes). reparseMenu é o
            // guard de clique — re-parse fresco antes de digitar.
            tuiMenu={pendingTuiMenu}
            reparseMenu={readTuiMenu}
            tuiPicker={pendingTuiPicker}
            reparsePicker={readTuiPicker}
          />
        )}

        {searchOpen && (
          <div
            className="absolute right-3 top-3 z-40 flex items-center gap-1 rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-xs shadow-lg"
            onClick={(e) => e.stopPropagation()}
          >
            <input
              autoFocus
              value={searchQuery}
              placeholder="Buscar…"
              onChange={(e) => {
                const value = e.target.value
                setSearchQuery(value)
                searchRef.current?.findNext(value)
              }}
              onKeyDown={(e) => {
                e.stopPropagation()
                if (e.key === 'Enter') {
                  e.preventDefault()
                  if (e.shiftKey) searchRef.current?.findPrevious(searchQuery)
                  else searchRef.current?.findNext(searchQuery)
                } else if (e.key === 'Escape') {
                  e.preventDefault()
                  setSearchOpen(false)
                  xtermRef.current?.focus()
                }
              }}
              className="w-44 bg-transparent text-[var(--color-text)] outline-none placeholder:text-[var(--color-text-dim)]"
            />
            <button
              type="button"
              title="Anterior (Shift+Enter)"
              onClick={() => searchRef.current?.findPrevious(searchQuery)}
              className="rounded px-1 text-[var(--color-text-dim)] hover:text-[var(--color-accent)]"
            >
              ↑
            </button>
            <button
              type="button"
              title="Próximo (Enter)"
              onClick={() => searchRef.current?.findNext(searchQuery)}
              className="rounded px-1 text-[var(--color-text-dim)] hover:text-[var(--color-accent)]"
            >
              ↓
            </button>
            <button
              type="button"
              title="Fechar (Esc)"
              onClick={() => {
                setSearchOpen(false)
                xtermRef.current?.focus()
              }}
              className="rounded px-1 text-[var(--color-text-dim)] hover:text-[var(--color-danger)]"
            >
              ✕
            </button>
          </div>
        )}
      </div>

      {/* HUD fino de agentes (statusline): FORA do container relative, entre o
          terminal e o composer — visível nos dois modos (terminal e chat). */}
      {!exited && <AgentHud activity={activity} now={now} />}

      {!exited && (
        <Composer
          sessionId={session.id}
          ref={composerRef}
          onSend={sendPrompt}
          onInsert={insertPrompt}
          // Modelo Warp: o composer encaminha teclas de controle/navegação direto pro
          // PTY (write escreve no pty, fora do xterm display-only).
          onForwardKey={(seq) => write(seq)}
          // Recolher o dock só faz sentido no modo terminal (em chat o dock é completo).
          collapsible={mode === 'terminal'}
          toolbar={
            <ComposerToolbar
              activity={activity}
              canSwitch={canSwitchModel}
              pending={pending}
              activeEffort={activeEffort}
              xhighCapable={xhighCapable}
              ultracodeActive={ultracodeActive}
              currentMode={currentMode}
              onSelectModel={selectModel}
              onSelectEffort={selectEffort}
              // Shift+Tab (CSI Z) cicla o modo de permissão no TUI do claude. A CLI
              // não tem set-exato em runtime (sem /permission) — só este ciclo nativo.
              onCyclePermission={() => write('\x1b[Z')}
              // Seleção direta: "pula" até o modo escolhido ciclando Shift+Tab e
              // observando o modo parseado (selectPermission + effect acima).
              onSelectPermission={selectPermission}
              // Ctrl+C interrompe o claude (descoberta da ação que antes era só teclado).
              onInterrupt={() => write('\x03')}
              // Ditado por voz: o texto transcrito entra no prompt via onInsert
              // existente — o usuário revisa e envia (nunca envio direto).
              onVoiceText={insertPrompt}
            />
          }
        />
      )}

      {menu && (
        <div
          className="fixed z-50 min-w-28 overflow-hidden rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] py-1 text-xs shadow-lg"
          style={{ top: menu.y, left: menu.x }}
          onClick={(e) => e.stopPropagation()}
        >
          {menu.hasSelection && (
            <button
              type="button"
              onClick={() => {
                copySelection()
                setMenu(null)
              }}
              className="block w-full px-3 py-1 text-left hover:bg-[var(--color-surface)] hover:text-[var(--color-accent)]"
            >
              Copiar
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              xtermRef.current?.clear()
              setMenu(null)
            }}
            className="block w-full px-3 py-1 text-left hover:bg-[var(--color-surface)] hover:text-[var(--color-accent)]"
          >
            Limpar
          </button>
        </div>
      )}
    </div>
  )
}
