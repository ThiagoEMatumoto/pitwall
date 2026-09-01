import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  Blocks,
  Folder,
  MessageSquareText,
  Mic,
  Rocket,
  ScrollText,
  Settings,
  SlashSquare,
  Sparkles,
  Target,
  TerminalSquare,
  X,
} from 'lucide-react'
import { useAppStore } from '@/store/appStore'
import { Icon } from '@/components/ui/Icon'
import { GradientBorder } from '@/features/brand'
import { renderProjectIcon } from '@/components/ui/projectIcon'
import { SessionFeatureChip } from '@/features/sessions/SessionFeatureChip'
import { projectsApi, voiceApi } from '@/lib/ipc'
import { matchesQuery } from '@/lib/text-match'
import { sessionSearchText, sortByUrgency } from '../session-switcher/session-search'
import { statusView } from '../session-switcher/status-view'
import { useEndedSessions, useVisibleLiveSessions } from '../session-switcher/useGlobalSessions'
import { launcherCommandText, loadLauncherItems } from './launcher'
import {
  capByGroup,
  GARAGE_GROUP,
  liveSessionGroup,
  SESSION_GROUP_CAPS,
  WAITING_GROUP,
  WORKING_GROUP,
} from './session-results'
import type { LauncherItem, LiveSessionInfo, Project, Repo } from '../../../shared/types/ipc'

interface Props {
  open: boolean
  onClose: () => void
  onOpenSettings: () => void
  /** Sessão CC da pane focada. null/undefined esconde o grupo "Sessão ativa". */
  activeCcSessionId?: string | null
}

// Grupo dos comandos que agem sobre a pane focada — o caminho de acesso aos
// controles do rodapé que não depende da largura do pane (nem do menu "⋯").
const ACTIVE_SESSION_GROUP = 'Sessão ativa'

interface Command {
  id: string
  label: string
  icon: ReactNode
  hint?: ReactNode
  group: string
  run: () => void
  // Quando true, executar NÃO fecha a palette (ex.: avançar de passo no launcher).
  keepOpen?: boolean
  // Texto alternativo de busca (sessões casam por título/name/projeto/repo).
  searchText?: string
}

// Ícone/cor do projeto na linha da sessão, coeso com o slot de ícone do palette.
function sessionIcon(s: LiveSessionInfo): ReactNode {
  return (
    <span className="flex shrink-0 items-center gap-1">
      <span
        className="h-2 w-2 shrink-0 rounded-full"
        style={{ background: s.projectColor ?? 'var(--color-border)' }}
      />
      {renderProjectIcon(s.projectIcon)}
    </span>
  )
}

// Status colorido + projeto no slot de hint (direita da linha).
function sessionHint(s: LiveSessionInfo): ReactNode {
  const view = statusView(s.status)
  return (
    <span className="flex items-center gap-2">
      <SessionFeatureChip sessionId={s.id} density="chip" />
      {s.projectName && <span className="max-w-28 truncate">{s.projectName}</span>}
      <span className={`flex items-center gap-1 ${view.className}`}>
        <Icon as={view.icon} size={11} className={view.spin ? 'animate-spin' : undefined} />
        {view.label}
      </span>
    </span>
  )
}

function sessionLabel(s: LiveSessionInfo): string {
  return s.title ?? s.name ?? s.repo?.label ?? 'Avulsa'
}

export function CommandPalette({ open, onClose, onOpenSettings, activeCcSessionId }: Props) {
  const setArea = useAppStore((s) => s.setArea)
  const setActiveProject = useAppStore((s) => s.setActiveProject)
  const openSession = useAppStore((s) => s.openSession)
  const closePane = useAppStore((s) => s.closePane)
  const focusOrOpenSession = useAppStore((s) => s.focusOrOpenSession)
  const resumeSession = useAppStore((s) => s.resumeSession)

  // Mesma fonte de dados do SessionSwitcher (hooks compartilhados).
  const liveSessions = useVisibleLiveSessions()
  const endedSessions = useEndedSessions(open)

  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [projects, setProjects] = useState<Project[]>([])
  // Repos de todos os projetos, carregados lazy quando a palette abre.
  const [reposByProject, setReposByProject] = useState<Record<string, Repo[]>>({})
  // Modo launcher: 'root' = palette normal; 'pick-item' = escolher skill/command;
  // 'pick-repo' = escolher o repo onde lançar o item já escolhido.
  const [mode, setMode] = useState<'root' | 'pick-item' | 'pick-repo'>('root')
  const [launcherItems, setLauncherItems] = useState<LauncherItem[]>([])
  const [chosenItem, setChosenItem] = useState<LauncherItem | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    setQuery('')
    setActive(0)
    setMode('root')
    setChosenItem(null)
    inputRef.current?.focus()

    let cancelled = false
    void (async () => {
      const ps = await projectsApi.list()
      if (cancelled) return
      setProjects(ps)
      const entries = await Promise.all(
        ps.map(async (p) => [p.id, await projectsApi.listRepos(p.id)] as const),
      )
      if (cancelled) return
      setReposByProject(Object.fromEntries(entries))
      const items = await loadLauncherItems()
      if (cancelled) return
      setLauncherItems(items)
    })()
    return () => {
      cancelled = true
    }
  }, [open])

  // Trocar de modo limpa a busca e reposiciona o cursor.
  function enterMode(next: 'root' | 'pick-item' | 'pick-repo') {
    setMode(next)
    setQuery('')
    setActive(0)
    inputRef.current?.focus()
  }

  const commands = useMemo<Command[]>(() => {
    // Passo 1 do launcher: escolher a skill/command a injetar.
    if (mode === 'pick-item') {
      return launcherItems.map<Command>((it) => ({
        id: `launch-item-${it.kind}-${it.origin}-${it.name}`,
        label: it.kind === 'command' ? `/${it.name}` : it.name,
        icon: <Icon as={it.kind === 'command' ? SlashSquare : Sparkles} />,
        hint: it.origin === 'user' ? 'user' : it.origin,
        group: it.kind === 'command' ? 'Comandos' : 'Skills',
        run: () => {
          setChosenItem(it)
          enterMode('pick-repo')
        },
      }))
    }

    // Passo 2 do launcher: escolher o repo onde lançar o item já escolhido.
    if (mode === 'pick-repo') {
      const list: Command[] = []
      const text = chosenItem ? launcherCommandText(chosenItem) : ''
      for (const p of projects) {
        for (const r of reposByProject[p.id] ?? []) {
          list.push({
            id: `launch-repo-${r.id}`,
            label: `Lançar ${text} em: ${r.label}`,
            icon: <Icon as={Rocket} />,
            hint: p.name,
            group: 'Lançar em',
            run: () => {
              if (chosenItem) {
                void openSession(r, p.name, p.icon, p.color, undefined, undefined, undefined, text)
              }
            },
          })
        }
      }
      return list
    }

    const list: Command[] = [
      {
        id: 'launcher',
        label: 'Lançar com comando…',
        icon: <Icon as={Rocket} />,
        hint: 'skill ou /command',
        group: 'Ações',
        // Não fecha a palette: avança pro passo de escolha de item.
        run: () => enterMode('pick-item'),
        keepOpen: true,
      },
      {
        id: 'area-projects',
        label: 'Ir para Projetos',
        icon: <Icon as={Folder} />,
        group: 'Navegação',
        run: () => setArea('projects'),
      },
      {
        id: 'area-features',
        label: 'Ir para Features',
        icon: <Icon as={Target} />,
        group: 'Navegação',
        run: () => setArea('features'),
      },
      {
        id: 'area-cc',
        label: 'Ir para Configs do CC',
        icon: <Icon as={Blocks} />,
        group: 'Navegação',
        run: () => setArea('cc-configs'),
      },
      {
        id: 'open-settings',
        label: 'Abrir Configurações',
        icon: <Icon as={Settings} />,
        group: 'Ações',
        run: () => onOpenSettings(),
      },
    ]

    // Controles da sessão focada. Resumir/Resumo auto são IPC por ccSessionId, então
    // vão direto no voiceApi. O ditado NÃO: o MediaRecorder vive no renderer da pane,
    // então a palette só avisa — o Terminal daquela sessão liga o mic.
    if (activeCcSessionId) {
      const cc = activeCcSessionId
      list.push(
        {
          id: 'session-summarize-now',
          label: 'Resumir o último turno',
          icon: <Icon as={ScrollText} />,
          group: ACTIVE_SESSION_GROUP,
          run: () => void voiceApi.summarizeNow(cc),
        },
        {
          id: 'session-toggle-auto-summary',
          label: 'Alternar resumo automático',
          icon: <Icon as={MessageSquareText} />,
          group: ACTIVE_SESSION_GROUP,
          // Sem espelho local do estado aqui: lê o valor atual no main e inverte.
          run: () =>
            void voiceApi.autoSummaryGet(cc).then((on) => voiceApi.autoSummarySet(cc, !on)),
        },
        {
          id: 'session-dictate',
          label: 'Ditar por voz',
          icon: <Icon as={Mic} />,
          group: ACTIVE_SESSION_GROUP,
          run: () =>
            window.dispatchEvent(
              new CustomEvent('cm:voice-dictate', { detail: { ccSessionId: cc } }),
            ),
        },
      )
    }

    // Sessões vivas — mesmo fluxo do SessionSwitcher: foca a pane se já exibida,
    // senão abre. Ordenadas por urgência pro corte do cap manter as acionáveis.
    for (const s of sortByUrgency(liveSessions)) {
      list.push({
        id: `live-session-${s.ccSessionId}`,
        label: sessionLabel(s),
        searchText: sessionSearchText(s),
        icon: sessionIcon(s),
        hint: sessionHint(s),
        group: liveSessionGroup(s.status),
        run: () => void focusOrOpenSession(s),
      })
    }

    // Encerradas retomáveis (todas as entradas de listEndedGlobal são
    // retomáveis por construção) — Enter dispara o fluxo de resume existente.
    for (const s of endedSessions ?? []) {
      list.push({
        id: `ended-session-${s.ccSessionId}`,
        label: sessionLabel(s),
        searchText: sessionSearchText(s),
        icon: sessionIcon(s),
        // listEndedGlobal já entrega status 'ended' — o hint mostra "encerrada".
        hint: sessionHint(s),
        group: GARAGE_GROUP,
        run: () =>
          void resumeSession(s.repo, s.projectName, s.projectIcon, s.projectColor, s.ccSessionId),
      })
    }

    for (const p of projects) {
      list.push({
        id: `goto-${p.id}`,
        label: `Ir para projeto: ${p.name}`,
        icon: renderProjectIcon(p.icon),
        group: 'Projetos',
        run: () => {
          setActiveProject(p.id)
          setArea('projects')
        },
      })
    }

    for (const p of projects) {
      for (const r of reposByProject[p.id] ?? []) {
        list.push({
          id: `session-${r.id}`,
          label: `Nova sessão em: ${r.label}`,
          icon: <Icon as={TerminalSquare} />,
          hint: p.name,
          group: 'Nova sessão',
          run: () => void openSession(r, p.name, p.icon, p.color),
        })
      }
    }

    const activePaneId = useAppStore.getState().panes[0]?.paneId
    if (activePaneId) {
      const panes = useAppStore.getState().panes
      list.push({
        id: 'close-pane',
        label: `Fechar pane: ${panes[panes.length - 1]?.repo?.label ?? ''}`.trim(),
        icon: <Icon as={X} />,
        group: 'Ações',
        run: () => closePane(panes[panes.length - 1].paneId),
      })
    }

    return list
  }, [
    mode,
    launcherItems,
    chosenItem,
    projects,
    reposByProject,
    liveSessions,
    endedSessions,
    activeCcSessionId,
    setArea,
    setActiveProject,
    openSession,
    closePane,
    focusOrOpenSession,
    resumeSession,
    onOpenSettings,
  ])

  const filtered = useMemo(
    () =>
      capByGroup(
        commands.filter((c) => matchesQuery(query, c.searchText ?? c.label)),
        SESSION_GROUP_CAPS,
      ),
    [commands, query],
  )

  useEffect(() => {
    setActive(0)
  }, [query])

  // Sessões encerradas resolvem async e mudam a lista: mantém o índice dentro dos limites.
  useEffect(() => {
    setActive((i) => Math.min(i, Math.max(0, filtered.length - 1)))
  }, [filtered.length])

  // Mantém o item ativo visível ao navegar por teclado.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [active])

  if (!open) return null

  function runAt(idx: number) {
    const cmd = filtered[idx]
    if (!cmd) return
    if (!cmd.keepOpen) onClose()
    cmd.run()
  }

  // Volta um passo no fluxo launcher; no modo root, fecha a palette.
  function stepBack() {
    if (mode === 'pick-repo') {
      setChosenItem(null)
      enterMode('pick-item')
    } else if (mode === 'pick-item') {
      enterMode('root')
    } else {
      onClose()
    }
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((i) => Math.min(i + 1, filtered.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      runAt(active)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      stepBack()
    } else if (e.key === 'Backspace' && query === '' && mode !== 'root') {
      // Backspace com busca vazia recua o passo do launcher.
      e.preventDefault()
      stepBack()
    }
  }

  // Agrupa preservando a ordem de inserção dos grupos.
  const groups: { group: string; items: { cmd: Command; idx: number }[] }[] = []
  filtered.forEach((cmd, idx) => {
    let g = groups.find((x) => x.group === cmd.group)
    if (!g) {
      g = { group: cmd.group, items: [] }
      groups.push(g)
    }
    g.items.push({ cmd, idx })
  })

  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center bg-black/60 pt-[12vh] backdrop-blur-[3px]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <GradientBorder
        radius={16}
        className="w-[620px] max-w-[90vw] pw-rise shadow-2xl"
        innerClassName="flex flex-col overflow-hidden"
      >
        <div className="border-b border-[var(--color-border)] px-3">
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={
              mode === 'pick-item'
                ? 'Buscar skill ou /command para lançar…'
                : mode === 'pick-repo'
                  ? `Escolher repo para lançar ${chosenItem ? launcherCommandText(chosenItem) : ''}…`
                  : 'Buscar ações, projetos, repos…'
            }
            className="w-full bg-transparent py-3 text-sm text-[var(--color-text)] outline-none placeholder:text-[var(--color-text-dim)]"
          />
        </div>

        <div ref={listRef} className="max-h-[50vh] overflow-y-auto py-1">
          {filtered.length === 0 && (
            <div className="px-4 py-6 text-center text-xs text-[var(--color-text-dim)]">
              Nenhum resultado.
            </div>
          )}

          {groups.map((g) => (
            <div key={g.group} className="py-1">
              <div className="flex items-center gap-2 px-3 py-1.5 font-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-[var(--color-text-dim)]">
                {(g.group === WAITING_GROUP || g.group === WORKING_GROUP) && (
                  <span className="pw-pulse h-1.5 w-1.5 rounded-full bg-[var(--color-accent)]" />
                )}
                {g.group}
              </div>
              {g.items.map(({ cmd, idx }) => (
                <button
                  key={cmd.id}
                  type="button"
                  data-idx={idx}
                  onMouseMove={() => setActive(idx)}
                  onClick={() => runAt(idx)}
                  className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition ${
                    idx === active
                      ? 'bg-[var(--color-surface-2)] text-[var(--color-text)]'
                      : 'text-[var(--color-text-dim)]'
                  }`}
                >
                  <span className="shrink-0 text-[var(--color-text-dim)]">{cmd.icon}</span>
                  <span className="truncate">{cmd.label}</span>
                  {cmd.hint && (
                    <span className="ml-auto shrink-0 text-xs text-[var(--color-text-dim)] opacity-70">
                      {cmd.hint}
                    </span>
                  )}
                </button>
              ))}
            </div>
          ))}
        </div>

        <div className="flex items-center gap-4 border-t border-[var(--color-border)] px-4 py-2.5 font-mono text-[10px] text-[var(--color-text-dim)]">
          <span>↑↓ navegar</span>
          <span>↵ abrir</span>
          <span>esc fechar</span>
        </div>
      </GradientBorder>
    </div>
  )
}
