import type { ReactNode } from 'react'
import { Button } from '@/components/ui/Button'
import { StatusBadge } from '@/features/handoffs/HandoffCard'
import { TONE_COLOR } from '@/features/session-canvas/card-indicator'
import { EXEC_LABEL } from './room-labels'
import type { RoomProgress, RoomRepo, RoomSessionRow } from './room-model'
import { COMPACT, ExecDot, Glyph, SectionHead, rowGlyph } from './room-ui'

interface Props {
  hasMother: boolean
  repos: RoomRepo[]
  progress: RoomProgress
  filter: string | null
  onFilter: (sessionId: string | null) => void
  onPeek: (row: RoomSessionRow) => void
  onSeeMap: () => void
}

// A lateral: só as filhas, por repo. A mãe está no centro (RoomMotherPane).
export function RoomSessions(props: Props) {
  const { repos, progress } = props
  const rows = repos.flatMap((r) => r.rows)
  const total = rows.length
  return (
    <section aria-labelledby="room-sessions-h" className="min-h-0 overflow-auto p-4">
      <SectionHead id="room-sessions-h" title="Filhas por repo">
        <button
          type="button"
          onClick={props.onSeeMap}
          className="ml-auto text-[12px] text-[var(--color-text-dim)] underline hover:text-[var(--color-text)]"
        >
          Ver no mapa
        </button>
      </SectionHead>
      {total === 0 ? (
        <p
          data-testid="room-children-empty"
          className="m-0 text-[13px] text-[var(--color-text-dim)]"
        >
          {props.hasMother
            ? 'A mãe ainda não abriu filhas.'
            : 'As filhas aparecem aqui quando a mãe delegar.'}
        </p>
      ) : (
        <>
          {progress.total > 0 && <Progress progress={progress} />}
          {repos.map((repo) => (
            <div key={repo.repoId ?? repo.label} className="mt-3.5">
              <div className="mb-1.5 flex items-baseline justify-between px-1">
                <span className="font-mono text-[12px] text-[var(--color-text)]">
                  {repo.label || 'sem repo'}
                </span>
                <span className="text-[11.5px] tabular-nums text-[var(--color-text-dim)]">
                  {repo.rows.length}
                </span>
              </div>
              <ul className="m-0 list-none overflow-hidden rounded-[10px] border border-[var(--color-border)] bg-[var(--color-surface)] p-0">
                {repo.rows.map((row, i) => (
                  <ChildRow
                    key={row.handoffId ?? row.sessionId ?? i}
                    row={row}
                    first={i === 0}
                    pressed={!!row.sessionId && props.filter === row.sessionId}
                    onFilter={props.onFilter}
                    onPeek={props.onPeek}
                  />
                ))}
              </ul>
            </div>
          ))}
        </>
      )}
    </section>
  )
}

function ExecLine({ row }: { row: RoomSessionRow }) {
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-[12px] text-[var(--color-text-dim)]">
      <ExecDot exec={row.exec} />
      <span className="shrink-0" data-testid="room-exec">
        {EXEC_LABEL[row.exec]}
      </span>
      {row.lastText && (
        <span className="min-w-0 truncate" title={row.lastText} data-testid="room-last-text">
          · {row.lastText}
        </span>
      )}
    </span>
  )
}

function Progress({ progress }: { progress: RoomProgress }) {
  const { total, done, running, needsYou, stopped } = progress
  const segs: Array<[number, string]> = [
    [done, TONE_COLOR.done],
    [running, TONE_COLOR.working],
    [needsYou, TONE_COLOR['needs-you']],
    [stopped, TONE_COLOR.interrupted],
  ]
  return (
    <div className="mt-2.5" data-testid="room-progress">
      <div
        role="img"
        aria-label={`${done} concluídas, ${running} andando, ${needsYou} esperando você, ${stopped} paradas`}
        className="flex h-1.5 overflow-hidden rounded-full bg-[var(--color-surface-2)]"
      >
        {segs.map(([v, c], i) =>
          v ? <i key={i} style={{ width: `${(100 * v) / total}%`, background: c }} /> : null,
        )}
      </div>
      <div className="mt-1.5 flex flex-wrap gap-3 text-[11.5px] tabular-nums text-[var(--color-text-dim)]">
        <Legend color={TONE_COLOR.done}>
          {done}/{total} concluídas
        </Legend>
        <Legend color={TONE_COLOR.working}>{running} andando</Legend>
        <Legend color={TONE_COLOR['needs-you']}>{needsYou} esperando você</Legend>
        {stopped > 0 && (
          <Legend color={TONE_COLOR.interrupted}>
            {stopped} {stopped === 1 ? 'parada' : 'paradas'}
          </Legend>
        )}
      </div>
    </div>
  )
}

function Legend({ color, children }: { color: string; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span aria-hidden className="h-2 w-2 rounded-sm" style={{ background: color }} />
      {children}
    </span>
  )
}

function WorkPillView({ row }: { row: RoomSessionRow }) {
  const work = row.work
  if (!work) return null
  if (work.resultUnread)
    return (
      <span
        className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-medium"
        style={{
          color: 'var(--color-success)',
          borderColor: 'color-mix(in srgb, var(--color-success) 45%, transparent)',
          background: 'color-mix(in srgb, var(--color-success) 12%, transparent)',
        }}
      >
        Concluída · resultado não lido pela mãe
      </span>
    )
  return (
    <StatusBadge status={work.status} paused={work.status === 'interrupted' && work.resumable} />
  )
}

export const READ_ONLY_HINT =
  'Não conta para a trava do diretório. Se você aprovar o plano dela, ela pode escrever pelo shell.'

function ReadOnlyTag() {
  return (
    <span
      data-testid="room-readonly"
      title={READ_ONLY_HINT}
      aria-label={`leitura: ${READ_ONLY_HINT}`}
      className="shrink-0 rounded-full border border-[var(--color-border)] px-1.5 py-px text-[11px] font-normal text-[var(--color-text-dim)]"
    >
      leitura
    </span>
  )
}

function ChildRow({
  row,
  first,
  pressed,
  onFilter,
  onPeek,
}: {
  row: RoomSessionRow
  first: boolean
  pressed: boolean
  onFilter: (sessionId: string | null) => void
  onPeek: (row: RoomSessionRow) => void
}) {
  const ended = row.exec === 'ended' || row.exec === 'gone'
  return (
    <li
      data-testid="room-child-row"
      className={`flex items-center ${first ? '' : 'border-t border-[var(--color-border)]'}`}
    >
      <button
        type="button"
        aria-pressed={pressed}
        disabled={!row.sessionId}
        onClick={() => onFilter(pressed ? null : row.sessionId)}
        title={`Filtrar a linha do tempo por ${row.title}`}
        className={`grid min-w-0 flex-1 grid-cols-[16px_minmax(0,1fr)_auto] items-center gap-2 py-[9px] pr-2 text-left hover:bg-[var(--color-surface-2)] ${
          row.depth === 2 ? 'pl-7' : 'pl-2.5'
        } ${
          pressed ? 'bg-[var(--color-surface-2)] shadow-[inset_2px_0_0_var(--color-accent)]' : ''
        }`}
      >
        {/* Encerrada esmaece só o glifo: opacidade no texto derrubava o contraste a ~3,6:1. */}
        <span className={`inline-flex ${ended ? 'opacity-[0.62]' : ''}`}>
          <Glyph shape={rowGlyph(row)} />
        </span>
        <span className="flex min-w-0 flex-col gap-px">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-[13.5px] font-semibold">
              {row.depth === 2 ? '↳ ' : ''}
              {row.title}
            </span>
            {row.readOnly && <ReadOnlyTag />}
          </span>
          {row.motherTitle && (
            <span
              className="truncate text-[11.5px] text-[var(--color-text-dim)]"
              data-testid="room-child-mother"
            >
              de {row.motherTitle}
            </span>
          )}
          <ExecLine row={row} />
        </span>
        <WorkPillView row={row} />
      </button>
      <Button
        variant="ghost"
        className={`${COMPACT} mr-2 shrink-0`}
        aria-label={`Peek em ${row.title}`}
        disabled={!row.handoffId && !row.sessionId}
        onClick={() => onPeek(row)}
      >
        Peek
      </Button>
    </li>
  )
}
