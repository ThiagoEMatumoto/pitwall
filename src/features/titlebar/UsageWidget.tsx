import { useEffect, useState } from 'react'
import { usageApi } from '@/lib/ipc'
import { MeasureBlocks } from '@/features/brand'
import type { UsageStatus, UsageWindow } from '../../../shared/types/ipc'

function formatCountdown(resetsAt: string): string {
  const ms = new Date(resetsAt).getTime() - Date.now()
  if (!Number.isFinite(ms) || ms <= 0) return 'agora'
  const mins = Math.floor(ms / 60_000)
  const days = Math.floor(mins / (60 * 24))
  const hours = Math.floor((mins % (60 * 24)) / 60)
  const rem = mins % 60
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${rem}m`
  return `${rem}m`
}

function Indicator({
  label,
  window,
  stale,
}: {
  label: string
  window: UsageWindow
  stale?: boolean
}) {
  const util = Math.max(0, Math.min(100, window.utilization))
  return (
    <div
      className="flex items-center gap-1.5"
      style={{ opacity: stale ? 0.55 : 1 }}
      title={`${label}: ${util.toFixed(0)}% • reseta em ${formatCountdown(window.resetsAt)}${
        stale ? ' • desatualizado' : ''
      }`}
    >
      <MeasureBlocks
        className="text-[10px]"
        percent={util}
        label={label}
        value={`${util.toFixed(0)}%`}
      />
      <span
        className="font-mono text-[10px] tabular-nums"
        style={{ color: 'var(--color-text-dim)', opacity: 0.7 }}
        aria-label={`reseta em ${formatCountdown(window.resetsAt)}`}
      >
        ↻ {formatCountdown(window.resetsAt)}
      </span>
    </div>
  )
}

function Note({ text }: { text: string }) {
  return (
    <span className="text-[10px]" style={{ color: 'var(--color-text-dim)' }}>
      {text}
    </span>
  )
}

export function UsageWidget() {
  const [status, setStatus] = useState<UsageStatus | null>(null)
  // Tick puramente pra re-renderizar e manter o countdown de reset vivo entre os
  // polls do status (que só chegam a cada ~60s). 30s = granularidade de minutos ok.
  const [, setTick] = useState(0)

  useEffect(() => {
    const unsub = usageApi.onStatus(setStatus)
    // get() reusa o cache do main (que já faz poll de 60s). No foco confiamos no
    // poll do main em vez de forçar fetch — forçar a cada foco estourava o rate
    // limit do endpoint.
    void usageApi.get().then(setStatus)
    const tick = setInterval(() => setTick((t) => t + 1), 30_000)
    return () => {
      unsub()
      clearInterval(tick)
    }
  }, [])

  if (!status) return <Note text="—" />

  if (status.state === 'no-token' || status.state === 'unauthorized') {
    return <Note text="entre no Claude Code" />
  }

  const hasData = status.fiveHour || status.sevenDay
  if (!hasData) {
    return <Note text="indisponível" />
  }

  return (
    <div className="flex items-center gap-3">
      {status.fiveHour && <Indicator label="5h" window={status.fiveHour} stale={status.stale} />}
      {status.sevenDay && <Indicator label="7d" window={status.sevenDay} stale={status.stale} />}
    </div>
  )
}
