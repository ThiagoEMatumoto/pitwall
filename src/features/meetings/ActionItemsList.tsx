import { ArrowUpRight } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Icon } from '@/components/ui/Icon'
import { navigateToTask } from '@/lib/nav'
import type { MeetingActionItem, MeetingActionItemBatch } from '../../../shared/types/ipc'

interface Props {
  items: MeetingActionItem[]
  onDecide: (id: string, action: MeetingActionItemBatch['action']) => void
}

export function ActionItemsList({ items, onDecide }: Props) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--color-text-dim)]">Tarefas</h3>
      {items.length === 0 ? (
        <p className="text-sm text-[var(--color-text-dim)]">Nenhuma tarefa extraída.</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {items.map((item) => {
            const dismissed = item.status === 'dismissed'
            return (
              <li
                key={item.id}
                className={`flex flex-col gap-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 ${
                  dismissed ? 'opacity-50' : ''
                }`}
              >
                <div className="flex items-start justify-between gap-3">
                  <span className={`text-sm text-[var(--color-text)] ${dismissed ? 'line-through' : ''}`}>
                    {item.title}
                  </span>
                  {item.status === 'created' && item.taskId && (
                    <button
                      type="button"
                      onClick={() => navigateToTask(item.taskId as string)}
                      className="inline-flex shrink-0 items-center gap-0.5 text-xs text-[var(--color-accent)] hover:underline"
                    >
                      Ver na área Tarefas
                      <Icon as={ArrowUpRight} size={12} />
                    </button>
                  )}
                  {item.status === 'proposed' && (
                    <span className="flex shrink-0 items-center gap-1">
                      <Button
                        variant="ghost"
                        onClick={() => onDecide(item.id, 'create')}
                        className="!px-2.5 !py-0.5 !text-xs"
                      >
                        Criar tarefa
                      </Button>
                      <Button
                        variant="ghost"
                        onClick={() => onDecide(item.id, 'dismiss')}
                        className="!px-2.5 !py-0.5 !text-xs"
                      >
                        Descartar
                      </Button>
                    </span>
                  )}
                  {dismissed && <span className="text-xs text-[var(--color-text-dim)]">Descartada</span>}
                </div>
                {item.quote && (
                  <p className="text-xs italic text-[var(--color-text-dim)]">“{item.quote}”</p>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
