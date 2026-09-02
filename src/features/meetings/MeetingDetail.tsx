import { useEffect, useState } from 'react'
import { Pencil } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import { useMeetingsStore } from '@/store/meetingsStore'
import { ActionItemsList } from './ActionItemsList'
import { LiveTranscript } from './LiveTranscript'
import { NotesEditor } from './NotesEditor'
import { SummaryView } from './SummaryView'
import { STATUS_COLOR, STATUS_LABEL, formatDateTime, formatDuration } from './format'

interface InlineEditProps {
  value: string
  onSave: (value: string) => void
  className: string
  inputClassName?: string
  title: string
}

function InlineEdit({ value, onSave, className, inputClassName = '', title }: InlineEditProps) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)

  useEffect(() => {
    if (!editing) setDraft(value)
  }, [value, editing])

  const commit = () => {
    setEditing(false)
    const next = draft.trim()
    if (next && next !== value) onSave(next)
  }

  if (editing) {
    return (
      <input
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit()
          if (e.key === 'Escape') {
            setDraft(value)
            setEditing(false)
          }
        }}
        className={`rounded border border-[var(--color-accent)]/60 bg-[var(--color-surface)] px-1 outline-none ${inputClassName}`}
      />
    )
  }

  return (
    <button
      type="button"
      title={title}
      onClick={() => setEditing(true)}
      className={`group inline-flex items-center gap-1.5 rounded px-1 text-left hover:bg-[var(--color-surface-2)] ${className}`}
    >
      <span className="truncate">{value}</span>
      <span className="text-[var(--color-text-dim)] opacity-0 transition group-hover:opacity-100">
        <Icon as={Pencil} size={12} />
      </span>
    </button>
  )
}

interface Props {
  activeElapsedMs: number
}

export function MeetingDetail({ activeElapsedMs }: Props) {
  const detail = useMeetingsStore((s) => s.detail)
  const rename = useMeetingsStore((s) => s.rename)
  const setThemLabel = useMeetingsStore((s) => s.setThemLabel)
  const updateNotes = useMeetingsStore((s) => s.updateNotes)
  const resummarize = useMeetingsStore((s) => s.resummarize)
  const decideActionItems = useMeetingsStore((s) => s.decideActionItems)

  if (!detail) {
    return <p className="px-6 py-6 text-sm text-[var(--color-text-dim)]">Carregando…</p>
  }

  const { meeting, segments, actionItems } = detail
  const recording = meeting.status === 'recording'

  const transcript = (
    <section className="flex flex-col gap-2">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--color-text-dim)]">
        {recording ? 'Transcrição ao vivo' : 'Transcrição'}
      </h3>
      <LiveTranscript segments={segments} themLabel={meeting.themLabel} recording={recording} />
    </section>
  )

  const notes = (
    <section className="flex flex-col gap-2">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--color-text-dim)]">Notas</h3>
      <NotesEditor meetingId={meeting.id} initial={meeting.rawNotes} onSave={updateNotes} />
    </section>
  )

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <header className="flex flex-col gap-1 border-b border-[var(--color-border)] px-6 py-4">
        <InlineEdit
          value={meeting.title}
          onSave={(title) => void rename(meeting.id, title)}
          title="Renomear"
          className="-mx-1 max-w-full text-lg font-semibold text-[var(--color-text)]"
          inputClassName="w-full text-lg font-semibold text-[var(--color-text)]"
        />
        <p className="flex flex-wrap items-center gap-2 text-xs text-[var(--color-text-dim)]">
          <span>{formatDateTime(meeting.startedAt)}</span>
          <span>·</span>
          <span className="tabular-nums">{formatDuration(recording ? activeElapsedMs : meeting.durationMs)}</span>
          <span>·</span>
          <span style={{ color: STATUS_COLOR[meeting.status] }}>{STATUS_LABEL[meeting.status]}</span>
          <span>·</span>
          <span className="inline-flex items-center gap-1">
            Participante:
            <InlineEdit
              value={meeting.themLabel}
              onSave={(label) => void setThemLabel(meeting.id, label)}
              title="Renomear participante"
              className="text-xs text-[var(--color-text)]"
              inputClassName="w-40 text-xs text-[var(--color-text)]"
            />
          </span>
        </p>
        {meeting.status === 'error' && meeting.error && (
          <p className="text-xs text-[var(--color-danger)]">{meeting.error}</p>
        )}
      </header>

      <div className="flex flex-1 flex-col gap-6 overflow-y-auto px-6 py-4">
        {recording ? (
          <>
            {transcript}
            {notes}
          </>
        ) : (
          <>
            <SummaryView meeting={meeting} onResummarize={() => void resummarize(meeting.id)} />
            <ActionItemsList
              items={actionItems}
              onDecide={(id, action) => void decideActionItems({ meetingId: meeting.id, ids: [id], action })}
            />
            {notes}
            {transcript}
          </>
        )}
      </div>
    </div>
  )
}
