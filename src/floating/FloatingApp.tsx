import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from 'react'
import { Button } from '@/components/ui/Button'
import { meetingsApi } from '@/lib/ipc'
import type { Meeting, MeetingLiveState, MeetingSegment } from '@shared/types/meetings'

const MAX_SEGMENTS = 8

const IDLE_STATE: MeetingLiveState = {
  active: null,
  elapsedMs: 0,
  levels: { me: 0, them: 0 },
  sttOk: false,
  lastError: null,
  captureMode: 'pipewire',
}

export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

const dragStyle = { WebkitAppRegion: 'drag' } as CSSProperties
const noDragStyle = { WebkitAppRegion: 'no-drag' } as CSSProperties

function Level({ label, value }: { label: string; value: number }) {
  const pct = Math.round(Math.min(1, Math.max(0, value)) * 100)
  return (
    <div className="flex items-center gap-2">
      <span className="w-[5.5rem] shrink-0 truncate text-[11px] text-[var(--color-text-dim)]">
        {label}
      </span>
      <div className="h-1 flex-1 overflow-hidden rounded-full bg-[var(--color-surface-2)]">
        <div
          className="h-full rounded-full bg-[var(--color-accent)] transition-[width] duration-100"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  )
}

function Bubble({ segment, themLabel }: { segment: MeetingSegment; themLabel: string }) {
  const me = segment.speaker === 'me'
  return (
    <div className={`flex ${me ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[88%] rounded-xl px-2.5 py-1.5 text-[13px] leading-snug break-words ${
          me
            ? 'bg-[color-mix(in_srgb,var(--color-accent)_22%,transparent)] text-[var(--color-text)]'
            : 'bg-[var(--color-surface-2)] text-[var(--color-text)]'
        }`}
      >
        <div className="mb-0.5 text-[10px] text-[var(--color-text-dim)]">
          {me ? 'Eu' : themLabel} · {formatClock(segment.startMs)}
        </div>
        {segment.text}
      </div>
    </div>
  )
}

export function FloatingApp() {
  const [state, setState] = useState<MeetingLiveState>(IDLE_STATE)
  const [segments, setSegments] = useState<MeetingSegment[]>([])
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [clock, setClock] = useState('00:00')
  const [error, setError] = useState<string | null>(null)
  const activeIdRef = useRef<string | null>(null)
  const anchorRef = useRef<number | null>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const active = state.active
  const themLabel = active?.themLabel ?? 'Participante'

  const adoptMeeting = useCallback((meeting: Meeting | null) => {
    if (!meeting) {
      activeIdRef.current = null
      return
    }
    if (activeIdRef.current !== meeting.id) {
      activeIdRef.current = meeting.id
      setSegments([])
      meetingsApi
        .get(meeting.id)
        .then((detail) => setSegments(detail.segments.slice(-MAX_SEGMENTS)))
        .catch(() => {})
    }
  }, [])

  const applyState = useCallback(
    (next: MeetingLiveState) => {
      setState(next)
      anchorRef.current = next.active ? Date.now() - next.elapsedMs : null
      setClock(formatClock(next.elapsedMs))
      adoptMeeting(next.active)
    },
    [adoptMeeting],
  )

  useEffect(() => {
    meetingsApi
      .state()
      .then(applyState)
      .catch((err) => setError(String(err)))
    return meetingsApi.onEvent((event) => {
      if (event.type === 'state') applyState(event.state)
      else if (event.type === 'segment') {
        if (event.segment.meetingId !== activeIdRef.current) return
        setSegments((prev) => [...prev, event.segment].slice(-MAX_SEGMENTS))
      }
    })
  }, [applyState])

  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => {
      if (anchorRef.current !== null) setClock(formatClock(Date.now() - anchorRef.current))
    }, 1000)
    return () => clearInterval(timer)
  }, [active])

  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [segments])

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    setError(null)
    try {
      await fn()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const addNote = () => {
    const id = activeIdRef.current
    const text = note.trim()
    if (!id || !text) return
    setNote('')
    // O main anexa "- [mm:ss] texto" — a base nunca vive aqui, então não há
    // como clobberar o que o editor da janela principal está digitando.
    void run(() => meetingsApi.quickNote(id, text))
  }

  const onNoteKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      addNote()
    }
  }

  return (
    <div className="flex h-full flex-col overflow-hidden text-[13px]">
      <header
        style={dragStyle}
        className="flex select-none items-center gap-2 border-b border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2"
      >
        {active ? (
          <>
            <span
              aria-hidden
              className="h-2.5 w-2.5 shrink-0 animate-pulse rounded-full bg-[var(--color-danger)]"
            />
            <span className="tabular-nums font-medium">Gravando {clock}</span>
          </>
        ) : (
          <>
            <span
              aria-hidden
              className="h-2.5 w-2.5 shrink-0 rounded-full bg-[var(--color-text-dim)]"
            />
            <span className="text-[var(--color-text-dim)]">Sem gravação</span>
          </>
        )}
        <span className="flex-1" />
        {active ? (
          <Button
            variant="danger"
            style={noDragStyle}
            className="px-3 py-0.5 text-xs"
            disabled={busy}
            onClick={() => void run(() => meetingsApi.stop())}
          >
            Parar
          </Button>
        ) : (
          <Button
            style={noDragStyle}
            className="px-3 py-0.5 text-xs"
            disabled={busy}
            onClick={() => void run(() => meetingsApi.start())}
          >
            Iniciar
          </Button>
        )}
        <button
          type="button"
          aria-label="Ocultar"
          style={noDragStyle}
          className="ml-1 rounded px-1.5 text-base leading-none text-[var(--color-text-dim)] hover:text-[var(--color-text)]"
          onClick={() => void meetingsApi.floating('hide')}
        >
          ×
        </button>
      </header>

      <div className="flex flex-col gap-1 border-b border-[var(--color-border)] px-3 py-2">
        <Level label="Eu" value={state.levels.me} />
        <Level label={themLabel} value={state.levels.them} />
      </div>

      {error && (
        <div className="border-b border-[var(--color-border)] px-3 py-1.5 text-xs text-[var(--color-danger)]">
          {error}
        </div>
      )}
      {active && !state.sttOk && state.lastError && (
        <div className="border-b border-[var(--color-border)] px-3 py-1.5 text-xs text-[var(--color-warning)]">
          Transcrição indisponível: {state.lastError}
        </div>
      )}

      <div ref={listRef} className="flex flex-1 flex-col gap-1.5 overflow-y-auto px-3 py-2">
        {segments.length === 0 ? (
          <div className="m-auto text-center text-xs text-[var(--color-text-dim)]">
            {active ? 'Aguardando fala…' : 'Inicie uma gravação para ver a transcrição.'}
          </div>
        ) : (
          segments.map((s) => <Bubble key={s.id} segment={s} themLabel={themLabel} />)
        )}
      </div>

      <div className="flex items-end gap-2 border-t border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2">
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          onKeyDown={onNoteKeyDown}
          disabled={!active}
          rows={2}
          placeholder={active ? 'Nota rápida (Enter envia)' : 'Nota rápida'}
          className="flex-1 resize-none rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-[13px] outline-none focus:border-[var(--color-accent)] disabled:opacity-50"
        />
        <Button
          variant="ghost"
          className="px-3 py-1 text-xs"
          disabled={!active || busy || !note.trim()}
          onClick={addNote}
        >
          Adicionar
        </Button>
      </div>
    </div>
  )
}
