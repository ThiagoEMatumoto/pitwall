import { useEffect, useState } from 'react'
import { Download, Pencil } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Icon } from '@/components/ui/Icon'
import { useMeetingsStore } from '@/store/meetingsStore'
import type { Meeting, MeetingDiarizationLiveStatus, MeetingSetupStatus } from '../../../shared/types/ipc'
import { ActionItemsList } from './ActionItemsList'
import { LiveTranscript } from './LiveTranscript'
import { NotesEditor } from './NotesEditor'
import { SpeakerName, speakerColor } from './SpeakerName'
import { SummaryView } from './SummaryView'
import { STATUS_COLOR, STATUS_LABEL, formatDateTime, formatDuration } from './format'
import { useSpeakerActions, type ModelProgress } from './useSpeakerActions'

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

const EMBEDDING_MODEL_MB = 39

const DIARIZATION_TEXT: Record<MeetingDiarizationLiveStatus, string> = {
  on: 'Vozes identificadas automaticamente',
  off: 'Diarização desligada',
  unavailable: 'Diarização indisponível nesta plataforma',
  loading: 'Carregando modelo de voz…',
}

interface DiarizationStatusProps {
  status: MeetingDiarizationLiveStatus | null
  setup: MeetingSetupStatus | null
  progress: ModelProgress | null
  busy: boolean
  onDownload: () => void
}

function DiarizationStatus({ status, setup, progress, busy, onDownload }: DiarizationStatusProps) {
  const embedding = setup?.diarization.models.embedding ?? null
  const downloading = (progress && !progress.done) || embedding === 'downloading'
  const pct = Math.round((progress?.progress ?? setup?.diarization.models.progress ?? 0) * 100)

  if (downloading) {
    return <span className="text-xs text-[var(--color-text-dim)]">Baixando modelo de voz… {pct} %</span>
  }
  if (progress?.error) {
    return <span className="text-xs text-[var(--color-danger)]">Falha ao baixar o modelo: {progress.error}</span>
  }
  if (embedding === 'missing' && setup?.diarization.supported) {
    return (
      <span className="inline-flex items-center gap-2 text-xs text-[var(--color-text-dim)]">
        Modelo de voz ausente
        <Button variant="ghost" onClick={onDownload} disabled={busy} className="!px-2 !py-0.5 !text-xs">
          <Icon as={Download} size={12} />
          Baixar modelo ({EMBEDDING_MODEL_MB} MB)
        </Button>
      </span>
    )
  }
  if (!status) return null
  return <span className="text-xs text-[var(--color-text-dim)]">{DIARIZATION_TEXT[status]}</span>
}

interface ParticipantsProps {
  meeting: Meeting
  recording: boolean
  actions: ReturnType<typeof useSpeakerActions>
}

function Participants({ meeting, recording, actions }: ParticipantsProps) {
  const live = useMeetingsStore((s) => s.live)
  const setup = useMeetingsStore((s) => s.setup)
  const { renameSpeaker, downloadModels, modelProgress, error, busy } = actions
  const status = recording ? (live?.diarization ?? meeting.diarization) : meeting.diarization

  if (meeting.speakers.length === 0 && !status && !setup) return null

  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--color-text-dim)]">Participantes</h3>
      {meeting.speakers.length > 0 ? (
        <ul className="flex flex-wrap gap-2">
          {meeting.speakers.map((speaker, i) => (
            <li
              key={speaker.id}
              className="inline-flex items-center gap-1.5 rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1 text-xs"
            >
              <span className="size-2 rounded-full" style={{ background: speakerColor(i) }} aria-hidden />
              <SpeakerName
                label={speaker.label}
                color={speakerColor(i)}
                onRename={(name) => void renameSpeaker(meeting.id, speaker.id, name)}
                className="font-medium"
              />
              <span className="tabular-nums text-[var(--color-text-dim)]">
                {speaker.turnCount} {speaker.turnCount === 1 ? 'turno' : 'turnos'}
              </span>
              {speaker.voiceId && (
                <span className="rounded bg-[color-mix(in_srgb,var(--color-success)_18%,transparent)] px-1.5 text-[10px] uppercase tracking-wide text-[var(--color-success)]">
                  voz salva
                </span>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-[var(--color-text-dim)]">
          {recording ? 'Nenhuma voz identificada ainda.' : 'Nenhuma voz identificada nesta reunião.'}
        </p>
      )}
      <DiarizationStatus
        status={status}
        setup={setup}
        progress={modelProgress}
        busy={busy}
        onDownload={() => void downloadModels()}
      />
      {error && <p className="text-xs text-[var(--color-danger)]">{error}</p>}
    </section>
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
  const speakerActions = useSpeakerActions()
  const { renameSpeaker } = speakerActions

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
      <LiveTranscript
        segments={segments}
        themLabel={meeting.themLabel}
        recording={recording}
        onRenameSpeaker={(speakerId, name) => void renameSpeaker(meeting.id, speakerId, name)}
      />
    </section>
  )

  const notes = (
    <section className="flex flex-col gap-2">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--color-text-dim)]">Notas</h3>
      <NotesEditor meetingId={meeting.id} initial={meeting.rawNotes} onSave={updateNotes} />
    </section>
  )

  const participants = <Participants meeting={meeting} recording={recording} actions={speakerActions} />

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
          {meeting.speakers.length === 0 && (
            <>
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
            </>
          )}
        </p>
        {meeting.status === 'error' && meeting.error && (
          <p className="text-xs text-[var(--color-danger)]">{meeting.error}</p>
        )}
      </header>

      <div className="flex flex-1 flex-col gap-6 overflow-y-auto px-6 py-4">
        {recording ? (
          <>
            {participants}
            {transcript}
            {notes}
          </>
        ) : (
          <>
            <SummaryView meeting={meeting} onResummarize={() => void resummarize(meeting.id)} />
            {participants}
            <ActionItemsList
              items={actionItems}
              onDecide={(id, action) =>
                void decideActionItems({
                  meetingId: meeting.id,
                  ids: [id],
                  action,
                })
              }
            />
            {notes}
            {transcript}
          </>
        )}
      </div>
    </div>
  )
}
