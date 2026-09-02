import { ArrowUpRight } from 'lucide-react'
import { useId, useState } from 'react'
import { Button } from '@/components/ui/Button'
import { Icon } from '@/components/ui/Icon'
import { navigateToTask } from '@/lib/nav'
import { useMeetingsStore } from '@/store/meetingsStore'
import type { MeetingActionItem, MeetingActionItemBatch, MeetingSegment } from '../../../shared/types/ipc'
import { formatDuration } from './format'

type BatchInput = Omit<MeetingActionItemBatch, 'meetingId'>

interface Props {
  items: MeetingActionItem[]
  /** Sugestões de dono; default: "Eu" + speakers da reunião aberta. */
  participants?: string[]
  /** Default: decideActionItems do store, na reunião dos itens. */
  onBatch?: (batch: BatchInput) => void
  /** Legado da decisão unitária — ainda passado por MeetingDetail (W2-B); ignorado. */
  onDecide?: (id: string, action: MeetingActionItemBatch['action']) => void
}

const ME_LABEL = 'Eu'

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// Espelho do locateQuote do main (só o caso de quote dentro de um segmento):
// o item não guarda timestamp, então a UI o reencontra no transcript.
export function locateQuoteMs(segments: MeetingSegment[], quote: string | null): number | null {
  if (!quote) return null
  const needle = normalize(quote)
  if (!needle) return null
  const hit = segments.find((seg) => normalize(seg.text).includes(needle))
  return hit ? hit.startMs : null
}

function uniqueLabels(labels: string[]): string[] {
  return labels.filter((label, i) => label.trim() && labels.indexOf(label) === i)
}

export function ActionItemsList({ items, participants, onBatch }: Props) {
  const decideActionItems = useMeetingsStore((s) => s.decideActionItems)
  const detail = useMeetingsStore((s) => s.detail)
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set())
  const [owners, setOwners] = useState<Record<string, string>>({})
  const datalistId = useId()

  const meetingId = items[0]?.meetingId ?? null
  const segments = detail && detail.meeting.id === meetingId ? detail.segments : []
  const options = uniqueLabels([ME_LABEL, ...(participants ?? detail?.meeting.speakers.map((s) => s.label) ?? [])])

  const proposed = items.filter((item) => item.status === 'proposed')
  const selectedIds = proposed.filter((item) => selected.has(item.id)).map((item) => item.id)
  const allSelected = proposed.length > 0 && selectedIds.length === proposed.length

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(proposed.map((item) => item.id)))

  const submit = (action: MeetingActionItemBatch['action']) => {
    if (selectedIds.length === 0) return
    const overrides: NonNullable<MeetingActionItemBatch['overrides']> = {}
    if (action === 'create') {
      for (const id of selectedIds) {
        if (id in owners) overrides[id] = { owner: owners[id].trim() || null }
      }
    }
    const batch: BatchInput = { ids: selectedIds, action, ...(Object.keys(overrides).length > 0 ? { overrides } : {}) }
    if (onBatch) onBatch(batch)
    else if (meetingId) void decideActionItems({ meetingId, ...batch })
    setSelected(new Set())
  }

  const count = selectedIds.length
  const countLabel = count === 1 ? '1 selecionada' : `${count} selecionadas`

  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--color-text-dim)]">Tarefas</h3>
      {items.length === 0 ? (
        <p className="text-sm text-[var(--color-text-dim)]">Nenhuma tarefa extraída.</p>
      ) : (
        <>
          {proposed.length > 0 && (
            <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-1.5 text-xs text-[var(--color-text-dim)]">
              <input
                type="checkbox"
                aria-label={allSelected ? 'Desmarcar todas' : 'Selecionar todas'}
                checked={allSelected}
                onChange={toggleAll}
                className="accent-[var(--color-accent)]"
              />
              <span className="tabular-nums">{countLabel}</span>
              <span>·</span>
              <Button variant="primary" disabled={count === 0} onClick={() => submit('create')} className="!px-3 !py-0.5 !text-xs">
                Criar tarefas
              </Button>
              <Button variant="ghost" disabled={count === 0} onClick={() => submit('dismiss')} className="!px-3 !py-0.5 !text-xs">
                Descartar
              </Button>
              <span className="ml-auto">Só as selecionadas viram tarefas.</span>
            </div>
          )}
          <datalist id={datalistId}>
            {options.map((label) => (
              <option key={label} value={label} />
            ))}
          </datalist>
          <ul className="flex flex-col gap-1.5">
            {items.map((item) => {
              const dismissed = item.status === 'dismissed'
              const isProposed = item.status === 'proposed'
              const atMs = locateQuoteMs(segments, item.quote)
              return (
                <li
                  key={item.id}
                  className={`flex flex-col gap-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 ${
                    dismissed ? 'opacity-50' : ''
                  }`}
                >
                  <div className="flex items-start gap-2">
                    {isProposed && (
                      <input
                        type="checkbox"
                        aria-label={`Selecionar ${item.title}`}
                        checked={selected.has(item.id)}
                        onChange={() => toggle(item.id)}
                        className="mt-1 accent-[var(--color-accent)]"
                      />
                    )}
                    <span className={`flex-1 text-sm text-[var(--color-text)] ${dismissed ? 'line-through' : ''}`}>
                      {item.title}
                    </span>
                    {isProposed ? (
                      <input
                        list={datalistId}
                        aria-label={`Dono de ${item.title}`}
                        placeholder="sem dono"
                        value={owners[item.id] ?? item.owner ?? ''}
                        onChange={(e) => setOwners((prev) => ({ ...prev, [item.id]: e.target.value }))}
                        className="w-32 shrink-0 rounded-full border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-0.5 text-xs text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]"
                      />
                    ) : (
                      <span className="shrink-0 rounded-full border border-[var(--color-border)] px-2 py-0.5 text-xs text-[var(--color-text-dim)]">
                        {item.owner ?? 'sem dono'}
                      </span>
                    )}
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
                    {dismissed && <span className="shrink-0 text-xs text-[var(--color-text-dim)]">Descartada</span>}
                  </div>
                  {item.quote && (
                    <p className="text-xs italic text-[var(--color-text-dim)]">
                      “{item.quote}”{atMs !== null && <span className="not-italic tabular-nums"> ({formatDuration(atMs)})</span>}
                    </p>
                  )}
                </li>
              )
            })}
          </ul>
        </>
      )}
    </section>
  )
}
