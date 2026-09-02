// Renderização do transcript pros prompts de resumo e extração: uma linha por
// segmento, `[mm:ss] Eu|<themLabel>: texto`. Compartilhado pra que o trecho que
// o modelo cita na extração seja exatamente o texto que ele viu.
import type { MeetingSegment } from '../../../../shared/types/meetings'

export function mmss(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

export function speakerLabel(speaker: MeetingSegment['speaker'], themLabel: string): string {
  return speaker === 'me' ? 'Eu' : themLabel
}

export function renderTranscript(segments: MeetingSegment[], themLabel: string): string {
  return segments
    .map((seg) => `[${mmss(seg.startMs)}] ${speakerLabel(seg.speaker, themLabel)}: ${seg.text.trim()}`)
    .join('\n')
}

export function formatMeetingDate(startedAt: number): string {
  return new Date(startedAt).toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function hasContent(segments: MeetingSegment[], rawNotes: string): boolean {
  return segments.length > 0 || rawNotes.trim().length > 0
}
