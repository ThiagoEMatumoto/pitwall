import { useEffect, useMemo, useRef, useState } from 'react'
import { TerminalSquare } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import { handoffsApi, projectsApi } from '@/lib/ipc'
import { dispatchHandoffChild, handoffModeForPermission } from '@/features/handoffs/spawn-child'
import { showToast } from '@/features/notifications/toast-store'
import { useAppStore } from '@/store/appStore'
import { SpawnSessionDialog } from './SpawnSessionDialog'
import type { Project, Repo } from '../../../shared/types/ipc'

interface Props {
  open: boolean
  onClose: () => void
}

interface RepoEntry {
  repo: Repo
  project: Project
}

// Substring match case/acento-insensível (mesmo helper do CommandPalette).
function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
}

// Fluxo global de nova sessão (Ctrl+N): funciona sem pane ativo. Passo 1 escolhe
// o repo (busca + teclado); passo 2 é o SpawnSessionDialog com os controles.
export function NewSessionFlow({ open, onClose }: Props) {
  const openSession = useAppStore((s) => s.openSession)
  const [entries, setEntries] = useState<RepoEntry[]>([])
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [chosen, setChosen] = useState<RepoEntry | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    setQuery('')
    setActive(0)
    setChosen(null)
    inputRef.current?.focus()

    let cancelled = false
    void (async () => {
      const projects = await projectsApi.list()
      if (cancelled) return
      const perProject = await Promise.all(
        projects.map(async (p) => {
          const repos = await projectsApi.listRepos(p.id)
          return repos.map<RepoEntry>((repo) => ({ repo, project: p }))
        }),
      )
      if (cancelled) return
      setEntries(perProject.flat())
    })()
    return () => {
      cancelled = true
    }
  }, [open])

  const filtered = useMemo(() => {
    if (!query) return entries
    const q = normalize(query)
    return entries.filter(
      (e) => normalize(e.repo.label).includes(q) || normalize(e.project.name).includes(q),
    )
  }, [entries, query])

  useEffect(() => {
    setActive(0)
  }, [query])

  // Mantém o item ativo visível ao navegar por teclado.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [active])

  if (!open) return null

  // Passo 2: repo escolhido — o SpawnSessionDialog assume (Enter confirma rápido).
  if (chosen) {
    return (
      <SpawnSessionDialog
        open
        onClose={onClose}
        repo={chosen.repo}
        onConfirmChild={({ task, motherSessionId, featureId, permission }) => {
          const repoId = chosen.repo.id
          // O main compõe o briefing (o MESMO que a filha despachada por MCP
          // recebe) e resolve o apelido; o spawn sai daqui, pelo dispatch
          // compartilhado com o gate de aprovação — inclusive o carimbo de failed
          // se ele quebrar. A filha não vira aba: nasce no painel lateral.
          void (async () => {
            try {
              const { handoff, alias } = await handoffsApi.createManual({
                repoId,
                motherSessionId,
                task,
                featureId,
                mode: handoffModeForPermission(permission),
              })
              await dispatchHandoffChild(handoff.id, () => ({
                repoId,
                alias,
                systemPromptText: handoff.composedPrompt,
                featureId,
                permissionMode: permission,
              }))
            } catch (err) {
              showToast({
                title: 'Não foi possível abrir a sessão filha',
                body: err instanceof Error ? err.message : String(err),
              })
            }
          })()
          onClose()
        }}
        onConfirm={(name, featureId, model, effort, permission, advisorModel, initialCommand) => {
          void openSession(
            chosen.repo,
            chosen.project.name,
            chosen.project.icon,
            chosen.project.color,
            undefined,
            featureId,
            name,
            initialCommand,
            model,
            effort,
            undefined,
            permission,
            advisorModel,
          )
          onClose()
        }}
      />
    )
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
      const entry = filtered[active] ?? filtered[0]
      if (entry) setChosen(entry)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    }
  }

  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center bg-black/60 pt-[12vh]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="flex max-h-[60vh] w-[32rem] max-w-[90vw] flex-col overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] shadow-2xl">
        <div className="border-b border-[var(--color-border)] px-3">
          <input
            ref={inputRef}
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Nova sessão — escolher repo…"
            className="w-full bg-transparent py-3 text-sm text-[var(--color-text)] outline-none placeholder:text-[var(--color-text-dim)]"
          />
        </div>

        <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto py-1">
          {filtered.length === 0 && (
            <div className="px-4 py-6 text-center text-xs text-[var(--color-text-dim)]">
              {entries.length === 0 ? 'Nenhum repo registrado.' : 'Nenhum resultado.'}
            </div>
          )}
          {filtered.map((entry, idx) => (
            <button
              key={entry.repo.id}
              type="button"
              data-idx={idx}
              onClick={() => setChosen(entry)}
              onMouseMove={() => setActive(idx)}
              className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition ${
                idx === active
                  ? 'bg-[var(--color-surface-2)] text-[var(--color-text)]'
                  : 'text-[var(--color-text-dim)] hover:bg-[var(--color-surface-2)]/60'
              }`}
            >
              <Icon as={TerminalSquare} size={14} className="shrink-0" />
              <span className="min-w-0 flex-1 truncate">{entry.repo.label}</span>
              <span className="shrink-0 text-[10px] text-[var(--color-text-dim)]">
                {entry.project.name}
              </span>
            </button>
          ))}
        </div>

        <div className="flex items-center gap-3 border-t border-[var(--color-border)] px-3 py-2 text-[10px] text-[var(--color-text-dim)]">
          <span>↑↓ navegar</span>
          <span>↵ escolher</span>
          <span>esc fechar</span>
        </div>
      </div>
    </div>
  )
}
