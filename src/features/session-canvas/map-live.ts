import { createContext, useContext, useEffect, useState } from 'react'
import type { AttentionItem } from '@/features/session-switcher/attention-queue'

// O que muda no ritmo da atividade (não do layout): relógio pros "há 3m", quando
// cada sessão entrou em working e o item da fila de atenção de cada uma. Fora do
// `data` dos nós pelo mesmo motivo do MapActions — não invalidar o diff do xyflow.
export interface MapLive {
  now: number
  workingSince: ReadonlyMap<string, number | null>
  attention: ReadonlyMap<string, AttentionItem>
}

const EMPTY: MapLive = { now: Date.now(), workingSince: new Map(), attention: new Map() }

export const MapLiveContext = createContext<MapLive>(EMPTY)

export function useMapLive(): MapLive {
  return useContext(MapLiveContext)
}

// Um relógio só pro mapa inteiro: os rótulos "há Nm" não precisam de segundos.
export function useMinuteClock(stepMs = 15_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), stepMs)
    return () => clearInterval(timer)
  }, [stepMs])
  return now
}
