import { ipcMain } from 'electron'
import { z } from 'zod'
import { broadcast, onBroadcast } from '../services/notify'
import { roomSnapshot } from '../services/feature-room-service'
import type { RoomSnapshot } from '../../../shared/types/feature-room'

// O que muda a Room: handoffs (timeline, wakes), a feature (título, OKR) e o loop
// (pulso, liveness). NUNCA 'room:' — o próprio push se realimentaria.
const ROOM_CHANNEL_PREFIXES = ['handoff:', 'feature:updated', 'loop:updated'] as const
export const ROOM_PUSH_DELAY_MS = 300

// Mesmo coalescing de watchAttention: o 1º evento arma, os seguintes pegam carona.
export function watchRoom(push: () => void, delayMs = ROOM_PUSH_DELAY_MS): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null
  const schedule = () => {
    if (timer) return
    timer = setTimeout(() => {
      timer = null
      push()
    }, delayMs)
  }
  const offs = ROOM_CHANNEL_PREFIXES.map((prefix) => onBroadcast(prefix, schedule))
  return () => {
    for (const off of offs) off()
    if (timer) clearTimeout(timer)
    timer = null
  }
}

export function registerFeatureRoomIpc(): void {
  ipcMain.handle('room:get', (_e, raw: unknown): RoomSnapshot | null =>
    roomSnapshot(z.string().min(1).parse(raw)),
  )
  // Payload pequeno: o renderer refaz o get da Room aberta.
  watchRoom(() => broadcast('room:changed', { featureId: null }))
}
