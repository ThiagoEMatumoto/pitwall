import type { Ref } from 'react'
import { Kbd } from '@/components/ui/ShortcutHints'
import { CollapsedItem, OpenItem, type QueueSubject } from './QueueItem'
import type { RoomQueueRow, RoomState } from './room-model'
import { SectionHead } from './room-ui'

interface Props {
  queue: RoomQueueRow[]
  state: RoomState
  openKey: string | null
  subjectOf: (row: RoomQueueRow) => QueueSubject
  now: number
  onOpen: (subjectKey: string) => void
  onStep: (dir: 1 | -1) => void
  openHeadRef: Ref<HTMLDivElement>
}

// "Precisa de você": um item aberto por vez, os outros numa linha.
export function AttentionQueue({
  queue,
  state,
  openKey,
  subjectOf,
  now,
  onOpen,
  onStep,
  openHeadRef,
}: Props) {
  const n = queue.length
  return (
    <section aria-labelledby="room-queue-h" className="min-h-0 overflow-auto px-4 pb-[72px] pt-4">
      <SectionHead id="room-queue-h" title="Precisa de você">
        <span
          data-testid="room-needs-count"
          aria-label={`${n} precisa de você`}
          className="text-[22px] font-bold tabular-nums text-[var(--color-text)]"
        >
          {n}
        </span>
        <span className="ml-auto text-[12px] text-[var(--color-text-dim)]">
          mais bloqueante, depois mais antigo · <Kbd>J</Kbd> <Kbd>K</Kbd> navega
        </span>
      </SectionHead>
      <ul aria-labelledby="room-queue-h" className="m-0 flex list-none flex-col gap-2.5 p-0">
        {n === 0 ? (
          <QueueEmpty empty={state === 'empty'} />
        ) : (
          queue.map((row) =>
            row.subjectKey === openKey ? (
              <OpenItem
                key={row.subjectKey}
                ref={openHeadRef}
                row={row}
                subject={subjectOf(row)}
                now={now}
                hasNext={n > 1}
                onNext={() => onStep(1)}
              />
            ) : (
              <CollapsedItem
                key={row.subjectKey}
                row={row}
                subject={subjectOf(row)}
                now={now}
                onOpen={() => onOpen(row.subjectKey)}
              />
            ),
          )
        )}
      </ul>
    </section>
  )
}

function QueueEmpty({ empty }: { empty: boolean }) {
  return (
    <li
      data-testid="room-queue-empty"
      className="rounded-[10px] border border-dashed border-[var(--color-border)] px-5 py-7 text-center"
    >
      {!empty && (
        <div
          aria-hidden
          className="mx-auto mb-2 flex h-8 w-8 items-center justify-center rounded-full border-2 text-[14px] font-bold"
          style={{ borderColor: 'var(--color-success)', color: 'var(--color-success)' }}
        >
          ✓
        </div>
      )}
      <h3 className="m-0 text-[15px] font-semibold">
        {empty ? 'Nada para decidir ainda' : 'Nada precisa de você'}
      </h3>
      <p className="mb-0 mt-2 text-[13px] text-[var(--color-text-dim)]">
        {empty
          ? 'Perguntas, menus e falhas das sessões desta feature aparecem aqui.'
          : 'As sessões seguem; a fila acende se algo parar.'}
      </p>
    </li>
  )
}
