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
  // Último rawNotes do servidor que este editor já incorporou. É a base pra
  // distinguir "eu mandei isso" de "chegou nota rápida pela flutuante".
  const syncedRef = useRef(initial)

  useEffect(() => {
    setText(initial)
    latest.current = initial
    syncedRef.current = initial
    setSaveState('idle')
  }, [meetingId])

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
  }, [])

  const scheduleSave = () => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      timer.current = null
      setSaveState('saving')
      const sent = latest.current
      // Marca sincronizado ANTES do round-trip: o eco do próprio save via
      // broadcast pode chegar (e re-renderizar com `initial`) antes deste
      // .then() rodar, e o efeito abaixo confundiria o próprio save com uma
      // mudança externa, duplicando o texto (self-echo loop).
      syncedRef.current = sent
      void onSave(meetingId, sent).then(() => {
        setSaveState((s) => (s === 'saving' ? 'saved' : s))
      })
    }, AUTOSAVE_MS)
  }

  // Servidor mudou por fora (nota rápida da flutuante): sem edição local,
  // adota; com edição local e o servidor só anexou, anexa o mesmo trecho aqui
  // e reagenda o save; se divergiu de verdade, o texto local vence.
  useEffect(() => {
    const server = initial
    const synced = syncedRef.current
    if (server === synced) return
    const local = latest.current
    if (local === synced) {
      setText(server)
      latest.current = server
    } else if (server.startsWith(synced)) {
      const merged = local + server.slice(synced.length)
      setText(merged)
      latest.current = merged
      setSaveState('dirty')
      scheduleSave()
    } else {
      return
    }
    syncedRef.current = server
  }, [initial])

  const onChange = (value: string) => {
    setText(value)
    latest.current = value
    setSaveState('dirty')
    scheduleSave()
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
