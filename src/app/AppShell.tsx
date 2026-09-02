import 'dockview/dist/styles/dockview.css'

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  DockviewDefaultTab,
  DockviewReact,
  themeAbyss,
  type DockviewApi,
  type DockviewReadyEvent,
  type IDockviewPanelHeaderProps,
  type IDockviewPanelProps,
} from 'dockview'
import { FolderTree, PanelLeftOpen } from 'lucide-react'
import { IconRail } from './IconRail'
import { Icon } from '@/components/ui/Icon'
import { ProjectsSidebar } from '@/features/projects/ProjectsSidebar'
import { CcConfigsArea } from '@/features/cc-configs/CcConfigsArea'
import { MetricsArea } from '@/features/metrics/MetricsArea'
import { FeaturesArea } from '@/features/features/FeaturesArea'
import { ObjectivesArea } from '@/features/objectives/ObjectivesArea'
import { ArchitectureArea } from '@/features/architecture/ArchitectureArea'
import { OverviewArea } from '@/features/overview/OverviewArea'
import { TasksArea } from '@/features/tasks/TasksArea'
import { DiagramsArea } from '@/features/diagrams/DiagramsArea'
import { DesignArea } from '@/features/design/DesignArea'
import { VideosArea } from '@/features/videos/VideosArea'
import { MeetingsArea } from '@/features/meetings/MeetingsArea'
import { Terminal } from '@/features/sessions/Terminal'
import { SessionFeatureChip } from '@/features/sessions/SessionFeatureChip'
import { SettingsDialog } from '@/features/settings/SettingsDialog'
import { CommandPalette } from '@/features/command-palette/CommandPalette'
import { SessionStrip } from '@/features/session-switcher/SessionStrip'
import { SessionSwitcher } from '@/features/session-switcher/SessionSwitcher'
import { NewSessionFlow } from '@/features/sessions/NewSessionFlow'
import { UpdateToast } from '@/features/updates/UpdateToast'
import { NotificationToast } from '@/features/notifications/NotificationToast'
import { useAppStore, setDefaultPaneModeFallback, type ActivePane } from '@/store/appStore'
import { useSessionPrefsStore } from '@/lib/session-prefs-store'
import { projectsApi, sessionsApi, workspaceApi } from '@/lib/ipc'
import { matchCombo, resolveCombo } from '@/lib/keybindings'
import { useKeybindingsStore } from '@/lib/keybindings-store'
import { useTerminalPrefsStore } from '@/lib/terminal-prefs-store'
import { useFilesStore } from '@/lib/files-store'
import { FilesPanel } from '@/features/files/FilesPanel'
import { HandoffApprovalDialog } from '@/features/handoffs/HandoffApprovalDialog'
import { HandoffsPanel } from '@/features/handoffs/HandoffsPanel'
import { CrewDock, useCrewDockWidth } from '@/features/handoffs/CrewDock'
import { CrewPeek } from '@/features/handoffs/CrewPeek'
import { useCrewDockStore } from '@/features/handoffs/crew-dock-store'
import { useHandoffs } from '@/features/handoffs/useHandoffs'

interface PaneParams {
  pane: ActivePane
}

// O dockview renderiza este painel fora da árvore do AppShell, então em vez de
// prop drilling usamos um CustomEvent pra pedir a abertura das Configurações.
function requestOpenSettings() {
  window.dispatchEvent(new CustomEvent('cm:open-settings'))
}

function TerminalPanel(props: IDockviewPanelProps<PaneParams>) {
  const closePane = useAppStore((s) => s.closePane)
  const openSession = useAppStore((s) => s.openSession)
  const endSession = useAppStore((s) => s.endSession)
  const setPaneMode = useAppStore((s) => s.setPaneMode)
  // Busca a pane no store pelo id do painel (= paneId). Após api.fromJSON do
  // restore, os params serializados no JSON podem estar stale (session/repo são
  // recriados pelo resume), então a fonte da verdade é sempre o store. Fallback
  // para os params se ainda não estiver no store (transição de addPanel).
  const fromStore = useAppStore((s) => s.panes.find((p) => p.paneId === props.api.id))
  const pane = fromStore ?? props.params.pane
  // Painel órfão: existe no dockview mas a pane sumiu do store (resume falhou ou
  // foi fechada). Nada a renderizar — o effect de restore/reconcile vai removê-lo.
  if (!pane) return null
  return (
    <Terminal
      session={pane.session}
      repoLabel={pane.repo?.label ?? 'Avulsa'}
      repoPath={pane.repo?.path ?? ''}
      projectName={pane.projectName ?? ''}
      projectIcon={pane.projectIcon}
      projectColor={pane.projectColor}
      mode={pane.mode}
      onToggleMode={() => setPaneMode(pane.paneId, pane.mode === 'chat' ? 'terminal' : 'chat')}
      onClose={() => closePane(pane.paneId)}
      onTitleChange={(t) => props.api.setTitle(t)}
      onReopen={() => {
        // closePane não mata mais; kill explícito evita vazar a PTY antiga.
        // immediate: a sessão já está exited — passar pelo fluxo de undo
        // mostraria um toast espúrio cujo "Desfazer" restauraria a pane morta
        // ao lado da recém-reaberta.
        endSession(pane.session.id, { immediate: true })
        void openSession(pane.repo, pane.projectName, pane.projectIcon, pane.projectColor)
      }}
      onOpenSettings={requestOpenSettings}
    />
  )
}

// Aba do dockview com um dot na cor do projeto antes do título/close padrão.
// Reusa DockviewDefaultTab pra herdar o título dinâmico (api.title via setTitle) e o X.
function TerminalTab(props: IDockviewPanelHeaderProps<PaneParams>) {
  // Mesma regra do TerminalPanel: a pane vem do STORE pelo id do painel
  // (= paneId). Os params serializados podem estar stale depois do fromJSON — e
  // ali a sessão é OUTRA (recriada pelo resume), então o id de params levaria a
  // marca da feature errada (ou a nenhuma).
  const pane = useAppStore((s) => s.panes.find((p) => p.paneId === props.api.id))
  const color = (pane ?? props.params.pane)?.projectColor ?? null
  return (
    <div className="flex items-center">
      <span
        className="ml-2 mr-1.5 h-2 w-2 shrink-0 rounded-full"
        style={{ background: color ?? 'var(--color-border)' }}
      />
      <DockviewDefaultTab {...props} />
      <SessionFeatureChip sessionId={pane?.session.id} density="dot" className="mr-1.5" />
    </div>
  )
}

// Título inicial legível pra aba (nunca o paneId). O Terminal sobrescreve ao vivo
// via onTitleChange assim que o nome do CC chega.
function paneTabTitle(pane: ActivePane): string {
  const repoLabel = pane.repo?.label ?? 'Avulsa'
  if (!pane.projectName) return repoLabel
  return `${pane.projectIcon ?? ''} ${repoLabel}`.trim()
}

const components = { terminal: TerminalPanel }
const tabComponents = { terminal: TerminalTab }

export function AppShell() {
  const area = useAppStore((s) => s.area)
  const sidebarCollapsed = useAppStore((s) => s.sidebarCollapsed)
  const toggleSidebar = useAppStore((s) => s.toggleSidebar)
  const panes = useAppStore((s) => s.panes)
  const closePane = useAppStore((s) => s.closePane)
  const openSession = useAppStore((s) => s.openSession)
  const restoreBlocked = useAppStore((s) => s.restoreBlocked)
  const retryRestore = useAppStore((s) => s.retryRestore)
  const pendingLayout = useAppStore((s) => s.pendingLayout)
  const clearPendingLayout = useAppStore((s) => s.clearPendingLayout)
  const focusPaneId = useAppStore((s) => s.focusPaneId)
  const clearFocusPane = useAppStore((s) => s.clearFocusPane)
  const gridRequest = useAppStore((s) => s.gridRequest)
  const clearGridRequest = useAppStore((s) => s.clearGridRequest)
  const startLiveWatch = useAppStore((s) => s.startLiveWatch)
  const stopLiveWatch = useAppStore((s) => s.stopLiveWatch)
  const activeProjectId = useAppStore((s) => s.activeProjectId)
  const filesOpen = useFilesStore((s) => s.open)
  const toggleFiles = useFilesStore((s) => s.toggle)
  const setFileRoots = useFilesStore((s) => s.setRoots)
  const fileRoots = useFilesStore((s) => s.roots)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [switcherOpen, setSwitcherOpen] = useState(false)
  const [newSessionOpen, setNewSessionOpen] = useState(false)
  const overrides = useKeybindingsStore((s) => s.overrides)
  const loadKeybindings = useKeybindingsStore((s) => s.load)
  // A pilha de toasts encosta na direita — onde o Crew Dock vive. Recua pela
  // largura dele pra não cobrir os cards das filhas (e o input de resposta).
  const crewDockWidth = useCrewDockWidth()

  // Handoffs cross-repo: assina pendentes + aplica auto-approve (gate humano via
  // <HandoffApprovalDialog/> quando o auto-approve está desligado).
  useHandoffs()

  const apiRef = useRef<DockviewApi | null>(null)
  const [ready, setReady] = useState(false)
  // Pane ativo do dockview (espelho em state pra efeitos reagirem à troca).
  const [activePanelId, setActivePanelId] = useState<string | null>(null)
  // paneIds que o store já removeu — usado pra suprimir o eco do onDidRemovePanel
  // (quando nós mesmos chamamos api.removePanel, ele dispara o evento de volta).
  const removingFromStore = useRef(new Set<string>())
  // Posição do próximo painel novo. O atalho seta a intent ANTES de openSession;
  // o reconcile consome no addPanel (relativo ao painel ativo) e reseta pra default.
  // 'tab' = mesmo grupo do ativo; 'right'/'below' = split. undefined = clique normal
  // no repo, mantendo o comportamento atual (split à direita do ativo).
  const nextPosition = useRef<'tab' | 'right' | 'below' | undefined>(undefined)
  // Guard: true enquanto api.fromJSON do restore roda — suprime persist e a
  // reconciliação store→dockview (que duplicaria/removeria painéis).
  const applyingLayout = useRef(false)
  // false até o fluxo de restore concluir (ou se não houver restore pendente).
  // Enquanto false, NÃO persistimos layout (evita sobrescrever o salvo com vazio
  // antes das panes voltarem).
  const restoreDone = useRef(false)
  // Timer de fallback: aplica o layout parcial se algum resume não voltar a tempo.
  const fallbackTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Debounce do persist de layout: onDidLayoutChange dispara a cada drag/resize.
  const layoutTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Alinha o seletor do painel de arquivos ao repo do pane ATIVO do dockview.
  // Preserva a escolha manual enquanto o pane ativo não muda (só re-seleciona
  // quando o repo do ativo difere do selecionado).
  const syncFilesRepoToActivePane = useCallback(() => {
    const id = apiRef.current?.activePanel?.id
    if (!id) return
    const pane = useAppStore.getState().panes.find((p) => p.paneId === id)
    const repoPath = pane?.repo?.path
    if (!repoPath) return
    const fs = useFilesStore.getState()
    if (fs.selectedRoot === repoPath) return
    if (fs.roots.some((r) => r.path === repoPath)) fs.selectRoot(repoPath)
  }, [])

  const onReady = useCallback(
    (event: DockviewReadyEvent) => {
      apiRef.current = event.api
      // Default contextual: ao trocar o pane ativo, o seletor de arquivos segue
      // o repo daquele terminal (quando está entre os roots).
      event.api.onDidActivePanelChange(() => {
        syncFilesRepoToActivePane()
        setActivePanelId(event.api.activePanel?.id ?? null)
      })
      event.api.onDidRemovePanel((panel) => {
        // Loop guard: se a remoção partiu do store (api.removePanel nosso), ignora.
        if (removingFromStore.current.delete(panel.id)) return
        // Veio do usuário (botão X do dockview / move). closePane é idempotente.
        if (useAppStore.getState().panes.some((p) => p.paneId === panel.id)) {
          closePane(panel.id)
        }
      })
      event.api.onDidLayoutChange(() => {
        // Não persiste enquanto aplicamos o layout do restore (evita salvar estados
        // intermediários da reconstrução) nem antes do restore ter terminado.
        if (applyingLayout.current || !restoreDone.current) return
        if (layoutTimer.current) clearTimeout(layoutTimer.current)
        layoutTimer.current = setTimeout(() => {
          const api = apiRef.current
          if (!api) return
          const layout = api.panels.length > 0 ? JSON.stringify(api.toJSON()) : null
          void workspaceApi.saveLayout(layout)
        }, 500)
      })
      setReady(true)
    },
    [closePane, syncFilesRepoToActivePane],
  )

  // Restore do layout exato. Quando há pendingLayout, aplicamos api.fromJSON UMA
  // vez — em vez de deixar o effect de reconciliação criar os painéis no arranjo
  // padrão. Esperamos as panes do restore (criadas com os paneIds salvos) já
  // existirem no store antes de aplicar, pra que os ids do layout batam.
  useEffect(() => {
    if (!ready) return
    const api = apiRef.current
    if (!api) return

    // Sem layout pendente: nada a restaurar, libera o persist normal.
    if (!pendingLayout) {
      restoreDone.current = true
      return
    }

    let layout: ReturnType<DockviewApi['toJSON']>
    let wantedIds: string[]
    try {
      layout = JSON.parse(pendingLayout)
      wantedIds = Object.keys(layout?.panels ?? {})
    } catch {
      // Layout corrompido: descarta e cai no fluxo padrão (addPanel).
      clearPendingLayout()
      restoreDone.current = true
      return
    }

    const storeIds = new Set(panes.map((p) => p.paneId))
    const restored = wantedIds.filter((id) => storeIds.has(id))
    // Ainda faltam panes do layout voltando do resume: espera o próximo render.
    // Timeout de fallback aplica o parcial (remove órfãos) caso algum resume falhe.
    const allBack = wantedIds.every((id) => storeIds.has(id))
    if (!allBack && restored.length === 0) return

    const apply = () => {
      if (!pendingLayout) return
      applyingLayout.current = true
      try {
        // Remove do JSON os painéis cujas panes não voltaram (resume falhou),
        // pra fromJSON não tentar materializar painéis órfãos.
        const orphans = wantedIds.filter((id) => !storeIds.has(id))
        if (orphans.length > 0) {
          for (const id of orphans) delete layout.panels[id]
        }
        api.fromJSON(layout)
        // Sincroniza params de cada painel com a pane do store (id = paneId).
        for (const panel of api.panels) {
          const pane = useAppStore.getState().panes.find((p) => p.paneId === panel.id)
          if (pane) panel.api.updateParameters({ pane })
        }
      } catch {
        // fromJSON falhou: limpa tudo e deixa o effect de reconciliação refazer
        // os painéis no arranjo padrão (addPanel).
        for (const panel of api.panels) {
          removingFromStore.current.add(panel.id)
          api.removePanel(panel)
        }
      } finally {
        applyingLayout.current = false
        clearPendingLayout()
        restoreDone.current = true
        if (fallbackTimer.current) {
          clearTimeout(fallbackTimer.current)
          fallbackTimer.current = null
        }
      }
    }

    if (allBack) {
      apply()
    } else if (!fallbackTimer.current) {
      // Algumas panes ainda não voltaram; dá um tempo extra antes de aplicar o
      // parcial. Se chegarem antes, o ramo allBack acima dispara e limpa o timer.
      fallbackTimer.current = setTimeout(apply, 1500)
    }
  }, [ready, panes, pendingLayout, clearPendingLayout])

  // Reconciliação store → dockview. O store é a fonte da verdade: criamos painéis
  // pra panes novas e removemos painéis órfãos, SEM tocar nos painéis existentes
  // (preserva o xterm vivo). defaultRenderer="always" mantém o DOM montado em
  // move/split, então arrastar uma pane não remonta o Terminal.
  useEffect(() => {
    const api = apiRef.current
    if (!api) return
    // Durante o restore (pendingLayout setado) ou enquanto api.fromJSON roda, o
    // effect de restore é o dono dos painéis. Não reconciliamos aqui pra não criar
    // painéis no arranjo padrão (antes do fromJSON) nem remover panes que ainda
    // estão voltando do resume. Após o fromJSON, pendingLayout é limpo e este
    // effect roda de novo — aí os painéis já existem com os ids certos e ele só
    // atualiza params (não duplica).
    // gridRequest pendente: o effect de grade é o dono dos painéis (recria em
    // grade). Não reconciliamos aqui pra não criar no arranjo padrão antes.
    if (pendingLayout || gridRequest || applyingLayout.current) return

    const storeIds = new Set(panes.map((p) => p.paneId))

    for (const panel of api.panels) {
      if (!storeIds.has(panel.id)) {
        removingFromStore.current.add(panel.id)
        api.removePanel(panel)
      }
    }

    for (const pane of panes) {
      const existing = api.getPanel(pane.paneId)
      if (existing) {
        // Atualiza os params caso o objeto pane tenha sido recriado (ex: rename).
        existing.api.updateParameters({ pane })
        continue
      }
      const active = api.activePanel
      const intent = nextPosition.current
      // Sem ativo: primeiro painel, sem posição relativa. Com ativo: 'tab' entra no
      // mesmo grupo (within); 'right'/'below' fazem split; default (clique) = right.
      const position = active
        ? intent === 'tab'
          ? { referenceGroup: active.group.id }
          : { referencePanel: active.id, direction: intent ?? 'right' }
        : undefined
      api.addPanel<PaneParams>({
        id: pane.paneId,
        component: 'terminal',
        tabComponent: 'terminal',
        title: paneTabTitle(pane),
        params: { pane },
        position,
      })
      nextPosition.current = undefined
    }
  }, [panes, ready, pendingLayout, gridRequest])

  // Foca um painel existente quando a lista de sessões pede (clique simples). Roda
  // após a reconciliação garantir que o painel existe.
  useEffect(() => {
    if (!focusPaneId) return
    const api = apiRef.current
    if (!api) return
    const panel = api.getPanel(focusPaneId)
    if (panel) {
      panel.api.setActive()
      panel.focus()
      clearFocusPane()
    }
  }, [focusPaneId, panes, ready, clearFocusPane])

  // Monta a grade imperativa pedida pela multi-seleção ("abrir N em grade"). Espera
  // todas as panes selecionadas existirem no store; respeita applyingLayout (não
  // briga com o fromJSON do restore). Remove os painéis fora da seleção e recria os
  // selecionados em linhas×colunas balanceadas (cols = ceil(sqrt(N))).
  useEffect(() => {
    if (!gridRequest || gridRequest.length === 0) return
    if (applyingLayout.current) return
    const api = apiRef.current
    if (!api) return
    const storeIds = new Set(panes.map((p) => p.paneId))
    if (!gridRequest.every((id) => storeIds.has(id))) return

    const ids = gridRequest
    const cols = Math.ceil(Math.sqrt(ids.length))
    applyingLayout.current = true
    try {
      // Limpa todos os painéis atuais; recria só os selecionados em grade.
      for (const panel of api.panels) {
        removingFromStore.current.add(panel.id)
        api.removePanel(panel)
      }
      // Mapa linha→primeiro paneId da linha (referência para o split vertical).
      const rowAnchors: string[] = []
      ids.forEach((id, i) => {
        const col = i % cols
        const row = Math.floor(i / cols)
        const pane = panes.find((p) => p.paneId === id)
        if (!pane) return
        let position: Parameters<DockviewApi['addPanel']>[0]['position']
        if (i === 0) {
          position = undefined
        } else if (col === 0) {
          // Início de uma nova linha: split abaixo da âncora da linha anterior.
          position = { referencePanel: rowAnchors[row - 1], direction: 'below' }
        } else {
          // Próxima coluna na mesma linha: split à direita da anterior.
          position = { referencePanel: ids[i - 1], direction: 'right' }
        }
        if (col === 0) rowAnchors[row] = id
        api.addPanel<PaneParams>({
          id,
          component: 'terminal',
          tabComponent: 'terminal',
          title: paneTabTitle(pane),
          params: { pane },
          position,
        })
      })
    } finally {
      applyingLayout.current = false
      clearGridRequest()
      restoreDone.current = true
    }
  }, [gridRequest, panes, ready, clearGridRequest])

  // Command palette: Ctrl+K (Cmd+K no mac). preventDefault antes do xterm processar
  // — o attachCustomKeyEventHandler do Terminal só intercepta copy/paste e devolve
  // o resto, então este listener global (capture) ganha a tecla antes do claude.
  // O 'k' nunca é um combo crítico do claude, então o app pode ter prioridade aqui.
  // Carrega os overrides de keybinding persistidos uma vez no boot.
  useEffect(() => {
    void loadKeybindings()
    void useTerminalPrefsStore.getState().load()
    // Carga única das prefs de sessão. O modo padrão do painel precisa estar no
    // cache síncrono do appStore antes do primeiro spawn/restore de pane.
    void useSessionPrefsStore
      .getState()
      .load()
      .then(() => setDefaultPaneModeFallback(useSessionPrefsStore.getState().defaultPaneMode))
  }, [loadKeybindings])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (matchCombo(e, resolveCombo('palette.toggle', overrides))) {
        e.preventDefault()
        setPaletteOpen((v) => !v)
        return
      }
      // Ctrl+Shift+A: abre o seletor de sessões (overlay). Não troca de área —
      // o split/xterm continuam montados por trás.
      if (matchCombo(e, resolveCombo('switcher.open', overrides))) {
        e.preventDefault()
        setSwitcherOpen(true)
        return
      }
      // Ctrl+N: fluxo global de nova sessão (escolher repo → diálogo de spawn).
      // Funciona sem pane ativo; capture ganha a tecla antes do xterm/Electron
      // (menu de aplicação é null, então não há accelerator competindo).
      if (matchCombo(e, resolveCombo('session.new', overrides))) {
        e.preventDefault()
        setNewSessionOpen(true)
        return
      }
      // Ctrl+J: leva o foco pro Crew Dock (expandindo se estiver colapsado). É a
      // porta de entrada do quick look — com o foco DENTRO do dock, ↑/↓ navegam
      // os cards e Espaço abre o peek. Sem equipe não há o que focar: a tecla
      // segue pro xterm em vez de abrir um painel vazio.
      if (matchCombo(e, resolveCombo('crew.focus', overrides))) {
        if (crewDockWidth === 0) return
        e.preventDefault()
        useCrewDockStore.getState().requestFocus()
        return
      }
      // Ctrl+B: alterna o painel lateral de arquivos.
      if (matchCombo(e, resolveCombo('files.togglePanel', overrides))) {
        e.preventDefault()
        toggleFiles()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [overrides, toggleFiles, crewDockWidth])

  // Abre Configurações sob demanda (ex: error state do Terminal, renderizado pelo
  // dockview fora desta árvore — ver requestOpenSettings).
  useEffect(() => {
    const onOpen = () => setSettingsOpen(true)
    window.addEventListener('cm:open-settings', onOpen)
    return () => window.removeEventListener('cm:open-settings', onOpen)
  }, [])

  // Sessão visível/focada no renderer. Fora da área de projetos nenhuma sessão
  // está visível (null). Serve a dois consumidores: o main (supressão da
  // notificação "aguardando" — ver notifySessionWaiting) e os comandos de sessão
  // da palette.
  const activePane = area === 'projects' ? panes.find((p) => p.paneId === activePanelId) : undefined
  const activeCcSessionId = activePane?.session.ccSessionId ?? null

  useEffect(() => {
    sessionsApi.setRendererFocus(activeCcSessionId)
  }, [activeCcSessionId])

  // Dono único da assinatura de sessões vivas (strip + overlay só leem). Snapshot
  // + stream global no mount; cleanup no unmount (StrictMode-safe no store).
  useEffect(() => {
    void startLiveWatch()
    return () => stopLiveWatch()
  }, [startLiveWatch, stopLiveWatch])

  // Popula as raízes do painel de arquivos a partir do projeto ativo: um repo por
  // vez (o usuário escolhe no seletor). O vaultPath entra só como fallback quando o
  // projeto não tem repos registrados. Re-busca quando o projeto ativo muda.
  useEffect(() => {
    if (!activeProjectId) {
      setFileRoots([])
      return
    }
    let cancelled = false
    void (async () => {
      try {
        const [repos, projects] = await Promise.all([
          projectsApi.listRepos(activeProjectId),
          projectsApi.list(),
        ])
        if (cancelled) return
        const roots = repos.map((r) => ({
          name: r.label || r.path.split('/').pop() || r.path,
          path: r.path,
        }))
        // Sem repos: cai pro vaultPath (a pasta do projeto) pra não ficar vazio.
        if (roots.length === 0) {
          const project = projects.find((p) => p.id === activeProjectId)
          if (project?.vaultPath) {
            roots.push({
              name: project.name || project.vaultPath.split('/').pop() || project.vaultPath,
              path: project.vaultPath,
            })
          }
        }
        setFileRoots(roots)
      } catch (err) {
        console.error('[AppShell] falha ao popular roots de arquivos', err)
        if (!cancelled) setFileRoots([])
      }
    })()
    return () => {
      cancelled = true
    }
  }, [activeProjectId, setFileRoots])

  // Quando os roots repopulam (troca de projeto), realinha o seletor ao pane ativo
  // (o onDidActivePanelChange só dispara em troca de pane, não em troca de roots).
  useEffect(() => {
    syncFilesRepoToActivePane()
  }, [fileRoots, syncFilesRepoToActivePane])

  // Atalhos de pane. Priorizamos os atalhos do app sobre o xterm: o terminal só
  // intercepta copy/paste (ver Terminal.attachCustomKeyEventHandler), então estes
  // combos nunca colidem com o que o claude precisa receber. preventDefault evita
  // o default do Electron (ex: Ctrl+W fecharia a janela).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const api = apiRef.current

      // Ctrl+Tab (pane.next) / Ctrl+Shift+Tab (pane.prev): cicla o foco entre os
      // panes abertos (dockview), com wrap-around. Se o Electron capturar o Tab
      // antes, o fallback Ctrl+1..9 abaixo cobre a ciclagem direta.
      const isNext = matchCombo(e, resolveCombo('pane.next', overrides))
      const isPrev = matchCombo(e, resolveCombo('pane.prev', overrides))
      if (isNext || isPrev) {
        const panels = api?.panels ?? []
        if (panels.length > 0) {
          e.preventDefault()
          const activeId = api?.activePanel?.id
          const idx = panels.findIndex((p) => p.id === activeId)
          const base = idx < 0 ? 0 : idx
          const next = isPrev
            ? (base - 1 + panels.length) % panels.length
            : (base + 1) % panels.length
          const target = panels[next]
          target.api.setActive()
          target.focus()
        }
        return
      }

      // A área de design tem os próprios atalhos de zoom/dígitos
      // (useCanvasShortcuts); os combos de pane e de fonte do terminal abaixo
      // não podem roubá-los.
      const inDesign = useAppStore.getState().area === 'design'

      // Ctrl+1..9 (pane.focusN): foca o n-ésimo pane diretamente (fallback caso
      // Ctrl+Tab seja interceptado pelo SO/Electron). Combo fixo (não editável).
      if (!inDesign && (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key >= '1' && e.key <= '9') {
        const panels = api?.panels ?? []
        const target = panels[Number(e.key) - 1]
        if (target) {
          e.preventDefault()
          target.api.setActive()
          target.focus()
        }
        return
      }

      // Ctrl+W (pane.close): fecha o painel ativo.
      if (matchCombo(e, resolveCombo('pane.close', overrides))) {
        const id = api?.activePanel?.id
        if (id) {
          e.preventDefault()
          closePane(id)
        }
        return
      }

      // Ctrl+\ (pane.splitRight) / Ctrl+Shift+\ (pane.splitBelow): nova sessão no
      // repo do painel ativo. Os defaults usam e.code === 'Backslash' porque
      // e.key vira '|' com Shift, fazendo Ctrl+Shift+\ nunca casar com '\\'.
      const isSplitRight = matchCombo(e, resolveCombo('pane.splitRight', overrides))
      const isSplitBelow = matchCombo(e, resolveCombo('pane.splitBelow', overrides))
      if (isSplitRight || isSplitBelow) {
        const active = api?.activePanel
        const pane = active
          ? useAppStore.getState().panes.find((p) => p.paneId === active.id)
          : undefined
        if (pane) {
          e.preventDefault()
          nextPosition.current = isSplitBelow ? 'below' : 'right'
          void openSession(pane.repo, pane.projectName, pane.projectIcon, pane.projectColor)
        }
        return
      }

      // Ctrl+T (pane.newTab): nova sessão como aba no mesmo grupo do painel ativo.
      if (matchCombo(e, resolveCombo('pane.newTab', overrides))) {
        const active = api?.activePanel
        const pane = active
          ? useAppStore.getState().panes.find((p) => p.paneId === active.id)
          : undefined
        if (pane) {
          e.preventDefault()
          nextPosition.current = 'tab'
          void openSession(pane.repo, pane.projectName, pane.projectIcon, pane.projectColor)
        }
      }

      // Zoom da fonte do terminal (fontSize compartilhado por todos os panes). O
      // preventDefault evita o zoom nativo do Electron. Combos configuráveis na aba Atalhos.
      if (inDesign) return
      if (matchCombo(e, resolveCombo('terminal.zoomIn', overrides))) {
        e.preventDefault()
        void useTerminalPrefsStore.getState().zoomIn()
        return
      }
      if (matchCombo(e, resolveCombo('terminal.zoomOut', overrides))) {
        e.preventDefault()
        void useTerminalPrefsStore.getState().zoomOut()
        return
      }
      if (matchCombo(e, resolveCombo('terminal.zoomReset', overrides))) {
        e.preventDefault()
        void useTerminalPrefsStore.getState().resetZoom()
        return
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [closePane, openSession, overrides])

  return (
    <div className="flex h-full w-full overflow-hidden">
      <IconRail onOpenSettings={() => setSettingsOpen(true)} />

      {area === 'features' && <FeaturesArea />}

      {area === 'overview' && <OverviewArea />}

      {area === 'meetings' && <MeetingsArea />}

      {area === 'objectives' && <ObjectivesArea />}

      {area === 'architecture' && <ArchitectureArea />}

      {area === 'handoffs' && <HandoffsPanel />}

      {area === 'diagrams' && <DiagramsArea />}
      {area === 'design' && <DesignArea />}
      {area === 'videos' && <VideosArea />}

      {area === 'tasks' && <TasksArea />}

      {area === 'cc-configs' && <CcConfigsArea />}

      {area === 'metrics' && <MetricsArea />}

      {/* O bloco de projetos fica sempre montado (dockview/xterm vivo), apenas
          escondido quando outra área está ativa. Colapsado: a sidebar some e um
          botão estreito encostado no IconRail a reabre. */}
      {area === 'projects' &&
        (sidebarCollapsed ? (
          <div className="flex w-9 shrink-0 flex-col items-center border-r border-[var(--color-border)] bg-[var(--color-surface)] py-3">
            <button
              type="button"
              onClick={toggleSidebar}
              title="Expandir barra lateral"
              className="rounded-md p-1.5 text-[var(--color-text-dim)] transition hover:bg-[var(--color-surface-2)]/60 hover:text-[var(--color-text)]"
            >
              <Icon as={PanelLeftOpen} size={18} />
            </button>
          </div>
        ) : (
          <ProjectsSidebar />
        ))}

      <main
        className={`flex flex-1 flex-col overflow-hidden ${area === 'projects' ? '' : 'hidden'}`}
      >
        {restoreBlocked && (
          <div
            className="flex items-center justify-between gap-3 border-b px-4 py-2 text-sm"
            style={{
              borderColor: 'var(--color-border)',
              background: 'var(--color-bg-elevated, var(--color-bg))',
              color: 'var(--color-text-dim)',
            }}
          >
            <span>Houve um problema ao restaurar as sessões anteriores.</span>
            <button
              onClick={() => void retryRestore()}
              className="rounded px-2 py-1 text-xs"
              style={{ background: 'var(--color-border)', color: 'var(--color-text)' }}
            >
              Restaurar sessões
            </button>
          </div>
        )}
        <div className="flex shrink-0 items-center border-b border-[var(--color-border)]">
          <button
            type="button"
            onClick={toggleFiles}
            title="Alternar painel de arquivos (Ctrl+B)"
            className={`m-1 rounded-md p-1.5 transition hover:bg-[var(--color-surface-2)] ${
              filesOpen ? 'text-[var(--color-text)]' : 'text-[var(--color-text-dim)]'
            }`}
          >
            <Icon as={FolderTree} size={16} />
          </button>
          <div className="min-w-0 flex-1">
            <SessionStrip onOpenSwitcher={() => setSwitcherOpen(true)} />
          </div>
        </div>
        <div className="flex min-h-0 flex-1">
          {filesOpen && <FilesPanel />}
          <div className="relative min-h-0 flex-1">
            {panes.length === 0 && <EmptyMain />}
            <DockviewReact
              className="absolute inset-0"
              theme={themeAbyss}
              components={components}
              tabComponents={tabComponents}
              defaultRenderer="always"
              onReady={onReady}
            />
          </div>
        </div>
      </main>

      {/* Irmão de <main>, não filho: o bloco de projetos fica `hidden` fora da
          área projects, e o dock precisa continuar visível em qualquer área (as
          filhas seguem trabalhando enquanto você olha métricas/features). */}
      <CrewDock />

      {/* Quick look da filha em foco: overlay por cima de tudo, no padrão do
          SessionSwitcher (o dockview segue montado por trás, nenhuma pane nasce). */}
      <CrewPeek />

      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <HandoffApprovalDialog />
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onOpenSettings={() => setSettingsOpen(true)}
        activeCcSessionId={activeCcSessionId}
      />
      <SessionSwitcher open={switcherOpen} onClose={() => setSwitcherOpen(false)} />
      <NewSessionFlow open={newSessionOpen} onClose={() => setNewSessionOpen(false)} />
      <div
        className="pointer-events-none fixed bottom-4 z-50 flex flex-col items-end gap-2"
        style={{ right: crewDockWidth + 16 }}
      >
        <UpdateToast />
        <NotificationToast />
      </div>
    </div>
  )
}

function EmptyMain() {
  return (
    <div className="pointer-events-none absolute inset-0 z-10 flex h-full items-center justify-center">
      <div className="max-w-sm text-center text-[var(--color-text-dim)]">
        <div className="mb-4 text-4xl opacity-60">⌨</div>
        <div className="mb-2 text-lg font-medium text-[var(--color-text)]">
          Nenhuma sessão aberta
        </div>
        <div className="text-sm">Clique num repo na barra lateral pra abrir uma sessão.</div>
        <div className="mt-3 text-xs">
          ou pressione{' '}
          <kbd className="rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--color-text)]">
            Ctrl
          </kbd>{' '}
          <kbd className="rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--color-text)]">
            K
          </kbd>{' '}
          pra buscar
        </div>
      </div>
    </div>
  )
}
