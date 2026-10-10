import { create } from 'zustand'
import { prefsApi, roomApi, sessionsApi, workspaceApi } from '@/lib/ipc'
import { dismissToast, showToast } from '@/features/notifications/toast-store'
import { useSessionFeatureStore } from '@/store/sessionFeatureStore'
import { providerSupports } from '../../shared/agent-providers'
import { LAZY_RESTORE_PREF } from '../../shared/lazy-restore'
import type {
  AdvisorModel,
  AgentProviderId,
  EffortLevel,
  LiveSessionInfo,
  DormantBecameLiveEvent,
  DormantPaneInfo,
  PaneSnapshot,
  PermissionMode,
  Repo,
  Session,
  WakeRequest,
} from '../../shared/types/ipc'
import type { StartMotherInput, StartMotherResult } from '../../shared/types/feature-room'

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
  // Lazy restore: aba restaurada sem processo. A session é sintética
  // (id 'dormant:<cc>', status 'exited') e NUNCA vai a IPC; acorda por
  // ativação explícita (wakeDormantPane), mantendo o paneId.
  dormant?: true
  // Dormant porque o resume do boot falhou (ex.: conversa aberta em outro
  // processo). A aba fica no layout e no open_panes com o erro à vista e o
  // Retomar; vale mesmo com a pref de lazy restore desligada.
  restoreError?: string
}

const DORMANT_ID_PREFIX = 'dormant:'

export function isDormantSessionId(id: string | null | undefined): boolean {
  return !!id && id.startsWith(DORMANT_ID_PREFIX)
}

function dormantPaneFromSnapshot(
  snap: PaneSnapshot,
  paneId: string,
  restoreError?: string,
): ActivePane {
  return {
    paneId,
    session: {
      id: `${DORMANT_ID_PREFIX}${snap.ccSessionId}`,
      repoId: snap.repo?.id ?? null,
      ccSessionId: snap.ccSessionId,
      title: null,
      titleSource: null,
      paneId,
      status: 'exited',
      startedAt: Date.now(),
      endedAt: null,
      provider: 'claude',
    },
    repo: snap.repo,
    projectName: snap.projectName,
    projectIcon: snap.projectIcon,
    projectColor: snap.projectColor ?? null,
    mode: readPaneMode(snap.ccSessionId),
    dormant: true,
    ...(restoreError ? { restoreError } : {}),
  }
}

// "Error invoking remote method 'sessions:resume': Error: <msg>" → "<msg>".
function ipcErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  return raw.replace(/^Error invoking remote method '[^']*':\s*(?:\w*Error:\s*)?/, '')
}

// Pane ativa do layout salvo do dockview: activeGroup → o grupo na árvore do
// grid → activeView. Ela sobe eager (é a que o usuário vê ao abrir). Formato
// inesperado = nenhuma, sem quebrar o boot.
export function activePaneIdFromLayout(raw: string | null | undefined): string | null {
  if (!raw) return null
  try {
    const layout = JSON.parse(raw) as {
      activeGroup?: unknown
      grid?: { root?: unknown }
      floatingGroups?: { data?: unknown }[]
    }
    if (typeof layout?.activeGroup !== 'string') return null
    const stack: unknown[] = [layout.grid?.root, ...(layout.floatingGroups ?? [])]
    while (stack.length) {
      const node = stack.pop() as { data?: unknown } | null | undefined
      if (!node || typeof node !== 'object') continue
      if (Array.isArray(node.data)) {
        stack.push(...node.data)
        continue
      }
      const group = node.data as { id?: unknown; views?: unknown; activeView?: unknown }
      if (group?.id !== layout.activeGroup) continue
      if (typeof group.activeView === 'string') return group.activeView
      return Array.isArray(group.views) && typeof group.views[0] === 'string'
        ? group.views[0]
        : null
    }
    return null
  } catch {
    return null
  }
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
  {
    timer: ReturnType<typeof setTimeout>
    pane: ActivePane | null
    live: LiveSessionInfo | null
    toastId: number
  }
>()

// A guarda do main re-anexa a PTY viva da conversa, inclusive uma que está na
// janela de undo de um endSession: quem acabou de retomá-la a quer viva, então o
// kill agendado (e o toast de desfazer, que não teria mais o que desfazer) caem.
function cancelPendingEnd(sessionId: string): void {
  const pending = pendingEnds.get(sessionId)
  if (!pending) return
  clearTimeout(pending.timer)
  pendingEnds.delete(sessionId)
  dismissToast(pending.toastId)
}

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
// O valor é o desfecho do resume em voo: null = subiu; string = o erro.
const resuming = new Map<string, Promise<string | null>>()

// Dono único da assinatura do stream global de atividade (strip + overlay leem o
// mesmo `liveSessions`). `offGlobalActivity` guarda o unsubscribe do onGlobalActivity;
// `liveWatchStarted` guarda contra o duplo-mount do StrictMode.
let offGlobalActivity: (() => void) | null = null
let offPtyExit: (() => void) | null = null
let offRoomChanged: (() => void) | null = null
let roomRefreshTimer: ReturnType<typeof setTimeout> | null = null
let liveWatchStarted = false
let offWakeRequest: (() => void) | null = null
let offDormantBecameLive: (() => void) | null = null
// Um wake em voo por paneId: ativação + clique + pedido do main ao mesmo tempo
// resultam num único resume.
const wakes = new Map<string, Promise<string | null>>()
// cc dos wakes em voo: a pane pode sair do store (closePane) antes de o resume
// voltar, e o restore não pode pôr uma dormant para uma conversa subindo.
const wakingCc = new Set<string>()
// paneIds encerradas (endSession) com o wake em voo: o resume que voltar é morto.
// closePane é detach e não entra aqui: a PTY fica em background, como sempre.
const endedWhileWaking = new Set<string>()
// room:changed chega em rajada (handoffs/loop coalescidos a 300ms no main);
// um refetch por janela basta.
export const ROOM_REFRESH_DEBOUNCE_MS = 150

// Durante o restore as panes entram aos poucos (attached, eager, dormant): um save
// no meio gravaria um subconjunto no open_panes, e é ele que o próximo boot
// restaura se o app cair agora. O save fica para o fim, com o conjunto final.
let restoringDepth = 0
let persistDeferred = false

async function withPersistDeferred<T>(run: () => Promise<T>): Promise<T> {
  if (restoringDepth === 0 && savePanesTimer) {
    // Um save agendado antes do restore cairia no meio dele com o conjunto velho.
    clearTimeout(savePanesTimer)
    savePanesTimer = null
    persistDeferred = true
  }
  restoringDepth += 1
  try {
    return await run()
  } finally {
    restoringDepth -= 1
    if (restoringDepth === 0 && persistDeferred) {
      persistDeferred = false
      schedulePersist(useAppStore.getState().panes)
    }
  }
}

// Persiste um snapshot enxuto (suficiente pra resume sem lookups), com debounce
// pra não gravar a cada teclada de spawn/close em sequência.
function schedulePersist(panes: ActivePane[]): void {
  if (restoringDepth > 0) {
    persistDeferred = true
    return
  }
  if (savePanesTimer) clearTimeout(savePanesTimer)
  savePanesTimer = setTimeout(() => {
    // Dormant entra igual: o snapshot é o mesmo, e o próximo boot decide de novo.
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
// individual não aborta os demais: devolve os resumes que falharam, para a aba
// voltar dormant com o erro em vez de sumir do layout e do open_panes.
// Sessões com transcript retomam (--resume); as sem (spawn que nunca conversou)
// viram sessão NOVA no mesmo repo, mantendo o paneId pra o layout do dockview bater.
function keepPaneOfFailedResume(snap: PaneSnapshot, error: string | null): void {
  const cc = snap.ccSessionId
  if (error === null || resuming.has(cc)) return
  const { panes } = useAppStore.getState()
  if (panes.some((p) => p.session.ccSessionId === cc)) return
  const pane = dormantPaneFromSnapshot(snap, snap.paneId ?? `pane-${cc}`, error)
  useAppStore.setState((s) => ({ panes: [...s.panes, pane] }))
  schedulePersist(useAppStore.getState().panes)
}

async function restoreFromSnapshots(
  snapshots: PaneSnapshot[],
  resume: AppState['resumeSession'],
  open: AppState['openSession'],
  limit = 4,
): Promise<{ snap: PaneSnapshot; error: string }[]> {
  const failed: { snap: PaneSnapshot; error: string }[] = []
  const queue = [...snapshots]
  async function worker(): Promise<void> {
    let snap = queue.shift()
    while (snap) {
      const current = snap
      let resumable = false
      try {
        resumable = await sessionsApi.isResumable(current.ccSessionId)
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
      } catch (err) {
        // Pane individual não restaurável — segue restaurando as outras. Sem
        // transcript (spawn falhou) não há o que retomar depois: segue fora.
        if (resumable) failed.push({ snap: current, error: ipcErrorMessage(err) })
      }
      snap = queue.shift()
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, snapshots.length) }, worker))
  return failed
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

// Lazy restore: das abas sem PTY viva, quais sobem processo agora. Eager = plano
// do main (handoff ativo, pref) + a pane ativa do layout + sem transcript (vira
// sessão nova, como sempre). O resto volta dormant. Plano indisponível = tudo
// eager, o comportamento de antes.
async function splitDormantSnapshots(
  snapshots: PaneSnapshot[],
  dockLayout: string | null,
  lazy: boolean,
): Promise<{ eager: PaneSnapshot[]; dormant: PaneSnapshot[] }> {
  if (!lazy) return { eager: snapshots, dormant: [] }
  if (snapshots.length === 0) return { eager: [], dormant: [] }
  const plan = await sessionsApi.restorePlan(snapshots.map((s) => s.ccSessionId)).catch(() => null)
  if (!plan || plan.mode === 'eager') return { eager: snapshots, dormant: [] }
  const eagerCc = new Set(plan.eagerCcSessionIds)
  const activePaneId = activePaneIdFromLayout(dockLayout)
  const eager: PaneSnapshot[] = []
  const candidates: PaneSnapshot[] = []
  for (const snap of snapshots) {
    if (eagerCc.has(snap.ccSessionId) || (activePaneId && snap.paneId === activePaneId))
      eager.push(snap)
    else candidates.push(snap)
  }
  const resumable = await Promise.all(
    candidates.map((s) => sessionsApi.isResumable(s.ccSessionId).catch(() => false)),
  )
  const dormant: PaneSnapshot[] = []
  candidates.forEach((snap, i) => (resumable[i] ? dormant : eager).push(snap))
  return { eager, dormant }
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
  // Pref sessions.lazyRestore, lida uma vez no restore e congelada para o processo
  // (vale a partir do próximo boot). null = ainda não lida. Fora do true o renderer
  // se comporta como antes da feature: tudo eager, sem espelho, sem wake por ativação.
  lazyRestore: boolean | null
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
  // Re-attacha às PTYs vivas; das demais só sobem processo as eager (plano do
  // main + pane ativa do layout + sem transcript). O resto volta dormant.
  restoreSnapshots: (snapshots: PaneSnapshot[], dockLayout?: string | null) => Promise<void>
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
  // Retoma a pane dormant no lugar (mesmo paneId). Devolve o sessions.id novo, ou
  // null se não deu. Idempotente: pane já acordada devolve o id atual.
  wakeDormantPane: (paneId: string) => Promise<string | null>
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
  // Inicia a mãe da Room (room:start-mother). O main só avisa room:changed, então
  // o snapshot vivo é refeito aqui antes de voltar — sem isso o Peek abria sobre
  // uma sessão ausente de liveSessions e fechava na hora.
  startMother: (input: StartMotherInput) => Promise<StartMotherResult>
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
  lazyRestore: null,
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
    await loadLazyRestore()
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
    await get().restoreSnapshots(openPanes, dockLayout)
    await workspaceApi.resetRestoreAttempts()
    set({ restoreComplete: true })
  },

  retryRestore: async () => {
    const { openPanes, dockLayout } = await workspaceApi.getBootState()
    set({ restoreBlocked: false })
    if (dockLayout && openPanes.every((p) => p.paneId)) set({ pendingLayout: dockLayout })
    await get().restoreSnapshots(openPanes, dockLayout)
    await workspaceApi.resetRestoreAttempts()
  },

  restoreSnapshots: async (snapshots, dockLayout = null) => {
    const lazy = await loadLazyRestore()
    // Com a pref desligada o persist segue o timing da main (save a cada pane).
    const run = lazy ? withPersistDeferred : (fn: () => Promise<void>) => fn()
    return run(async () => {
      const live = await sessionsApi.listLiveGlobal().catch(() => [])
      const { attached, rest } = splitLiveSnapshots(snapshots, live)
      const fresh = attached.filter((a) => !get().panes.some((p) => p.session.id === a.session.id))
      if (fresh.length) {
        set((s) => ({ panes: [...s.panes, ...fresh] }))
        schedulePersist(get().panes)
      }
      const { eager, dormant } = await splitDormantSnapshots(rest, dockLayout, lazy)
      // Dormant só entram DEPOIS das eager: o AppShell arma o fallback de 1,5s do
      // layout quando a primeira pane do layout aparece. Com as dormant em t0, uma
      // eager lenta perdia o lugar no layout.
      const failed = await restoreFromSnapshots(eager, get().resumeSession, get().openSession)
      // Resume/wake em voo da mesma conversa (switcher, wake do main) já vai pôr a
      // pane viva: a dormant seria uma segunda aba dela.
      const inflight = new Map(resuming)
      const known = new Set([
        ...get().panes.map((p) => p.session.ccSessionId),
        ...inflight.keys(),
        ...wakingCc,
      ])
      const candidates = [
        ...failed,
        ...dormant.map((snap) => ({ snap, error: undefined as string | undefined })),
      ]
      const sleeping = candidates
        .filter(({ snap }) => !known.has(snap.ccSessionId))
        .map(({ snap, error }) =>
          dormantPaneFromSnapshot(snap, snap.paneId ?? `pane-${snap.ccSessionId}`, error),
        )
      if (sleeping.length) {
        set((s) => ({ panes: [...s.panes, ...sleeping] }))
        schedulePersist(get().panes)
      }
      // O resume em voo que fez a pane ser pulada pode falhar, e aí ninguém a põe:
      // o open_panes ficaria sem ela. Se falhar, ela volta dormant com o erro (com a
      // pref desligada também, como a eager que falha). Sem esperar aqui: um resume
      // lento não segura o restore nem o save do fim.
      for (const { snap } of candidates) {
        const outcome = inflight.get(snap.ccSessionId)
        if (outcome) void outcome.then((error) => keepPaneOfFailedResume(snap, error))
      }
    })
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
    // Já existe a aba dormindo desta conversa: acorda ELA (foco + wake), nunca uma
    // segunda pane para o mesmo cc.
    const sleeping = get().panes.find((p) => p.dormant && p.session.ccSessionId === ccSessionId)
    if (sleeping) {
      set({ focusPaneId: sleeping.paneId, area: 'projects' })
      await get().wakeDormantPane(sleeping.paneId)
      return
    }
    // Já há uma pane com essa sessão aberta? Não duplicar.
    if (get().panes.some((p) => p.session.ccSessionId === ccSessionId)) return
    // Resume em voo da mesma conversa: este segue o desfecho dele. Se ele falhar,
    // quem chamou (o restore) recebe o erro e a aba volta dormant em vez de sumir.
    const inflight = resuming.get(ccSessionId)
    if (inflight) {
      const error = await inflight
      if (error !== null) throw new Error(error)
      return
    }
    // Reservado de forma síncrona antes do await pra fechar a corrida.
    let settle!: (error: string | null) => void
    resuming.set(ccSessionId, new Promise((resolve) => (settle = resolve)))
    try {
      const { session, reattached } = await sessionsApi.resume({
        repoId: repo?.id ?? null,
        ccSessionId,
      })
      if (reattached) cancelPendingEnd(session.id)
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
      settle(null)
    } catch (err) {
      settle(ipcErrorMessage(err))
      throw err
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

  wakeDormantPane: (paneId) => {
    const inflight = wakes.get(paneId)
    if (inflight) return inflight
    const pane = get().panes.find((p) => p.paneId === paneId)
    if (!pane?.dormant) return Promise.resolve(pane ? pane.session.id : null)
    const ccSessionId = pane.session.ccSessionId as string
    const run = (async () => {
      try {
        // A guarda do main devolve a sessão existente se a PTY desse cc já vive.
        const { session, reattached } = await sessionsApi.resume({
          repoId: pane.repo?.id ?? null,
          ccSessionId,
        })
        if (reattached) cancelPendingEnd(session.id)
        if (endedWhileWaking.delete(paneId)) {
          // Encerrada com o wake em voo: o processo que este wake subiu morre. Uma
          // sessão que a guarda do main re-anexou (já vivia antes) não é nossa.
          if (!reattached) void sessionsApi.kill(session.id)
          return null
        }
        adoptLiveSession(paneId, session)
        return session.id
      } catch (err) {
        const message = ipcErrorMessage(err)
        // A pane com erro de restore mostra o motivo novo no lugar do antigo.
        set((s) => ({
          panes: s.panes.map((p) =>
            p.paneId === paneId && p.dormant && p.restoreError
              ? { ...p, restoreError: message }
              : p,
          ),
        }))
        showToast({ title: 'Não deu para retomar a sessão', body: message })
        return null
      } finally {
        wakes.delete(paneId)
        wakingCc.delete(ccSessionId)
        endedWhileWaking.delete(paneId)
      }
    })()
    wakes.set(paneId, run)
    wakingCc.add(ccSessionId)
    return run
  },

  // Detach, NÃO mata: só tira da view + persiste. A PTY sobrevive no main
  // (background). Kill explícito é endSession.
  closePane: (paneId) => {
    const closed = get().panes.find((p) => p.paneId === paneId)
    set((s) => ({ panes: s.panes.filter((p) => p.paneId !== paneId) }))
    schedulePersist(get().panes)
    void get().refreshLiveSessions()
    // Dormindo não tem PTY em background: fechar é perder a aba de vez. O desfazer
    // devolve a MESMA pane (paneId e snapshot), como o do endSession.
    if (closed?.dormant) {
      showToast({
        title: 'Aba fechada',
        body: closed.session.title ?? closed.repo?.label ?? undefined,
        actionLabel: 'Desfazer',
        onAction: () => {
          const cc = closed.session.ccSessionId
          set((s) =>
            s.panes.some((p) => p.paneId === paneId || (cc && p.session.ccSessionId === cc))
              ? s
              : { panes: [...s.panes, closed] },
          )
          schedulePersist(get().panes)
        },
        durationMs: END_UNDO_MS,
      })
    }
  },

  endSession: (sessionId, opts) => {
    // Pane dormant não tem processo: encerrar é só tirá-la, sem IPC com o id sintético.
    if (isDormantSessionId(sessionId)) {
      const pane = get().panes.find((p) => p.session.id === sessionId)
      if (pane && wakes.has(pane.paneId)) endedWhileWaking.add(pane.paneId)
      set((s) => ({ panes: s.panes.filter((p) => p.session.id !== sessionId) }))
      schedulePersist(get().panes)
      return
    }
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
    const name = live?.title ?? live?.name ?? pane?.session.title ?? live?.repo?.label
    const toastId = showToast({
      title: 'Sessão encerrada',
      body: name ?? undefined,
      actionLabel: 'Desfazer',
      onAction: () => get().undoEndSession(sessionId),
      durationMs: END_UNDO_MS,
    })
    pendingEnds.set(sessionId, { timer, pane, live, toastId })
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
      if (existing.dormant) await get().wakeDormantPane(existing.paneId)
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
    const wanted: ActivePane[] = items.map((item) => {
      const existing = current.find((p) => paneShowsLive(p, item))
      // Aba dormindo de uma sessão que já tem PTY viva: anexa no lugar, sem resume.
      if (existing?.dormant) return paneFromLiveSession(item, existing.paneId)
      return existing ?? paneFromLiveSession(item, `pane-${Date.now()}-${item.id}`)
    })
    // Dormindo fora da seleção fica: não tem processo no main, então tirá-la do
    // store (e do open_panes) perderia a conversa da restauração. O AppShell a
    // põe como aba inativa, fora da grade.
    const keptDormant = current.filter(
      (p) => p.dormant && !wanted.some((w) => w.paneId === p.paneId),
    )
    set({
      panes: [...wanted, ...keptDormant],
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
    // Antes do primeiro await: o main pode pedir wake assim que recebe o sync.
    offWakeRequest = sessionsApi.onWakeRequest((request) => void answerWakeRequest(request))
    offDormantBecameLive = sessionsApi.onDormantBecameLive(onDormantBecameLive)
    // Boot sem nenhuma pane não muda `panes`: o sync inicial sai daqui.
    syncDormantPanes(get().panes)
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
    // Sessão criada pela Room (mãe via room:start-mother, ou outro caminho) não
    // emite evento de sessão nova: o main só avisa room:changed. Sem refetch aqui,
    // a mãe não entrava em liveSessions e o Peek fechava na hora.
    offRoomChanged = roomApi.onChanged(() => {
      if (roomRefreshTimer) clearTimeout(roomRefreshTimer)
      roomRefreshTimer = setTimeout(() => {
        roomRefreshTimer = null
        void get().refreshLiveSessions()
      }, ROOM_REFRESH_DEBOUNCE_MS)
    })
  },

  stopLiveWatch: () => {
    if (offWakeRequest) {
      offWakeRequest()
      offWakeRequest = null
    }
    if (offDormantBecameLive) {
      offDormantBecameLive()
      offDormantBecameLive = null
    }
    if (offGlobalActivity) {
      offGlobalActivity()
      offGlobalActivity = null
    }
    if (offPtyExit) {
      offPtyExit()
      offPtyExit = null
    }
    if (offRoomChanged) {
      offRoomChanged()
      offRoomChanged = null
    }
    if (roomRefreshTimer) {
      clearTimeout(roomRefreshTimer)
      roomRefreshTimer = null
    }
    sessionsApi.unwatchGlobalActivity()
    liveWatchStarted = false
    lastDormantKey = null
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

  startMother: async (input) => {
    const res = await roomApi.startMother(input)
    useSessionFeatureStore.getState().note(res.sessionId, input.featureId)
    await get().refreshLiveSessions()
    return res
  },
}))

// A pane dormant passa a mostrar a sessão viva no lugar (mesmo paneId). Se outra
// pane já mostra essa sessão (a guarda do main re-anexou uma PTY que já tinha
// aba), a dormant sai e o foco vai para a existente: duas abas da mesma PTY não.
function adoptLiveSession(paneId: string, session: Session): void {
  const { panes } = useAppStore.getState()
  const existing = panes.find(
    (p) => p.paneId !== paneId && !p.dormant && p.session.id === session.id,
  )
  if (existing) {
    useAppStore.setState({
      panes: panes.filter((p) => p.paneId !== paneId),
      focusPaneId: existing.paneId,
    })
  } else {
    useAppStore.setState({
      panes: panes.map((p) => {
        if (p.paneId !== paneId || !p.dormant) return p
        const { dormant: _dormant, restoreError: _error, ...awake } = p
        return { ...awake, session }
      }),
    })
  }
  schedulePersist(useAppStore.getState().panes)
  void useAppStore.getState().refreshLiveSessions()
}

// O main retomou (handoffs:resume/adopt) a conversa de uma pane dormindo: a pane
// passa a mostrar essa sessão, sem um segundo resume.
function onDormantBecameLive({ ccSessionId, session }: DormantBecameLiveEvent): void {
  const pane = useAppStore
    .getState()
    .panes.find((p) => p.dormant && p.session.ccSessionId === ccSessionId)
  if (pane) adoptLiveSession(pane.paneId, session)
}

// Wake pedido pelo main (agent-bus, wake da mãe, send-prompt): mesmo caminho do
// clique. Se a pane já acordou por outro caminho, devolve o id atual.
async function answerWakeRequest({ requestId, ccSessionId }: WakeRequest): Promise<void> {
  const find = () => useAppStore.getState().panes.find((p) => p.session.ccSessionId === ccSessionId)
  let pane = find()
  // O main pode pedir antes de o restore pôr as dormant no store (o sync do
  // processo anterior sobrevive ao reload): espera o restore antes de negar.
  if (!pane && !useAppStore.getState().restoreComplete) {
    await waitForRestore(WAKE_RESTORE_WAIT_MS)
    pane = find()
  }
  // Pref desligada: o main não deveria pedir (o registro dele fica vazio); se
  // pedir, nada acorda.
  if (useAppStore.getState().lazyRestore !== true) {
    void sessionsApi.wakeResult({ requestId, sessionId: null, error: 'lazy-restore-off' })
    return
  }
  if (!pane) {
    void sessionsApi.wakeResult({ requestId, sessionId: null, error: 'no-dormant-pane' })
    return
  }
  const sessionId = await useAppStore.getState().wakeDormantPane(pane.paneId)
  void sessionsApi.wakeResult(
    sessionId ? { requestId, sessionId } : { requestId, sessionId: null, error: 'resume-failed' },
  )
}

export const WAKE_RESTORE_WAIT_MS = 20_000

async function loadLazyRestore(): Promise<boolean> {
  const current = useAppStore.getState().lazyRestore
  if (current !== null) return current
  const on = await Promise.resolve()
    .then(() => prefsApi.get<unknown>(LAZY_RESTORE_PREF))
    .then((value) => value === true)
    .catch(() => false)
  useAppStore.setState({ lazyRestore: on })
  return on
}

function waitForRestore(timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    let off = () => {}
    const timer = setTimeout(() => {
      off()
      resolve()
    }, timeoutMs)
    off = useAppStore.subscribe((state) => {
      if (!state.restoreComplete) return
      clearTimeout(timer)
      off()
      resolve()
    })
  })
}

// O main espelha as panes dormindo (lista inteira) para conseguir acordá-las.
// Assinatura no store: pega toda mutação de panes sem cada action lembrar disso.
// Só com o live-watch ativo: é ele que escuta os wake-requests, sem ele o
// espelho não serve. null = nada enviado neste ciclo; depois de um reload o main
// ainda guarda a lista do processo anterior, então o primeiro sync sai sempre,
// vazio ou não.
let lastDormantKey: string | null = null
function dormantList(panes: ActivePane[]): DormantPaneInfo[] {
  return panes
    .filter((p) => p.dormant && p.session.ccSessionId)
    .map((p) => ({
      ccSessionId: p.session.ccSessionId as string,
      paneId: p.paneId,
      title: p.session.title,
      repoId: p.repo?.id ?? null,
    }))
}
function syncDormantPanes(panes: ActivePane[]): void {
  // Pref desligada: nada de espelho, como antes da feature.
  if (!liveWatchStarted || useAppStore.getState().lazyRestore !== true) return
  const list = dormantList(panes)
  const key = JSON.stringify(list)
  if (key === lastDormantKey) return
  lastDormantKey = key
  void sessionsApi
    .dormantSync(list)
    .then(applyDormantTitles)
    .catch(() => {
      // Sem o espelho o main só não acha a pane para acordar; o renderer segue igual.
      lastDormantKey = null
    })
}

// O snapshot não guarda o título: a pane dormindo nasce com title null e a aba
// caía no rótulo do repo ("Avulsa") a cada recriação do painel. O main devolve o
// título do DB; só preenche quem ainda está sem (resposta atrasada não sobrescreve
// nada). A chave do sync passa a ser a da lista já com o título — é o que o main
// guardou — então aplicar não dispara outro sync.
function applyDormantTitles(enriched: DormantPaneInfo[]): void {
  const byPane = new Map(enriched.map((info) => [info.paneId, info]))
  const panes = useAppStore.getState().panes
  let changed = false
  const next = panes.map((p) => {
    const info = byPane.get(p.paneId)
    if (!p.dormant || p.session.title !== null || !info?.title) return p
    if (info.ccSessionId !== p.session.ccSessionId) return p
    changed = true
    return { ...p, session: { ...p.session, title: info.title } }
  })
  if (!changed) return
  lastDormantKey = JSON.stringify(dormantList(next))
  useAppStore.setState({ panes: next })
}
useAppStore.subscribe((state, prev) => {
  // A pref chega depois do live-watch no boot: ligá-la manda o primeiro sync.
  if (state.panes !== prev.panes || state.lazyRestore !== prev.lazyRestore)
    syncDormantPanes(state.panes)
})
