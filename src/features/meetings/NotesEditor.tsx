import { useEffect, useRef, useState } from 'react'

interface Props {
  meetingId: string
  initial: string
  onSave: (meetingId: string, rawNotes: string) => Promise<void>
}

const AUTOSAVE_MS = 800

type SaveState = 'idle' | 'dirty' | 'saving' | 'saved'

export function NotesEditor({ meetingId, initial, onSave }: Props) {
  const [text, setText] = useState(initial)
  const [saveState, setSaveState] = useState<SaveState>('idle')
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const latest = useRef(initial)

  // Só ressincroniza ao trocar de reunião — o valor vindo do store depois de um
  // save é o que o próprio editor mandou (ou mais velho que o texto atual).
  useEffect(() => {
    setText(initial)
    latest.current = initial
    setSaveState('idle')
  }, [meetingId])

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
  }, [])

  const onChange = (value: string) => {
    setText(value)
    latest.current = value
    setSaveState('dirty')
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      timer.current = null
      setSaveState('saving')
      void onSave(meetingId, latest.current).then(() => {
        setSaveState((s) => (s === 'saving' ? 'saved' : s))
      })
    }, AUTOSAVE_MS)
  }

  return (
    <div className="flex flex-col gap-1">
      <textarea
        value={text}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Suas anotações durante a reunião…"
        rows={6}
        className="w-full resize-y rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm leading-relaxed text-[var(--color-text)] outline-none placeholder:text-[var(--color-text-dim)]/70 focus:border-[var(--color-accent)]/60"
      />
      <span className="h-4 self-end text-[11px] text-[var(--color-text-dim)]">
        {saveState === 'saving' && 'Salvando…'}
        {saveState === 'saved' && 'Salvo'}
        {saveState === 'dirty' && 'Editando…'}
      </span>
    </div>
  )
}
