import { useEffect, useRef, useState } from 'react'
import type { MeetingSegment } from '../../../shared/types/ipc'
import { formatDuration } from './format'

interface Props {
  segments: MeetingSegment[]
  themLabel: string
  recording: boolean
}

const NEAR_BOTTOM_PX = 40

export function LiveTranscript({ segments, themLabel, recording }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [atBottom, setAtBottom] = useState(true)

  useEffect(() => {
    const el = scrollRef.current
    if (!el || !recording || !atBottom) return
    el.scrollTop = el.scrollHeight
  }, [segments.length, recording, atBottom])

  const onScroll = () => {
    const el = scrollRef.current
    if (!el) return
    setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX)
  }

  if (segments.length === 0) {
    return (
      <p className="px-1 py-4 text-sm text-[var(--color-text-dim)]">
        {recording ? 'Aguardando áudio…' : 'Sem transcrição'}
      </p>
    )
  }

  return (
    <div
      ref={scrollRef}
      onScroll={onScroll}
      className={`flex flex-col gap-2 overflow-y-auto pr-1 ${recording ? 'max-h-[60vh]' : 'max-h-[70vh]'}`}
    >
      {segments.map((seg) => {
        const me = seg.speaker === 'me'
        return (
          <div key={seg.id} className={`flex flex-col gap-0.5 ${me ? 'items-end' : 'items-start'}`}>
            <span className="px-1 text-[10px] uppercase tracking-wide text-[var(--color-text-dim)]">
              {me ? 'Eu' : themLabel} · <span className="tabular-nums">{formatDuration(seg.startMs)}</span>
            </span>
            <p
              className={`max-w-[80%] rounded-2xl px-3 py-1.5 text-sm leading-relaxed ${
                me
                  ? 'rounded-tr-sm bg-[color-mix(in_srgb,var(--color-accent)_22%,transparent)] text-[var(--color-text)]'
                  : 'rounded-tl-sm bg-[var(--color-surface-2)] text-[var(--color-text)]'
              }`}
            >
              {seg.text}
            </p>
          </div>
        )
      })}
    </div>
  )
}
