import { useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, History, Plus, RefreshCw } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import { Button } from '@/features/brand'
import { Input } from '@/components/ui/Input'
import type { Feature, FeatureStatus, ObjectiveWithProgress, Project } from '../../../shared/types/ipc'
import { STATUS_META, STATUS_ORDER } from './status'

// 'drafts' = fila de TRIAGEM (auto-criadas + suspeitas de duplicata; o id
// continua 'drafts' porque é o mesmo assento na barra); 'app-dev' = dev
// do próprio claude-manager (Onda 3 — oculta por default de todos os outros
// filtros). Os dois conjuntos vêm prontos da FeaturesArea via byProject — aqui
// só pulamos o filtro de status pra eles.
type StatusFilter = 'all' | FeatureStatus | 'drafts' | 'app-dev'

interface Props {
  projects: Project[]
  byProject: Record<string, Feature[]>
  selectedId: string | null
  loading: boolean
  query: string
  filter: StatusFilter
  // Filtro por objetivo (Onda 2): byProject já vem filtrado pela área — aqui
  // só populamos o select e refletimos o valor escolhido.
  objectives: ObjectiveWithProgress[]
  objectiveFilter: string
  onQuery: (q: string) => void
  onFilter: (f: StatusFilter) => void
  onObjectiveFilter: (id: string) => void
  onSelect: (id: string) => void
  onReload: () => void
  onNew: () => void
  onBackfill: () => void
  backfilling: boolean
}

const FILTERS: { id: StatusFilter; label: string }[] = [
  { id: 'all', label: 'Todas' },
  ...STATUS_ORDER.map((s) => ({ id: s as StatusFilter, label: STATUS_META[s].label })),
  { id: 'drafts', label: 'Triagem' },
  { id: 'app-dev', label: 'App dev' },
]

export function FeaturesSidebar({
  projects,
  byProject,
  selectedId,
  loading,
  query,
  filter,
  objectives,
  objectiveFilter,
  onQuery,
  onFilter,
  onObjectiveFilter,
  onSelect,
  onReload,
  onNew,
  onBackfill,
  backfilling,
}: Props) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())

  const q = query.trim().toLowerCase()

  const groups = useMemo(() => {
    return projects
      .map((project) => {
        const all = byProject[project.id] ?? []
        const features = all.filter((f) => {
          if (
            filter !== 'all' &&
            filter !== 'drafts' &&
            filter !== 'app-dev' &&
            f.status !== filter
          ) {
            return false
          }
          if (q && !f.title.toLowerCase().includes(q)) return false
          return true
        })
        return { project, features }
      })
      .filter((g) => g.features.length > 0)
  }, [projects, byProject, filter, q])

  function toggle(id: string) {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  return (
    <aside className="flex h-full w-72 shrink-0 flex-col border-r border-[var(--color-border)] bg-[var(--color-surface)]">
      <div className="flex items-center justify-between border-b border-[var(--color-border)] px-4 py-3">
        <div className="text-sm font-semibold tracking-tight">Features</div>
        <div className="flex items-center gap-1">
          <Button variant="primary" size="sm" onClick={onNew} title="Nova feature">
            <Icon as={Plus} size={13} />
            Nova
          </Button>
          <button
            type="button"
            onClick={onBackfill}
            disabled={backfilling}
            title="Importar features de sessões anteriores (reprocessa as sessões já encerradas)"
            className="flex items-center justify-center rounded-md bg-[var(--color-surface-2)] p-1.5 text-[var(--color-text)] transition hover:opacity-90 disabled:opacity-50"
          >
            <Icon as={History} size={13} className={backfilling ? 'animate-spin' : undefined} />
          </button>
          <button
            type="button"
            onClick={onReload}
            disabled={loading}
            title="Atualizar"
            className="flex items-center justify-center rounded-md bg-[var(--color-surface-2)] p-1.5 text-[var(--color-text)] transition hover:opacity-90 disabled:opacity-50"
          >
            <Icon as={RefreshCw} size={13} className={loading ? 'animate-spin' : undefined} />
          </button>
        </div>
      </div>

      <div className="border-b border-[var(--color-border)] px-3 py-2.5">
        <Input
          placeholder="Buscar por título…"
          value={query}
          onChange={(e) => onQuery(e.target.value)}
        />
        <div className="mt-2 flex flex-wrap gap-1">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => onFilter(f.id)}
              className={`rounded-full px-2 py-0.5 text-[10px] transition ${
                filter === f.id
                  ? 'bg-[var(--color-surface-2)] text-[var(--color-text)]'
                  : 'text-[var(--color-text-dim)] hover:bg-[var(--color-surface-2)]/60 hover:text-[var(--color-text)]'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
        {objectives.length > 0 && (
          <select
            value={objectiveFilter}
            onChange={(e) => onObjectiveFilter(e.target.value)}
            className="mt-2 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-xs text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]"
          >
            <option value="">Objetivo — todos</option>
            <option value="none">Sem objetivo</option>
            {objectives.map((o) => (
              <option key={o.id} value={o.id}>
                {o.title}
              </option>
            ))}
          </select>
        )}
      </div>

      <div className="flex-1 overflow-y-auto py-2">
        {groups.length === 0 && (
          <div className="px-4 py-8 text-center text-xs text-[var(--color-text-dim)]">
            Nenhuma feature.
          </div>
        )}
        {groups.map(({ project, features }) => {
          const isCollapsed = collapsed.has(project.id)
          return (
            <div key={project.id} className="mb-1">
              <button
                type="button"
                onClick={() => toggle(project.id)}
                className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-xs font-medium text-[var(--color-text-dim)] transition hover:text-[var(--color-text)]"
              >
                <Icon as={isCollapsed ? ChevronRight : ChevronDown} size={13} />
                {project.icon && <span>{project.icon}</span>}
                <span className="truncate">{project.name}</span>
                <span className="ml-auto font-mono text-[10px] tabular-nums">{features.length}</span>
              </button>
              {!isCollapsed && (
                <ul className="flex flex-col gap-px">
                  {features.map((f) => {
                    const active = f.id === selectedId
                    const meta = STATUS_META[f.status]
                    return (
                      <li key={f.id}>
                        <button
                          type="button"
                          onClick={() => onSelect(f.id)}
                          className={`flex w-full items-center gap-2 px-4 py-1.5 pl-7 text-left text-sm transition ${
                            active
                              ? 'bg-[var(--color-surface-2)] text-[var(--color-text)]'
                              : 'text-[var(--color-text-dim)] hover:bg-[var(--color-surface-2)]/60 hover:text-[var(--color-text)]'
                          }`}
                        >
                          <span
                            className="h-1.5 w-1.5 shrink-0 rounded-full"
                            style={{ background: meta.color }}
                            title={meta.label}
                          />
                          <span className="truncate">{f.title}</span>
                        </button>
                      </li>
                    )
                  })}
                </ul>
              )}
            </div>
          )
        })}
      </div>
    </aside>
  )
}

export type { StatusFilter }
