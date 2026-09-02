import type { MeetingStatus } from '../../../shared/types/ipc'

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const mm = String(m).padStart(2, '0')
  const ss = String(s).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}

const dateTime = new Intl.DateTimeFormat('pt-BR', {
  day: '2-digit',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
})

export function formatDateTime(ts: number): string {
  return dateTime.format(new Date(ts)).replace('.', '')
}

export const STATUS_LABEL: Record<MeetingStatus, string> = {
  recording: 'Gravando',
  processing: 'Processando',
  done: 'Concluída',
  error: 'Erro',
}

export const STATUS_COLOR: Record<MeetingStatus, string> = {
  recording: 'var(--color-danger)',
  processing: 'var(--color-warning)',
  done: 'var(--color-success)',
  error: 'var(--color-danger)',
}
