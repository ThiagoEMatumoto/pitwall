import { create } from 'zustand'
import { sessionsApi, workspaceApi } from '@/lib/ipc'
import { showToast } from '@/features/notifications/toast-store'
import { useSessionFeatureStore } from '@/store/sessionFeatureStore'
import { providerSupports } from '../../shared/agent-providers'
import type {
  AdvisorModel,
  AgentProviderId,
  EffortLevel,
  LiveSessionInfo,
  PaneSnapshot,
  PermissionMode,
  Repo,
  Session,
} from '../../shared/types/ipc'

export type Area =
  | 'projects'
  | 'cc-configs'
  | 'metrics'
  | 'features'
  | 'overview'
  | 'objectives'
  | 'tasks'
  | 'architecture'
  | 'handoffs'
  | 'diagrams'
  | 'design'
  | 'videos'
  | 'meetings'
  | 'room'

// Persistência leve do estado colapsado da sidebar (mesmo padrão do
// keybindings-store: localStorage no renderer, sem IPC/DB).
const SIDEBAR_COLLAPSED_KEY = 'cm:sidebar-collapsed'

function readSidebarCollapsed(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1'
  } catch {
    return false
  }
}

function writeSidebarCollapsed(collapsed: boolean): void {
  try {
    localStorage.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? '1' : '0')
  } catch {
    // localStorage indisponível — estado segue só em memória.
  }
}

// Display da pane: terminal cru (xterm/PTY) ou chat renderizado do transcript. O
// PTY segue vivo nos dois modos; chat é só uma camada de leitura por cima.
export type PaneMode = 'terminal' | 'chat'

export interface ActivePane {
  paneId: string
  session: Session
  // null = sessão avulsa (sem repo/projeto), rodando no scratch dir.
  repo: Repo | null
  projectName: string | null
  projectIcon: string | null
  projectColor: string | null
  mode: PaneMode
}

// Memória leve do último modo por sessão (chave = ccSessionId), no mesmo padrão
// localStorage do estado da sidebar. Sobrevive a resume/restore/remount sem ir ao
// DB — o modo é preferência de visualização, não estado de sessão.
const PANE_MODE_KEY = 'cm:pane-modes'

// Espelho síncrono do default global (`session.defaultPaneMode`, em app_prefs).
// readPaneMode roda em caminhos síncronos (criação de pane), mas a pref vem de
// SQLite via IPC — o AppShell carrega no boot e empurra o valor pra cá.
let defaultPaneMode: PaneMode = 'terminal'

export function setDefaultPaneModeFallback(mode: PaneMode): void {
  defaultPaneMode = mode
}

// Escolha pontual do SpawnSessionDialog ("Abrir em"), consumida pelo próximo
// openSession. One-shot: o diálogo não conhece o paneId (quem spawna é o caller).
let nextPaneMode: PaneMode | null = null

export function setNextPaneMode(mode: PaneMode): void {
  nextPaneMode = mode
}

function takeNextPaneMode(): PaneMode | null {
  const m = nextPaneMode
  nextPaneMode = null
  return m
}

function readPaneModes(): Record<string, PaneMode> {
  try {
    const raw = localStorage.getItem(PANE_MODE_KEY)
    return raw ? (JSON.parse(raw) as Record<string, PaneMode>) : {}
  } catch {
    return {}
  }
}

function readPaneMode(ccSessionId: string | null): PaneMode {
  if (!ccSessionId) return defaultPaneMode
  return readPaneModes()[ccSessionId] ?? defaultPaneMode
}

function writePaneMode(ccSessionId: string | null, mode: PaneMode): void {
  if (!ccSessionId) return
  try {
    const all = readPaneModes()
    all[ccSessionId] = mode
    localStorage.setItem(PANE_MODE_KEY, JSON.stringify(all))
  } catch {
    // localStorage indisponível — o modo segue só na pane em memória.
  }
}

let savePanesTimer: ReturnType<typeof setTimeout> | null = null

// Encerramentos pendentes (janela de undo): a UI some na hora, mas o kill do
// processo só dispara quando o timer expira. "Desfazer" cancela o timer e
// restaura pane/chip — nada foi morto ainda. Snapshot guardado pra restaurar.
const END_UNDO_MS = 5000
// Graça entre o toast sumir e o kill disparar. O timer do kill começa síncrono
// no endSession, mas o auto-dismiss do toast só começa um render depois — sem
// folga, o toast sobrevive ao kill por uma janela curta e "Desfazer" viraria
// no-op com o PTY já morto. A graça garante: toast visível ⇒ undo ainda vale.
const END_KILL_GRACE_MS = 750
const pendingEnds = new Map<
  string,
  { timer: ReturnType<typeof setTimeout>; pane: ActivePane | null; live: LiveSessionInfo | null }
>()

// Ids na janela de undo do Encerrar. O SessionStrip exclui esses do prune de
// pins: a sessão já sumiu do snapshot (refresh filtra pendingEnds), mas pode
// voltar via "Desfazer" — e deve voltar ainda fixada.
export function pendingEndSessionIds(): ReadonlySet<string> {
  return new Set(pendingEnds.keys())
}

// Guarda o auto-restore contra a dupla montagem do StrictMode (rodaria 2x).
let restoreStarted = false
// Reserva síncrona de ccSessionIds em resume — fecha a corrida entre o check de
// duplicata e o `await` do spawn (duas chamadas concorrentes passariam o check).
const resuming = new Set<string>()

// Dono único da assinatura do stream global de atividade (strip + overlay leem o
// mesmo `liveSessions`). `offGlobalActivity` guarda o unsubscribe do onGlobalActivity;
// `liveWatchStarted` guarda contra o duplo-mount do StrictMode.
let offGlobalActivity: (() => void) | null = null
let offPtyExit: (() => void) | null = null
let liveWatchStarted = false

// Persiste um snapshot enxuto (suficiente pra resume sem lookups), com debounce
// pra não gravar a cada teclada de spawn/close em sequência.
function schedulePersist(panes: ActivePane[]): void {
  if (savePanesTimer) clearTimeout(savePanesTimer)
  savePanesTimer = setTimeout(() => {
    const snapshots: PaneSnapshot[] = panes
      .filter((p) => p.session.ccSessionId)
      .map((p) => ({
        ccSessionId: p.session.ccSessionId as string,
        repo: p.repo,
        projectName: p.projectName,
        projectIcon: p.projectIcon,
        projectColor: p.projectColor,
        paneId: p.paneId,
      }))
    void workspaceApi.savePanes(snapshots)
  }, 500)
}

// Restaura com paralelismo limitado: no máximo `limit` spawns de claude
// simultâneos, pra não disparar dezenas de PTYs de uma vez. A falha de um
// individual não aborta os demais — o erro aparece no terminal da pane.
// Sessões com transcript retomam (--resume); as sem (spawn que nunca conversou)
// viram sessão NOVA no mesmo repo, mantendo o paneId pra o layout do dockview bater.
async function restoreFromSnapshots(
  snapshots: PaneSnapshot[],
  resume: AppState['resumeSession'],
  open: AppState['openSession'],
  limit = 4,
): Promise<void> {
  const queue = [...snapshots]
  async function worker(): Promise<void> {
    let snap = queue.shift()
    while (snap) {
      const current = snap
      try {
        const resumable = await sessionsApi.isResumable(current.ccSessionId)
        if (resumable) {
          await resume(
            current.repo,
            current.projectName,
            current.projectIcon,
            current.projectColor ?? null,
            current.ccSessionId,
            current.paneId,
          )
        } else {
          await open(
            current.repo,
            current.projectName,
            current.projectIcon,
            current.projectColor ?? null,
            current.paneId,
          )
        }
      } catch {
        // Pane individual não restaurável — segue restaurando as outras.
      }
      snap = queue.shift()
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, snapshots.length) }, worker))
}

// Reconstrói uma ActivePane a partir de uma sessão LIVE da lista global. Como o
// item vem de runningIds() (PTY viva no main), abrir = RE-ATTACH: criamos a pane
// apontando pro session.id existente e o Terminal replica o backlog. NÃO fazemos
// spawn/resume — isso criaria um segundo processo claude pra mesma conversa.

// A Session que o <Terminal/> pede, derivada de uma sessão LIVE. Exportada
// porque nem todo terminal nasce de uma pane: o quick look da equipe monta um
// <Terminal/> em janela, anexado à MESMA PTY, sem criar pane nenhuma.
export function sessionFromLiveSession(item: LiveSessionInfo, paneId: string | null): Session {
  return {
    id: item.id,
    repoId: item.repo?.id ?? null,
    // O Codex vem com ccSessionId = sessions.id (chave do batch global), não um id
    // nativo: copiado, a pane viraria "claude" — watch de transcript, baton e um
    // restore que sobe claude no lugar dela.
    ccSessionId: providerSupports(item.provider).resume ? item.ccSessionId : null,
    title: item.title ?? item.name,
    titleSource: item.titleSource ?? null,
    paneId,
    status: 'running',
    startedAt: item.lastActivityAt ?? Date.now(),
    endedAt: null,
    provider: item.provider,
  }
}

// A pane já exibe esta sessão viva? Sessão sem id nativo (Codex) tem pane com
// ccSessionId null e item da lista com ccSessionId = sessions.id: casa pelo id.
function paneShowsLive(pane: ActivePane, item: LiveSessionInfo): boolean {
  return pane.session.id === item.id || pane.session.ccSessionId === item.ccSessionId
}

function paneFromLiveSession(item: LiveSessionInfo, paneId: string): ActivePane {
  return {
    paneId,
    session: sessionFromLiveSession(item, paneId),
    repo: item.repo,
    projectName: item.projectName,
    projectIcon: item.projectIcon,
    projectColor: item.projectColor,
    mode: readPaneMode(item.ccSessionId),
  }
}

// Recarregar o renderer (ErrorBoundary, reload da janela) roda o restore de novo
// com as PTYs do main ainda vivas: a aba salva cuja sessão segue rodando
// re-attacha (mesmo paneId, pro layout bater); só as demais sobem processo.
// Sem isto, cada reload subia mais um claude e deixava o anterior órfão.
function splitLiveSnapshots(
  snapshots: PaneSnapshot[],
  live: LiveSessionInfo[],
): { attached: ActivePane[]; rest: PaneSnapshot[] } {
  const attached: ActivePane[] = []
  const rest: PaneSnapshot[] = []
  for (const snap of snapshots) {
    const item = live.find((l) => l.ccSessionId === snap.ccSessionId)
    if (item)
      attached.push(paneFromLiveSession(item, snap.paneId ?? `pane-${Date.now()}-${item.id}`))
    else rest.push(snap)
  }
  return { attached, rest }
}

interface AppState {
  area: Area
  activeProjectId: string | null
  sidebarCollapsed: boolean
  panes: ActivePane[]
  // Todas as sessões vivas (PTYs no main), atualizadas pelo stream global. Dono
  // único da assinatura — strip e overlay só leem. Snapshot via listLiveGlobal,
  // merge incremental via onGlobalActivity, refetch nas mutações de pane.
  liveSessions: LiveSessionInfo[]
  restoreBlocked: boolean
  // Número de sessões que o boot vai restaurar (lido do snapshot). null até o
  // getBootState resolver. Consumido pela splash de boot ("restaurando N sessões").
  bootSessionCount: number | null
  // true quando o fluxo de restore terminou (ou não havia nada a restaurar, ou
  // ficou bloqueado). A splash usa pra auto-avançar quando a animação já passou.
  restoreComplete: boolean
  // Layout do dockview a aplicar (api.fromJSON) UMA vez, após as panes do restore
  // existirem no store. O AppShell consome e chama clearPendingLayout.
  pendingLayout: string | null
  // Pedido de foco num painel existente (clique simples na lista de sessões). O
  // AppShell consome (api.getPanel(id)?.focus()) e chama clearFocusPane.
  focusPaneId: string | null
  // Pedido de montagem de grade imperativa (multi-seleção "abrir N em grade"). O
  // AppShell consome quando todas as panes listadas existem, monta linhas×colunas
  // via addPanel e chama clearGridRequest. paneIds na ordem desejada da grade.
  gridRequest: string[] | null

  setArea: (area: Area) => void
  toggleSidebar: () => void
  setSidebarCollapsed: (collapsed: boolean) => void
  initActiveProject: () => Promise<void>
  restoreWorkspace: () => Promise<void>
  // Re-attacha às PTYs vivas e só sobe processo pras abas sem sessão viva.
  restoreSnapshots: (snapshots: PaneSnapshot[]) => Promise<void>
  retryRestore: () => Promise<void>
  clearPendingLayout: () => void
  clearFocusPane: () => void
  clearGridRequest: () => void
  setActiveProject: (id: string | null) => void
  openSession: (
    repo: Repo | null,
    projectName: string | null,
    projectIcon: string | null,
    projectColor: string | null,
    paneId?: string,
    featureId?: string,
    name?: string,
    initialCommand?: string,
    // Modelo inicial ('opus' | 'sonnet' | 'haiku'); validado no main.
    model?: string,
    // Effort inicial; validado no main contra whitelist.
    effort?: EffortLevel,
    // Texto de system-prompt anexado via arquivo (--append-system-prompt-file).
    // Trailing/opcional: callers existentes omitem. Usado pelo handoff pra
    // entregar o prompt completo íntegro (sem quebrar no REPL).
    systemPromptText?: string,
    // Modo de permissão inicial (--permission-mode); validado no main. Trailing/
    // opcional: callers que não escolhem permissão omitem (= default da CLI).
    permissionMode?: PermissionMode,
    // Modelo do advisor tool (--advisor <model>); validado no main. Trailing/
    // opcional: callers existentes omitem (= advisor desligado).
    advisorModel?: AdvisorModel,
    // CLI da sessão; ausente = claude.
    provider?: AgentProviderId,
    // Retorna o id da sessão criada. Callers existentes ignoram o retorno; o fluxo
    // de handoff usa pra marcar mark-running com o childSessionId.
  ) => Promise<string>
  // Spawna uma sessão SEM abrir pane/xterm (usado pelo handoff: a filha sobe em
  // background e aparece só no liveSessions/rollup). Retorna o id da sessão criada.
  // Aceita permissionMode/disallowedTools repassados ao spawn (o main valida).
  spawnSessionBackground: (input: {
    repoId?: string | null
    name?: string
    featureId?: string
    initialCommand?: string
    // Prompt posicional entregue no comando de spawn (auto-submit do 1º turno).
    initialPrompt?: string
    systemPromptText?: string
    permissionMode?: PermissionMode
    disallowedTools?: string[]
    // Filha de handoff: o main fixa o título (alias = endereço do peer) e passa
    // `--settings crossSessionInbound=accept` só nessa sessão.
    handoffChild?: boolean
    handoffId?: string
    // Controles do diálogo de spawn (sessão criada no mapa, sem aba).
    model?: string
    effort?: EffortLevel
    advisorModel?: AdvisorModel
    provider?: AgentProviderId
  }) => Promise<string>
  // Sessão avulsa: spawn sem repo (cwd = scratch dir do backend).
  openQuickSession: () => Promise<void>
  resumeSession: (
    repo: Repo | null,
    projectName: string | null,
    projectIcon: string | null,
    projectColor: string | null,
    ccSessionId: string,
    paneId?: string,
  ) => Promise<void>
  closePane: (paneId: string) => void
  // Alterna/define o display da pane (terminal ⇄ chat) e lembra por sessão.
  setPaneMode: (paneId: string, mode: PaneMode) => void
  // Encerramento com undo: some da UI na hora, toast "Desfazer" por ~5s; o kill
  // efetivo da PTY só dispara quando a janela expira. `immediate: true` pula a
  // janela de undo e mata na hora (ex.: Reabrir uma sessão já exited — não há
  // o que desfazer e o toast só confundiria).
  endSession: (sessionId: string, opts?: { immediate?: boolean }) => void
  // Desfazer dentro da janela: cancela o kill agendado e restaura pane/chip.
  undoEndSession: (sessionId: string) => void
  // Clique simples na lista: foca a pane se já exibida; senão resume/abre (sem
  // destruir as panes existentes) e vai pra área de projetos.
  focusOrOpenSession: (item: LiveSessionInfo) => Promise<void>
  // Multi-seleção: garante as N selecionadas em panes, substitui a view por
  // exatamente essas N e monta a grade (via gridRequest), indo pra projetos.
  openSessionsInGrid: (items: LiveSessionInfo[]) => Promise<void>
  // Assina (snapshot + stream) e desassina o conjunto de sessões vivas. Chamados
  // uma vez no mount/unmount do AppShell.
  startLiveWatch: () => Promise<void>
  stopLiveWatch: () => void
  // Re-busca o snapshot de sessões vivas (entrada/saída de sessão). Preserva o
  // status mais fresco já recebido pelo stream pra entradas que persistem.
  refreshLiveSessions: () => Promise<void>
}

export const useAppStore = create<AppState>((set, get) => ({
  // Boot abre na Home (status geral); o painel de terminais fica montado oculto
  // no AppShell, então o restore de panes segue funcionando em background.
  area: 'overview',
  activeProjectId: null,
  sidebarCollapsed: readSidebarCollapsed(),
  panes: [],
  liveSessions: [],
  restoreBlocked: false,
  bootSessionCount: null,
  restoreComplete: false,
  pendingLayout: null,
  focusPaneId: null,
  gridRequest: null,

  setArea: (area) => set({ area }),

  toggleSidebar: () => {
    const next = !get().sidebarCollapsed
    writeSidebarCollapsed(next)
    set({ sidebarCollapsed: next })
  },

  setSidebarCollapsed: (collapsed) => {
    writeSidebarCollapsed(collapsed)
    set({ sidebarCollapsed: collapsed })
  },

  initActiveProject: async () => {
    const id = await workspaceApi.getActive()
    set({ activeProjectId: id })
  },

  restoreWorkspace: async () => {
    if (restoreStarted) return
    restoreStarted = true
    const { openPanes, cleanShutdown, restoreAttempts, dockLayout } =
      await workspaceApi.getBootState()
    set({ bootSessionCount: openPanes.length })
    if (openPanes.length === 0) {
      set({ restoreComplete: true })
      return
    }

    // Shutdown gracioso: confiamos no estado salvo e restauramos direto.
    // Crash com >=2 tentativas seguidas: provável crash-loop — não auto-restaura,
    // expõe banner pra o usuário decidir.
    const manualOnly = !cleanShutdown && restoreAttempts >= 2
    if (manualOnly) {
      set({ restoreBlocked: true, restoreComplete: true })
      return
    }

    if (!cleanShutdown) await workspaceApi.bumpRestoreAttempts()
    // pendingLayout só faz sentido se todos os snapshots têm paneId (gravados após
    // esta feature). Snapshots antigos caem no addPanel padrão.
    if (dockLayout && openPanes.every((p) => p.paneId)) set({ pendingLayout: dockLayout })
    await get().restoreSnapshots(openPanes)
    await workspaceApi.resetRestoreAttempts()
    set({ restoreComplete: true })
  },

  retryRestore: async () => {
    const { openPanes, dockLayout } = await workspaceApi.getBootState()
    set({ restoreBlocked: false })
    if (dockLayout && openPanes.every((p) => p.paneId)) set({ pendingLayout: dockLayout })
    await get().restoreSnapshots(openPanes)
    await workspaceApi.resetRestoreAttempts()
  },

  restoreSnapshots: async (snapshots) => {
    const live = await sessionsApi.listLiveGlobal().catch(() => [])
    const { attached, rest } = splitLiveSnapshots(snapshots, live)
    const fresh = attached.filter((a) => !get().panes.some((p) => p.session.id === a.session.id))
    if (fresh.length) {
      set((s) => ({ panes: [...s.panes, ...fresh] }))
      schedulePersist(get().panes)
    }
    await restoreFromSnapshots(rest, get().resumeSession, get().openSession)
  },

  clearPendingLayout: () => set({ pendingLayout: null }),
  clearFocusPane: () => set({ focusPaneId: null }),
  clearGridRequest: () => set({ gridRequest: null }),

  setActiveProject: (id) => {
    set({ activeProjectId: id })
    void workspaceApi.setActive(id)
  },

  openSession: async (
    repo,
    projectName,
    projectIcon,
    projectColor,
    paneId,
    featureId,
    name,
    initialCommand,
    model,
    effort,
    systemPromptText,
    permissionMode,
    advisorModel,
    provider,
  ) => {
    // Consome ANTES do await: se dois spawns dispararem em sequência, cada um
    // leva (no máximo) a escolha do seu próprio diálogo.
    const chosenMode = takeNextPaneMode()
    // O spawn do processo acontece aqui, no clique — não no mount do Terminal.
    // Assim StrictMode (mount duplo do effect) não dispara dois processos claude.
    const session = await sessionsApi.spawn({
      repoId: repo?.id ?? null,
      featureId,
      name,
      initialCommand,
      model,
      effort,
      systemPromptText,
      permissionMode,
      advisorModel,
      provider,
    })
    set((s) => ({
      panes: [
        ...s.panes,
        {
          paneId: paneId ?? `pane-${Date.now()}`,
          session,
          repo,
          projectName,
          projectIcon,
          projectColor,
          mode: chosenMode ?? readPaneMode(session.ccSessionId ?? null),
        },
      ],
    }))
    if (chosenMode) writePaneMode(session.ccSessionId ?? null, chosenMode)
    // Vínculo recém-criado: o índice reverso (chip do header) sabe na hora, sem
    // esperar o hydrate — que só conhece sessões já persistidas.
    if (featureId) useSessionFeatureStore.getState().note(session.id, featureId)
    schedulePersist(get().panes)
    void get().refreshLiveSessions()
    return session.id
  },

  spawnSessionBackground: async (input) => {
    // Sem set(panes): a PTY sobe no main e o watch global a adiciona ao
    // liveSessions sozinho. refreshLiveSessions adianta a aparição no rollup.
    const session = await sessionsApi.spawn({
      repoId: input.repoId ?? null,
      name: input.name,
      featureId: input.featureId,
      initialCommand: input.initialCommand,
      initialPrompt: input.initialPrompt,
      systemPromptText: input.systemPromptText,
      permissionMode: input.permissionMode,
      disallowedTools: input.disallowedTools,
      handoffChild: input.handoffChild,
      handoffId: input.handoffId,
      model: input.model,
      effort: input.effort,
      advisorModel: input.advisorModel,
      provider: input.provider,
    })
    if (input.featureId) useSessionFeatureStore.getState().note(session.id, input.featureId)
    void get().refreshLiveSessions()
    return session.id
  },

  openQuickSession: async () => {
    await get().openSession(null, null, null, null)
  },

  resumeSession: async (repo, projectName, projectIcon, projectColor, ccSessionId, paneId) => {
    // Já há uma pane com essa sessão aberta (ou um resume em voo)? Não duplicar.
    // `resuming` é reservado de forma síncrona antes do await pra fechar a corrida.
    if (get().panes.some((p) => p.session.ccSessionId === ccSessionId) || resuming.has(ccSessionId))
      return
    resuming.add(ccSessionId)
    try {
      const session = await sessionsApi.resume({ repoId: repo?.id ?? null, ccSessionId })
      set((s) => ({
        panes: [
          ...s.panes,
          {
            paneId: paneId ?? `pane-${Date.now()}`,
            session,
            repo,
            projectName,
            projectIcon,
            projectColor,
            mode: readPaneMode(ccSessionId),
          },
        ],
      }))
      schedulePersist(get().panes)
      void get().refreshLiveSessions()
    } finally {
      resuming.delete(ccSessionId)
    }
  },

  setPaneMode: (paneId, mode) => {
    set((s) => ({
      panes: s.panes.map((p) => (p.paneId === paneId ? { ...p, mode } : p)),
    }))
    const pane = get().panes.find((p) => p.paneId === paneId)
    writePaneMode(pane?.session.ccSessionId ?? null, mode)
  },

  // Detach, NÃO mata: só tira da view + persiste. A PTY sobrevive no main
  // (background). Kill explícito é endSession.
  closePane: (paneId) => {
    set((s) => ({ panes: s.panes.filter((p) => p.paneId !== paneId) }))
    schedulePersist(get().panes)
    void get().refreshLiveSessions()
  },

  endSession: (sessionId, opts) => {
    if (opts?.immediate) {
      // Sem janela de undo: mata direto. Cancela um pending anterior se houver,
      // pra não disparar um segundo kill quando o timer expirar.
      const pending = pendingEnds.get(sessionId)
      if (pending) {
        clearTimeout(pending.timer)
        pendingEnds.delete(sessionId)
      }
      set((s) => ({
        panes: s.panes.filter((p) => p.session.id !== sessionId),
        liveSessions: s.liveSessions.filter((x) => x.id !== sessionId),
      }))
      schedulePersist(get().panes)
      void sessionsApi.kill(sessionId)
      void get().refreshLiveSessions()
      return
    }
    if (pendingEnds.has(sessionId)) return
    const pane = get().panes.find((p) => p.session.id === sessionId) ?? null
    const live = get().liveSessions.find((x) => x.id === sessionId) ?? null
    // Remoção otimista: pane e chip somem já; a PTY segue viva durante a janela
    // de undo (o refresh filtra pendingEnds pra ela não reaparecer na corrida).
    set((s) => ({
      panes: s.panes.filter((p) => p.session.id !== sessionId),
      liveSessions: s.liveSessions.filter((x) => x.id !== sessionId),
    }))
    schedulePersist(get().panes)
    // Kill só depois do toast sumir (graça): ver comentário em END_KILL_GRACE_MS.
    const timer = setTimeout(() => {
      pendingEnds.delete(sessionId)
      void sessionsApi.kill(sessionId)
      void get().refreshLiveSessions()
    }, END_UNDO_MS + END_KILL_GRACE_MS)
    pendingEnds.set(sessionId, { timer, pane, live })
    const name = live?.title ?? live?.name ?? pane?.session.title ?? live?.repo?.label
    showToast({
      title: 'Sessão encerrada',
      body: name ?? undefined,
      actionLabel: 'Desfazer',
      onAction: () => get().undoEndSession(sessionId),
      durationMs: END_UNDO_MS,
    })
  },

  undoEndSession: (sessionId) => {
    const pending = pendingEnds.get(sessionId)
    if (!pending) {
      // Janela expirou (kill já disparou/em voo). Não fingir sucesso em
      // silêncio — o usuário clicou "Desfazer" e precisa saber que não deu.
      showToast({ title: 'Tarde demais para desfazer', body: 'A sessão já foi encerrada.' })
      return
    }
    clearTimeout(pending.timer)
    pendingEnds.delete(sessionId)
    set((s) => ({
      // Não duplica se algo (ex: focusOrOpenSession) já recriou a pane no meio.
      panes:
        pending.pane && !s.panes.some((p) => p.session.id === sessionId)
          ? [...s.panes, pending.pane]
          : s.panes,
      liveSessions:
        pending.live && !s.liveSessions.some((x) => x.id === sessionId)
          ? [...s.liveSessions, pending.live]
          : s.liveSessions,
    }))
    schedulePersist(get().panes)
    void get().refreshLiveSessions()
  },

  focusOrOpenSession: async (item) => {
    const existing = get().panes.find((p) => paneShowsLive(p, item))
    if (existing) {
      set({ focusPaneId: existing.paneId, area: 'projects' })
      return
    }
    // Item da lista é sempre LIVE — re-attacha à PTY existente (sem segundo claude).
    const paneId = `pane-${Date.now()}`
    const pane = paneFromLiveSession(item, paneId)
    set((s) => ({ panes: [...s.panes, pane], area: 'projects', focusPaneId: paneId }))
    schedulePersist(get().panes)
    void get().refreshLiveSessions()
  },

  openSessionsInGrid: async (items) => {
    // Items são sempre LIVE (runningIds). Reusa a pane se já exibida; senão
    // re-attacha à PTY viva. Substitui a view por exatamente as N selecionadas
    // (as não-selecionadas saem da view; PTY segue viva no main). gridRequest
    // dispara o arranjo em grade no AppShell. Date.now() é fixo no tick, então
    // desambiguamos o paneId com item.id (UUID único da sessão).
    const current = get().panes
    const wanted: ActivePane[] = items.map(
      (item) =>
        current.find((p) => paneShowsLive(p, item)) ??
        paneFromLiveSession(item, `pane-${Date.now()}-${item.id}`),
    )
    set({
      panes: wanted,
      area: 'projects',
      gridRequest: wanted.map((p) => p.paneId),
    })
    schedulePersist(get().panes)
    void get().refreshLiveSessions()
  },

  startLiveWatch: async () => {
    // StrictMode monta o effect 2x; só uma assinatura real (a outra é no-op).
    if (liveWatchStarted) return
    liveWatchStarted = true
    const list = await sessionsApi.listLiveGlobal()
    set({ liveSessions: list })
    sessionsApi.watchGlobalActivity()
    offGlobalActivity = sessionsApi.onGlobalActivity((batch) => {
      // Merge incremental por ccSessionId: atualiza só entradas existentes,
      // ignora ids desconhecidos (o snapshot/refetch é quem adiciona/remove).
      const byId = new Map(batch.map((b) => [b.ccSessionId, b]))
      set((s) => ({
        liveSessions: s.liveSessions.map((sess) => {
          const u = byId.get(sess.ccSessionId)
          if (!u) return sess
          return {
            ...sess,
            status: u.status,
            lastActivityAt: u.lastActivityAt,
            lastText: u.lastText !== undefined ? u.lastText : sess.lastText,
            tokens: u.tokens ?? sess.tokens,
            // Substitui (não herda): ausente no batch = motivo limpo.
            attentionReason: u.attentionReason,
          }
        }),
      }))
    })
    // PTY que sai sozinha (filha do dock sem aba, antecessora do bastão, /exit)
    // não passa por mutação nenhuma do store: sem este refetch ela ficava na
    // lista — e no mapa, como "encerrada" — até outra coisa refazer o snapshot.
    offPtyExit = sessionsApi.onExit(() => {
      void get().refreshLiveSessions()
    })
  },

  stopLiveWatch: () => {
    if (offGlobalActivity) {
      offGlobalActivity()
      offGlobalActivity = null
    }
    if (offPtyExit) {
      offPtyExit()
      offPtyExit = null
    }
    sessionsApi.unwatchGlobalActivity()
    liveWatchStarted = false
    set({ liveSessions: [] })
  },

  refreshLiveSessions: async () => {
    // Só refetcha se o watch está ativo (evita popular fora do ciclo de vida).
    if (!liveWatchStarted) return
    const list = (await sessionsApi.listLiveGlobal()).filter(
      // Sessões na janela de undo já sumiram da UI, mas a PTY ainda vive no main
      // — sem o filtro o snapshot as reintroduziria antes do kill agendado.
      (sess) => !pendingEnds.has(sess.id),
    )
    // Preserva o status/atividade mais fresco do stream pras entradas que já
    // existiam — o snapshot pode estar atrás de um broadcast recente.
    const prev = new Map(get().liveSessions.map((s) => [s.ccSessionId, s]))
    set({
      liveSessions: list.map((sess) => {
        const p = prev.get(sess.ccSessionId)
        if (!p) return sess
        return {
          ...sess,
          status: p.status,
          // Anda junto com o status: os dois vêm do mesmo batch do stream.
          attentionReason: p.attentionReason,
          lastActivityAt: p.lastActivityAt ?? sess.lastActivityAt,
          lastText: p.lastText ?? sess.lastText,
          tokens: p.tokens ?? sess.tokens,
        }
      }),
    })
  },
}))
