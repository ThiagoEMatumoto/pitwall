import { useCallback, useEffect, useState } from 'react'
import {
  DownloadCloud,
  FolderOpen,
  GripVertical,
  MoreHorizontal,
  PanelLeftClose,
  RefreshCw,
  Zap,
} from 'lucide-react'
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { useProjects } from './useProjects'
import { NewProjectDialog } from './NewProjectDialog'
import { EditProjectDialog } from './EditProjectDialog'
import { ProjectRepos } from './ProjectRepos'
import { Menu } from '@/components/ui/Menu'
import { Icon } from '@/components/ui/Icon'
import { Button, ControlPill } from '@/features/brand'
import { renderProjectIcon } from '@/components/ui/projectIcon'
import { useAppStore } from '@/store/appStore'
import { useRepoPullStore } from '@/store/repoPullStore'
import { repoApi } from '@/lib/ipc'
import type {
  CloneMissingResult,
  MissingRepo,
  Project,
  UpdateProjectInput,
} from '../../../shared/types/ipc'

// Enquanto a janela está visível, revalida os repos faltantes neste intervalo —
// pega um repo que sumiu do disco (via sync) sem depender de reiniciar o app.
const MISSING_POLL_MS = 10_000

export function ProjectsSidebar() {
  const { projects, create, update, remove, reorder } = useProjects()
  const activeProjectId = useAppStore((s) => s.activeProjectId)
  const setActiveProject = useAppStore((s) => s.setActiveProject)
  const toggleSidebar = useAppStore((s) => s.toggleSidebar)
  const openQuickSession = useAppStore((s) => s.openQuickSession)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<Project | null>(null)
  // Expansão independente por projeto (vários abertos ao mesmo tempo). O header
  // só faz toggle; setActiveProject segue como "último usado"/hint, sem gatear
  // a visibilidade dos repos.
  const [expandedProjectIds, setExpandedProjectIds] = useState<Set<string>>(new Set())
  // Repos registrados no DB (sincronizados de outra máquina) que ainda não estão
  // no disco desta — candidatos a auto-clone.
  const [missingRepos, setMissingRepos] = useState<MissingRepo[]>([])
  const [cloningMissing, setCloningMissing] = useState(false)
  const [pullingAll, setPullingAll] = useState(false)
  const [cloneFailures, setCloneFailures] = useState<CloneMissingResult[]>([])
  const [cloneError, setCloneError] = useState<string | null>(null)

  const refreshPullStatus = useRepoPullStore((s) => s.refresh)

  const refreshMissing = useCallback(() => {
    return repoApi
      .listMissing()
      .then(setMissingRepos)
      .catch((err) => {
        console.error('[ProjectsSidebar] falha ao listar repos faltantes:', err)
      })
  }, [])

  // Faltantes e atraso (badge "N atrás") revalidam juntos: os dois só mudam
  // depois de um pull/clone, e o pull do cron acontece sem avisar o renderer.
  const revalidate = useCallback(() => {
    void refreshMissing()
    void refreshPullStatus()
  }, [refreshMissing, refreshPullStatus])

  useEffect(() => {
    revalidate()
  }, [projects.length, revalidate])

  // Revalida quando a janela volta ao foco/visível e num intervalo curto enquanto
  // visível. O intervalo é pausado quando a aba fica oculta (document.hidden) pra
  // não bater no disco em background sem ninguém olhando o banner.
  useEffect(() => {
    let intervalId: ReturnType<typeof setInterval> | undefined

    function startPolling() {
      if (intervalId) return
      intervalId = setInterval(revalidate, MISSING_POLL_MS)
    }
    function stopPolling() {
      if (intervalId) {
        clearInterval(intervalId)
        intervalId = undefined
      }
    }
    function onFocus() {
      revalidate()
    }
    function onVisibility() {
      if (document.hidden) {
        stopPolling()
      } else {
        revalidate()
        startPolling()
      }
    }

    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVisibility)
    if (!document.hidden) startPolling()

    return () => {
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVisibility)
      stopPolling()
    }
  }, [revalidate])

  async function cloneMissing() {
    setCloningMissing(true)
    setCloneError(null)
    setCloneFailures([])
    try {
      const results = await repoApi.cloneMissing()
      setCloneFailures(results.filter((r) => r.status === 'error'))
      await refreshMissing()
    } catch (err) {
      console.error('[ProjectsSidebar] falha ao clonar faltantes:', err)
      setCloneError((err as Error).message)
    } finally {
      setCloningMissing(false)
    }
  }

  // O resumo (X atualizados, Y pulados) sai via toast do main; aqui só gerimos
  // o estado de "em andamento" do botão. Ao final revalida os faltantes (um pull
  // pode ter feito um repo aparecer/sumir) e o atraso por repo.
  async function pullAll() {
    setPullingAll(true)
    try {
      await repoApi.pullAll()
    } finally {
      setPullingAll(false)
      revalidate()
    }
  }

  // Limiar de 4px pra distinguir clique de arraste — mesmo com handle dedicado,
  // evita que um clique trêmulo no grip dispare um drag.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }))

  function toggleExpanded(id: string) {
    setExpandedProjectIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function onDragEnd(event: DragEndEvent) {
    const { active, over } = event
    if (over && active.id !== over.id) {
      void reorder(String(active.id), String(over.id))
    }
  }

  return (
    <aside className="flex h-full w-[264px] shrink-0 flex-col border-r border-[var(--color-border)] bg-[color-mix(in_srgb,var(--color-surface)_55%,transparent)]">
      <div className="flex items-center justify-between border-b border-[var(--color-border)] px-4 py-3">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={toggleSidebar}
            title="Recolher barra lateral"
            className="-ml-1 rounded p-0.5 text-[var(--color-text-dim)] transition hover:text-[var(--color-text)]"
          >
            <Icon as={PanelLeftClose} size={16} />
          </button>
          <div className="text-sm font-semibold tracking-tight">Projetos</div>
        </div>
        <div className="flex items-center gap-1.5">
          <ControlPill
            icon={RefreshCw}
            label={pullingAll ? 'Sincronizando…' : 'Sync'}
            onClick={() => void pullAll()}
            disabled={pullingAll}
            className="font-mono"
            title="git pull --ff-only em todos os repos (pula sujos/divergentes)"
          />
          <Button variant="primary" size="sm" onClick={() => setDialogOpen(true)}>
            + Novo
          </Button>
        </div>
      </div>

      {missingRepos.length > 0 && (
        <div className="flex flex-col gap-2 border-b border-[var(--color-border)] bg-[var(--color-warning-bg,var(--color-surface-2))] px-3 py-2">
          <div className="text-xs text-[var(--color-text-dim)]">
            {missingRepos.length} repositório{missingRepos.length === 1 ? '' : 's'} registrado
            {missingRepos.length === 1 ? '' : 's'} não {missingRepos.length === 1 ? 'está' : 'estão'}{' '}
            no disco.
          </div>
          <button
            type="button"
            onClick={() => void cloneMissing()}
            disabled={cloningMissing}
            className="flex items-center justify-center gap-1.5 rounded-md border border-[var(--color-border)] px-2 py-1.5 text-xs font-medium text-[var(--color-text)] transition hover:bg-[var(--color-surface)] disabled:opacity-60"
          >
            <Icon as={DownloadCloud} size={13} />
            {cloningMissing ? 'Clonando…' : 'Clonar faltantes'}
          </button>
          {cloneError && (
            <div className="text-xs text-[var(--color-danger,#ef4444)]">
              Falha ao clonar: {cloneError}
            </div>
          )}
          {cloneFailures.length > 0 && (
            <ul className="flex flex-col gap-0.5 text-xs text-[var(--color-danger,#ef4444)]">
              {cloneFailures.map((f) => (
                <li key={f.repoId} className="truncate" title={f.detail}>
                  falha ao clonar {f.label}
                  {f.detail ? `: ${f.detail}` : ''}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Sessão avulsa: spawn sem repo, cwd = scratch dir (pref scratch_dir). */}
      <div className="border-b border-[var(--color-border)] px-3 py-2">
        <button
          type="button"
          onClick={() => void openQuickSession()}
          title="Abrir uma sessão Claude avulsa (sem projeto)"
          className="flex w-full items-center justify-center gap-1.5 rounded-md border border-[var(--color-border)] px-2 py-1.5 text-xs font-medium text-[var(--color-text)] transition hover:bg-[var(--color-surface-2)]"
        >
          <Icon as={Zap} size={13} />
          Sessão rápida
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {projects.length === 0 && (
          <div className="flex flex-col items-center gap-3 px-4 py-10 text-center">
            <Icon as={FolderOpen} size={28} className="text-[var(--color-text-dim)] opacity-60" />
            <div className="text-sm font-medium text-[var(--color-text)]">Nenhum projeto ainda</div>
            <div className="text-xs text-[var(--color-text-dim)]">
              Crie um projeto pra agrupar seus repositórios e sessões.
            </div>
            <Button variant="primary" size="sm" className="mt-1" onClick={() => setDialogOpen(true)}>
              Criar projeto
            </Button>
          </div>
        )}

        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={projects.map((p) => p.id)} strategy={verticalListSortingStrategy}>
            <ul className="flex flex-col gap-px py-2">
              {projects.map((p) => (
                <SortableProjectItem
                  key={p.id}
                  project={p}
                  active={p.id === activeProjectId}
                  expanded={expandedProjectIds.has(p.id)}
                  onToggle={() => {
                    setActiveProject(p.id)
                    toggleExpanded(p.id)
                  }}
                  onEdit={() => setEditing(p)}
                  onRemove={() => {
                    if (confirm(`Apagar projeto "${p.name}"?`)) void remove(p.id)
                  }}
                />
              ))}
            </ul>
          </SortableContext>
        </DndContext>
      </div>

      <NewProjectDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        onCreate={async (input) => {
          await create(input)
          setDialogOpen(false)
        }}
      />

      {editing && (
        <EditProjectDialog
          open
          project={editing}
          onClose={() => setEditing(null)}
          onSave={async (input: UpdateProjectInput) => {
            await update(input)
            setEditing(null)
          }}
        />
      )}
    </aside>
  )
}

interface SortableProjectItemProps {
  project: Project
  active: boolean
  expanded: boolean
  onToggle: () => void
  onEdit: () => void
  onRemove: () => void
}

function SortableProjectItem({
  project,
  active,
  expanded,
  onToggle,
  onEdit,
  onRemove,
}: SortableProjectItemProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: project.id,
  })
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : undefined,
  }

  return (
    <li ref={setNodeRef} style={style}>
      <div
        className={`group flex items-center justify-between rounded-lg border-l-2 px-2 py-2 text-sm transition ${
          active || expanded
            ? 'text-[var(--color-text)]'
            : 'border-transparent text-[var(--color-text-dim)] hover:bg-[var(--color-surface-2)]/60 hover:text-[var(--color-text)]'
        }`}
        style={
          active || expanded
            ? {
                borderLeftColor: project.color ?? 'var(--color-accent)',
                background:
                  'linear-gradient(90deg, color-mix(in srgb, var(--color-accent) 10%, transparent), transparent)',
              }
            : undefined
        }
      >
        <button
          type="button"
          {...attributes}
          {...listeners}
          title="Arrastar para reordenar"
          className="shrink-0 cursor-grab touch-none rounded text-[var(--color-text-dim)] opacity-0 transition hover:text-[var(--color-text)] group-hover:opacity-100 active:cursor-grabbing"
        >
          <Icon as={GripVertical} size={14} />
        </button>

        <button
          type="button"
          onClick={onToggle}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <span
            className="h-2.5 w-2.5 shrink-0 rounded-full"
            style={{ background: project.color ?? 'var(--color-text-dim)' }}
          />
          <span className="shrink-0">{renderProjectIcon(project.icon)}</span>
          <span className="truncate">{project.name}</span>
          {!project.vaultPath && (
            <span
              className="shrink-0 text-[10px] text-[var(--color-text-dim)] opacity-60"
              title="Este projeto não tem um vault definido"
            >
              sem vault
            </span>
          )}
        </button>

        <ProjectMenu project={project} onEdit={onEdit} onRemove={onRemove} />
      </div>

      {expanded && <ProjectRepos project={project} />}
    </li>
  )
}

function ProjectMenu({
  project,
  onEdit,
  onRemove,
}: {
  project: Project
  onEdit: () => void
  onRemove: () => void
}) {
  const [open, setOpen] = useState(false)
  return (
    <Menu
      open={open}
      onClose={() => setOpen(false)}
      items={[
        { label: 'Editar', onClick: onEdit },
        { label: 'Remover', danger: true, onClick: onRemove },
      ]}
    >
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          setOpen((v) => !v)
        }}
        className="shrink-0 rounded px-1 leading-none text-[var(--color-text-dim)] opacity-0 transition hover:text-[var(--color-text)] group-hover:opacity-100"
        title={`Ações de "${project.name}"`}
      >
        <Icon as={MoreHorizontal} />
      </button>
    </Menu>
  )
}
