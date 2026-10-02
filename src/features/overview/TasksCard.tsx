import { useMemo, useState } from 'react'
import { useAppStore } from '@/store/appStore'
import { DueDateBadge, PriorityBadge, TaskStatusBadge } from '@/features/tasks/TaskList'
import { PARENT_TYPE_META } from '@/features/tasks/status'
import { selectUrgentTasks } from '../../../shared/home-selectors'
import type { OverviewPendingTask } from '../../../shared/types/ipc'
import { CardDot, CardEmpty, HomeCard } from './HomeGrid'

// Card "Tasks urgentes": absorve a antiga lista "Pendências do dia" — vencidas
// → vencem hoje → em andamento, via selectUrgentTasks. `pending` já chega
// ordenada do main; o selector re-bucketiza e mantém a ordem canônica.
export function TasksCard({ pending }: { pending: OverviewPendingTask[] }) {
  const setArea = useAppStore((s) => s.setArea)
  // Estado é só o tick de render: o "now" é congelado por render pra urgência
  // ser consistente dentro da lista (broadcasts re-renderizam com now novo).
  const [now] = useState(() => Date.now())
  const urgent = useMemo(() => selectUrgentTasks(pending, now), [pending, now])

  return (
    <HomeCard
      title="Tasks urgentes"
      count={urgent.length}
      dot={<CardDot color="var(--color-warning)" />}
      action={
        <button
          type="button"
          onClick={() => setArea('tasks')}
          className="text-[10px] text-[var(--color-text-dim)] transition hover:text-[var(--color-accent)]"
        >
          ver todas
        </button>
      }
    >
      {urgent.length === 0 ? (
        <CardEmpty>Nada urgente — nada vencido nem em andamento.</CardEmpty>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {urgent.map((task) => (
            <TaskRow key={task.id} task={task} />
          ))}
        </ul>
      )}
    </HomeCard>
  )
}

function TaskRow({ task }: { task: OverviewPendingTask }) {
  return (
    // Título numa linha, chips numa segunda menor: na mesma linha eles comiam o
    // título em ~20 caracteres.
    <li className="flex flex-col gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)]/40 px-2.5 py-1.5">
      <span data-testid="task-row-title" className="min-w-0 truncate text-sm text-[var(--color-text)]" title={task.title}>
        {task.title}
      </span>
      <span className="flex min-w-0 flex-wrap items-center gap-1.5">
      <TaskStatusBadge status={task.status} />
      {task.priority && <PriorityBadge priority={task.priority} />}
      <DueDateBadge task={task} />
      {task.parents.map((p) => (
        <span
          key={`${p.type}:${p.id}`}
          className="inline-flex max-w-40 items-center gap-1 rounded-full border border-[var(--color-border)] px-2 py-0.5 text-[10px] text-[var(--color-text-dim)]"
          title={`${PARENT_TYPE_META[p.type].label}: ${p.title}`}
        >
          <span className="shrink-0 font-medium text-[var(--color-accent)]">
            {PARENT_TYPE_META[p.type].label}
          </span>
          <span className="truncate">{p.title}</span>
        </span>
      ))}
      </span>
    </li>
  )
}
