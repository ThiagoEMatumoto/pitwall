import { useEffect, type CSSProperties } from 'react'
import { navigateToMeeting } from '@/lib/nav'
import { useMeetingsStore } from '@/store/meetingsStore'
import { pendingDetection } from './DetectionBanner'
import { formatDuration } from './format'
import { useElapsed } from './useElapsed'

const noDrag = { WebkitAppRegion: 'no-drag' } as CSSProperties

// Indicador global na barra superior: existe pra que uma gravação esquecida
// em outra área nunca fique invisível. Dono da assinatura de eventos do
// meetingsStore pela vida do app (a área de Reuniões só a inicia).
export function RecordingPill() {
  const live = useMeetingsStore((s) => s.live)
  const loadLive = useMeetingsStore((s) => s.loadLive)
  const startEventWatch = useMeetingsStore((s) => s.startEventWatch)
  const stopEventWatch = useMeetingsStore((s) => s.stopEventWatch)
  const decideDetection = useMeetingsStore((s) => s.decideDetection)

  useEffect(() => {
    void loadLive()
    startEventWatch()
    return () => stopEventWatch()
  }, [loadLive, startEventWatch, stopEventWatch])

  const active = live?.active ?? null
  const elapsedMs = useElapsed(active, live?.elapsedMs ?? 0)
  const detection = pendingDetection(live)

  if (!active && detection) {
    return (
      <button
        type="button"
        style={{
          ...noDrag,
          background: 'color-mix(in srgb, var(--color-warning) 14%, transparent)',
          color: 'var(--color-warning)',
        }}
        className="flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[10px] font-medium leading-none hover:brightness-110"
        title={`${detection.app} está usando o microfone`}
        onClick={() => void decideDetection('record')}
      >
        <span aria-hidden className="h-1.5 w-1.5 rounded-full" style={{ background: 'var(--color-warning)' }} />
        <span>Reunião detectada · Gravar</span>
      </button>
    )
  }

  if (!active) return null

  return (
    <button
      type="button"
      style={{
        ...noDrag,
        background: 'color-mix(in srgb, var(--color-danger) 14%, transparent)',
        color: 'var(--color-danger)',
      }}
      className="flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[10px] font-medium leading-none hover:brightness-110"
      title="Clique para abrir · Ctrl+Shift+R para parar"
      onClick={() => navigateToMeeting(active.id)}
    >
      <span
        aria-hidden
        className="h-1.5 w-1.5 animate-pulse rounded-full"
        style={{ background: 'var(--color-danger)' }}
      />
      <span className="tabular-nums">Gravando {formatDuration(elapsedMs)}</span>
    </button>
  )
}
