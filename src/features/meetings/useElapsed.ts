import { useEffect, useState } from 'react'
import type { Meeting } from '../../../shared/types/ipc'

// Tempo de gravação que anda sozinho: o elapsedMs do main só chega em eventos
// de estado, então o relógio local preenche entre um e outro.
export function useElapsed(active: Meeting | null, reportedMs: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [active?.id])
  if (!active) return 0
  return Math.max(reportedMs, now - active.startedAt)
}
