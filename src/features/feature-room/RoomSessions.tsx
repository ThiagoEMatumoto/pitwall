import type { ReactNode } from 'react'
import { Crown } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Icon } from '@/components/ui/Icon'
import { StatusBadge } from '@/features/handoffs/HandoffCard'
import { TONE_COLOR } from '@/features/session-canvas/card-indicator'
import { EXEC_LABEL } from './room-labels'
import type { RoomProgress, RoomRepo, RoomSessionRow } from './room-model'
import { COMPACT, ExecDot, Glyph, SectionHead, rowGlyph } from './room-ui'

interface Props {
  mother: RoomSessionRow | null
  repos: RoomRepo[]
  progress: RoomProgress
  filter: string | null
  canDelegate: boolean
  onFilter: (sessionId: string | null) => void
  onPeek: (row: RoomSessionRow) => void
  onTerminal: (row: RoomSessionRow) => void
  onNewChild: () => void
  onSeeMap: () => void
}

export function RoomSessions(props: Props) {
  const { mother, repos } = props
  const rows = repos.flatMap((r) => r.rows)
  const total = rows.length + (mother ? 1 : 0)
  const repoCount = new Set([...repos.map((r) => r.label), ...(mother ? [mother.repoLabel] : [])])
    .size
  return (
    <section aria-labelledby="room-sessions-h" className="min-h-0 overflow-auto p-4">
      <SectionHead id="room-sessions-h" title="Sessões">
        {total > 0 && (
          <span className="ml-auto text-[12px] text-[var(--color-text-dim)]">
            {total} em {repoCount} repo(s)
          </span>
        )}
      </SectionHead>
      {total === 0 ? (
        <SessionsEmpty onSeeMap={props.onSeeMap} />
      ) : (
        <>
          {mother && <MotherCard {...props} mother={mother} />}
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

function SessionsEmpty({ onSeeMap }: { onSeeMap: () => void }) {
  return (
    <div className="rounded-[10px] border border-dashed border-[var(--color-border)] p-[22px] text-center text-[13px] text-[var(--color-text-dim)]">
      <p className="mb-1 mt-0 font-semibold text-[var(--color-text)]">
        Nenhuma sessão nesta feature
      </p>
      <p className="mb-3 mt-0">Comece pela mãe: ela decompõe e delega as filhas.</p>
      <div className="flex justify-center gap-2">
        <Button variant="ghost" className={COMPACT} onClick={onSeeMap}>
          Ver no mapa
        </Button>
        <Button variant="ghost" className={COMPACT} disabled title="Uma filha precisa de uma mãe">
          + Filha
        </Button>
      </div>
    </div>
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

function MotherCard({
  mother,
  progress,
  canDelegate,
  onPeek,
  onTerminal,
  onNewChild,
}: Props & { mother: RoomSessionRow }) {
  const kids = progress.total
  return (
    <div
      data-testid="room-mother"
      className="rounded-[10px] border p-3"
      style={{
        borderColor: 'color-mix(in srgb, var(--color-accent) 45%, var(--color-border))',
        background: 'color-mix(in srgb, var(--color-accent) 5%, var(--color-surface))',
      }}
    >
      <div className="flex items-center gap-2">
        <Icon as={Crown} size={13} className="text-[var(--color-accent)]" />
        <span className="min-w-0 truncate text-[14px] font-semibold">{mother.title}</span>
        {kids > 0 && (
          <span
            className="shrink-0 rounded-full border px-2 py-px text-[11.5px]"
            style={{
              color: 'var(--color-accent)',
              borderColor: 'color-mix(in srgb, var(--color-accent) 50%, transparent)',
              background: 'color-mix(in srgb, var(--color-accent) 9%, transparent)',
            }}
          >
            Coordenando {kids} {kids === 1 ? 'filha' : 'filhas'}
          </span>
        )}
        <span className="ml-auto shrink-0 font-mono text-[11.5px] text-[var(--color-text-dim)]">
          {mother.repoLabel}
        </span>
      </div>
      <div className="mt-1">
        <ExecLine row={mother} />
      </div>
      {mother.purpose && (
        <div className="mt-0.5 truncate text-[12.5px]" title={mother.purpose}>
          {mother.purpose}
        </div>
      )}
      {kids > 0 && <Progress progress={progress} />}
      <div className="mt-2.5 flex flex-wrap gap-2">
        <Button variant="ghost" className={COMPACT} onClick={() => onPeek(mother)}>
          Peek
        </Button>
        <Button variant="ghost" className={COMPACT} onClick={() => onTerminal(mother)}>
          Abrir terminal
        </Button>
        <Button variant="ghost" className={COMPACT} disabled={!canDelegate} onClick={onNewChild}>
          + Filha
        </Button>
      </div>
    </div>
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
          <span className="truncate text-[13.5px] font-semibold">
            {row.depth === 2 ? '↳ ' : ''}
            {row.title}
          </span>
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
