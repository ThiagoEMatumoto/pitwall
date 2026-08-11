import { useMemo, useState } from 'react'
import { ArrowUpRight, FolderInput, GripVertical, Link2, MoreHorizontal } from 'lucide-react'
import type { LucideProps } from 'lucide-react'
import type { ComponentType } from 'react'
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
import { useRepos } from './useProjects'
import { AddRepoDialog } from './AddRepoDialog'
import { EditRepoDialog } from './EditRepoDialog'
import { UntrackedFolders } from './UntrackedFolders'
import { HandoffRow } from './HandoffRow'
import { Menu } from '@/components/ui/Menu'
import { Icon } from '@/components/ui/Icon'
import { SessionsModal } from '@/features/sessions/SessionsModal'
import { SpawnSessionDialog } from '@/features/sessions/SpawnSessionDialog'
import { useAppStore } from '@/store/appStore'
import { useHandoffsStore, ACTIVE_HANDOFF_STATUSES } from '@/store/handoffsStore'
import { useRepoPullStore } from '@/store/repoPullStore'
import { useProjectsPrefsStore } from '@/lib/projects-prefs-store'
import { repoApi } from '@/lib/ipc'
import type { Handoff, LinkKind, Project, Repo, UpdateRepoInput } from '../../../shared/types/ipc'

// Quantos handoffs terminais (done/failed) recentes mostrar — os ativos sempre
// aparecem; rejected é ocultado.
const MAX_TERMINAL_HANDOFFS = 3

// Deriva os handoffs deste projeto a partir da lista crua + os repos do projeto.
// JOIN no componente (handoff pertence ao projeto se o repo-alvo é do projeto).
// NÃO usar como selector zustand — filter/sort retornam array novo (loop no v5);
// chamar dentro de useMemo. Ativos sempre; até N terminais recentes; rejected
// oculto. Ordenado por updatedAt desc.
function projectHandoffs(handoffs: Handoff[], repos: Repo[]): Handoff[] {
  const repoIds = new Set(repos.map((r) => r.id))
  const mine = handoffs.filter(
    (h) => repoIds.has(h.targetRepoId) && h.status !== 'rejected',
  )
  const active = mine
    .filter((h) => ACTIVE_HANDOFF_STATUSES.has(h.status))
    .sort((a, b) => b.updatedAt - a.updatedAt)
  const terminal = mine
    .filter((h) => h.status === 'done' || h.status === 'failed')
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_TERMINAL_HANDOFFS)
  return [...active, ...terminal]
}

interface Props {
  project: Project
}

// Motivo do atraso reportado pelo último pull (BranchPullOutcome.detail), em
// texto pro tooltip do badge. Fora do mapa (ex. mensagem de erro do git) vai cru.
const PULL_REASON_LABEL: Record<string, string> = {
  dirty: 'working tree suja',
  diverged: 'commits locais adiante',
  'checked-out-elsewhere': 'branch em checkout em outra worktree',
  'checked-out-elsewhere-dirty': 'outra worktree com working tree suja',
  'checked-out-elsewhere-diverged': 'outra worktree com commits locais adiante',
  'untracked-collision': 'arquivo não rastreado seria sobrescrito pelo remote',
  'checked-out-elsewhere-untracked-collision':
    'outra worktree com arquivo não rastreado que seria sobrescrito',
}

const LINK_BADGE: Record<LinkKind, { icon: ComponentType<LucideProps>; title: string }> = {
  inside: { icon: FolderInput, title: 'Dentro do vault' },
  symlink: { icon: Link2, title: 'Symlink para fora do vault' },
  external: { icon: ArrowUpRight, title: 'Referência externa' },
}

export function ProjectRepos({ project }: Props) {
  const { repos, untracked, create, adopt, update, remove, reorder } = useRepos(project.id)
  const [adding, setAdding] = useState(false)

  // Watch/load dos handoffs já é montado globalmente (useHandoffs no AppShell);
  // aqui só lemos a lista crua. O JOIN com repos é derivado em useMemo — selector
  // que retorna array novo causa loop infinito no zustand v5.
  const showHandoffsInline = useProjectsPrefsStore((s) => s.showHandoffsInline)
  const handoffs = useHandoffsStore((s) => s.handoffs)
  const projectHandoffsList = useMemo(
    () => (showHandoffsInline ? projectHandoffs(handoffs, repos) : []),
    [showHandoffsInline, handoffs, repos],
  )

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }))

  function onDragEnd(event: DragEndEvent) {
    const { active, over } = event
    if (over && active.id !== over.id) {
      void reorder(String(active.id), String(over.id))
    }
  }

  return (
    <div className="border-l border-[var(--color-border)]/50 bg-[var(--color-bg)]/40 pl-4">
      {repos.length === 0 ? (
        <div className="px-4 py-3 text-xs text-[var(--color-text-dim)]">
          <div className="mb-2">Nenhum repo neste projeto.</div>
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="rounded-md border border-[var(--color-border)] px-2.5 py-1 text-[var(--color-text)] transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
          >
            + Adicionar repo
          </button>
        </div>
      ) : (
        <>
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
            <SortableContext items={repos.map((r) => r.id)} strategy={verticalListSortingStrategy}>
              <ul className="flex flex-col gap-px py-1">
                {repos.map((r) => (
                  <RepoRow
                    key={r.id}
                    repo={r}
                    project={project}
                    onUpdate={update}
                    onRemove={remove}
                  />
                ))}
              </ul>
            </SortableContext>
          </DndContext>

          <button
            type="button"
            onClick={() => setAdding(true)}
            className="block w-full px-4 py-1.5 text-left text-xs text-[var(--color-text-dim)] transition hover:text-[var(--color-accent)]"
          >
            + repo
          </button>
        </>
      )}

      {showHandoffsInline && projectHandoffsList.length > 0 && (
        <div className="mt-1 border-t border-[var(--color-border)]/40 pt-1">
          <div className="px-1 py-1 text-[10px] font-medium uppercase tracking-wide text-[var(--color-text-dim)]">
            Delegações ({projectHandoffsList.length})
          </div>
          <div className="flex flex-col gap-px text-xs">
            {projectHandoffsList.map((h) => (
              <HandoffRow key={h.id} handoff={h} />
            ))}
          </div>
        </div>
      )}

      <UntrackedFolders folders={untracked} onAdopt={adopt} />

      <AddRepoDialog
        open={adding}
        onClose={() => setAdding(false)}
        project={project}
        onCreate={create}
      />
    </div>
  )
}

interface RepoRowProps {
  repo: Repo
  project: Project
  onUpdate: (input: UpdateRepoInput) => Promise<void>
  onRemove: (id: string) => Promise<void>
}

function RepoRow({ repo, project, onUpdate, onRemove }: RepoRowProps) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [sessionsOpen, setSessionsOpen] = useState(false)
  const [editOpen, setEditOpen] = useState(false)
  const [spawnOpen, setSpawnOpen] = useState(false)
  const openSession = useAppStore((s) => s.openSession)
  // Atraso medido no último pull (auto ou manual). > 0 = o ff-only não deu conta
  // (branch suja/divergente) e o repo segue para trás do origin.
  const behind = useRepoPullStore((s) => s.statusByRepo[repo.id]?.behind ?? 0)
  const behindReason = useRepoPullStore((s) => s.statusByRepo[repo.id]?.reason)
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: repo.id,
  })
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : undefined,
  }

  return (
    <li ref={setNodeRef} style={style} className="text-xs">
      <div className="group flex items-center justify-between gap-1 px-1 py-1.5">
        <button
          type="button"
          {...attributes}
          {...listeners}
          title="Arrastar para reordenar"
          className="shrink-0 cursor-grab touch-none rounded text-[var(--color-text-dim)] opacity-0 transition hover:text-[var(--color-text)] group-hover:opacity-100 active:cursor-grabbing"
        >
          <Icon as={GripVertical} size={12} />
        </button>

        <button
          type="button"
          onClick={() => setSpawnOpen(true)}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-[var(--color-text-dim)] transition hover:text-[var(--color-text)]"
          title={`Nova sessão · ${repo.path}`}
        >
          <span className="shrink-0" title={LINK_BADGE[repo.linkKind].title}>
            <Icon as={LINK_BADGE[repo.linkKind].icon} size={14} />
          </span>
          <span className="truncate">{repo.label}</span>
        </button>

        {behind > 0 && (
          <span
            className="shrink-0 rounded-full border border-[var(--color-border)] px-1.5 py-0.5 text-[9px] font-medium text-[var(--color-text-dim)]"
            title={`${behind} commit${behind === 1 ? '' : 's'} atrás do origin no último pull${
              behindReason ? ` — ${PULL_REASON_LABEL[behindReason] ?? behindReason}` : ''
            }`}
          >
            {behind} atrás
          </span>
        )}

        <Menu
          open={menuOpen}
          onClose={() => setMenuOpen(false)}
          items={[
            {
              label: 'Nova sessão',
              onClick: () => setSpawnOpen(true),
            },
            { label: 'Ver sessões…', onClick: () => setSessionsOpen(true) },
            { label: 'git pull', onClick: () => void repoApi.pullOne({ repoId: repo.id }) },
            { label: 'Editar', onClick: () => setEditOpen(true) },
            {
              label: 'Remover repo',
              danger: true,
              onClick: () => {
                if (confirm(`Apagar repo "${repo.label}"?`)) void onRemove(repo.id)
              },
            },
          ]}
        >
          <button
            type="button"
            onClick={() => setMenuOpen((v) => !v)}
            className="shrink-0 rounded px-1 leading-none text-[var(--color-text-dim)] opacity-0 transition hover:text-[var(--color-text)] group-hover:opacity-100"
            title="Ações do repo"
          >
            <Icon as={MoreHorizontal} size={14} />
          </button>
        </Menu>
      </div>

      {/* Spawn com controles no caminho principal: o clique no repo abre o diálogo
          pré-preenchido com os defaults — Enter no nome confirma rápido. */}
      <SpawnSessionDialog
        open={spawnOpen}
        onClose={() => setSpawnOpen(false)}
        repo={repo}
        onConfirm={(name, featureId, model, effort, permission, advisorModel, initialCommand) => {
          void openSession(
            repo,
            project.name,
            project.icon,
            project.color,
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
          setSpawnOpen(false)
        }}
      />

      <SessionsModal
        repo={repo}
        projectName={project.name}
        projectIcon={project.icon}
        projectColor={project.color}
        open={sessionsOpen}
        onClose={() => setSessionsOpen(false)}
      />

      {editOpen && (
        <EditRepoDialog
          open
          repo={repo}
          onClose={() => setEditOpen(false)}
          onSave={async (input) => {
            await onUpdate(input)
            setEditOpen(false)
          }}
        />
      )}
    </li>
  )
}
