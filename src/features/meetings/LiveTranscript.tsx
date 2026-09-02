import { useEffect, useMemo, useRef, useState } from 'react'
import type { MeetingSegment } from '../../../shared/types/ipc'
import { formatDuration } from './format'
import { SpeakerName, speakerColor } from './SpeakerName'

interface Props {
  segments: MeetingSegment[]
  themLabel: string
  recording: boolean
  onRenameSpeaker?: (speakerId: string, name: string) => void
}

const NEAR_BOTTOM_PX = 40

function colorIndexBySpeaker(segments: MeetingSegment[]): Map<string, number> {
  const order = new Map<string, number>()
  for (const seg of segments) {
    if (seg.speakerId && !order.has(seg.speakerId)) order.set(seg.speakerId, order.size)
  }
  return order
}

export function LiveTranscript({ segments, themLabel, recording, onRenameSpeaker }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [atBottom, setAtBottom] = useState(true)
  const colorIndex = useMemo(() => colorIndexBySpeaker(segments), [segments])

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
        const color = me
          ? 'var(--color-accent)'
          : seg.speakerId
            ? speakerColor(colorIndex.get(seg.speakerId) ?? 0)
            : undefined
        const label = me ? 'Eu' : seg.speakerLabel || themLabel
        const rename = !me && seg.speakerId && onRenameSpeaker ? onRenameSpeaker : undefined
        const speakerId = seg.speakerId
        return (
          <div key={seg.id} className={`flex flex-col gap-0.5 ${me ? 'items-end' : 'items-start'}`}>
            <span className="px-1 text-[10px] uppercase tracking-wide text-[var(--color-text-dim)]">
              <SpeakerName
                label={label}
                color={color}
                onRename={rename && speakerId ? (name) => rename(speakerId, name) : undefined}
              />{' '}
              · <span className="tabular-nums">{formatDuration(seg.startMs)}</span>
            </span>
            <p
              className={`max-w-[80%] rounded-2xl px-3 py-1.5 text-sm leading-relaxed text-[var(--color-text)] ${
                me ? 'rounded-tr-sm' : 'rounded-tl-sm'
              }`}
              style={{
                background: color
                  ? `color-mix(in srgb, ${color} ${me ? 22 : 14}%, transparent)`
                  : 'var(--color-surface-2)',
              }}
            >
              {seg.text}
            </p>
          </div>
        )
      })}
    </div>
  )
}
