import { useEffect } from 'react'
import { create } from 'zustand'
import { motherPinsApi } from '@/lib/ipc'
import { showToast } from '@/features/notifications/toast-store'
import { adoptRelaunchedSession, holdPaneForRelaunch } from '@/store/appStore'
import type { MotherPin, MotherRestartEvent } from '../../../shared/types/mother-pins'
import type { SessionGraphNode } from '../../../shared/types/session-graph'

// "Essa é a mãe": fonte única no main (mother_pins, por conversa). Substitui os
// pins da Room (localStorage) e o pin do MotherDock como papel; eles são
// importados uma vez e o flag abaixo impede reimportar o que o humano desmarcou.
const LEGACY_ROOM_KEY = 'pitwall.room.mother-pins'
const LEGACY_DOCK_KEY = 'cm:mother-dock'
const IMPORTED_FLAG = 'pitwall.mother-pins.imported'

export function readLegacyPins(storage: Pick<Storage, 'getItem'>): {
  keys: string[]
  sessionIds: string[]
} {
  const parse = (raw: string | null): unknown => {
    try {
      return raw ? JSON.parse(raw) : null
    } catch {
      return null
    }
  }
  const room = parse(storage.getItem(LEGACY_ROOM_KEY))
  const dock = parse(storage.getItem(LEGACY_DOCK_KEY)) as { pinnedId?: unknown } | null
  return {
    keys: Array.isArray(room) ? room.filter((x): x is string => typeof x === 'string' && !!x) : [],
    sessionIds: typeof dock?.pinnedId === 'string' && dock.pinnedId ? [dock.pinnedId] : [],
  }
}

async function importLegacyOnce(): Promise<MotherPin[] | null> {
  try {
    if (localStorage.getItem(IMPORTED_FLAG)) return null
    const legacy = readLegacyPins(localStorage)
    const pins =
      legacy.keys.length || legacy.sessionIds.length
        ? await motherPinsApi.importLegacy(legacy)
        : null
    localStorage.setItem(IMPORTED_FLAG, '1')
    return pins
  } catch {
    return null
  }
}

interface MotherPinsState {
  // Chaves de conversa, na ordem em que foram fixadas.
  keys: string[]
  loaded: boolean
  // Sessões (sessions.id) com relance "quando terminar o turno" agendado.
  restartPending: ReadonlySet<string>
  load: () => Promise<void>
  setPinned: (sessionId: string, pinned: boolean) => Promise<void>
  promote: (sessionId: string, restart: 'now' | 'when-idle') => Promise<void>
}

const toKeys = (pins: MotherPin[]) => pins.map((p) => p.key)

let subscribed = false

export const useMotherPinsStore = create<MotherPinsState>((set, get) => ({
  keys: [],
  loaded: false,
  restartPending: new Set(),

  load: async () => {
    try {
      if (!subscribed) {
        subscribed = true
        motherPinsApi.onUpdated((pins) => set({ keys: toKeys(pins), loaded: true }))
        motherPinsApi.onRestart((e) => onRestartEvent(e, set, get))
      }
      if (get().loaded) return
      const imported = await importLegacyOnce()
      const pins = imported ?? (await motherPinsApi.list())
      set({ keys: toKeys(pins), loaded: true })
    } catch (err) {
      // Sem pins carregados nada some: só a coroa fica desmarcada até o próximo push.
      console.error('[mother-pins] carga falhou:', err)
    }
  },

  setPinned: async (sessionId, pinned) => {
    try {
      set({ keys: toKeys(await motherPinsApi.set({ sessionId, pinned })) })
    } catch (err) {
      showToast({ title: 'Não foi possível marcar a mãe', body: errText(err) })
    }
  },

  promote: async (sessionId, restart) => {
    try {
      const r = await motherPinsApi.promote({ sessionId, restart })
      if (r.restart === 'scheduled') {
        showToast({
          title: 'Agora é mãe',
          body: 'Reinicia sem as travas de filha quando terminar o turno.',
          actionLabel: 'Reiniciar agora',
          onAction: () => void motherPinsApi.restartNow(sessionId),
          durationMs: 10_000,
        })
      } else if (r.restart === 'restarting') {
        showToast({ title: 'Agora é mãe', body: 'Reiniciando sem as travas de filha…' })
      } else {
        showToast({ title: 'Agora é mãe', body: 'Solta da mãe anterior e fixada como mãe.' })
      }
    } catch (err) {
      showToast({ title: 'Não foi possível tornar mãe', body: errText(err) })
    }
  },
}))

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function onRestartEvent(
  e: MotherRestartEvent,
  set: (p: Partial<MotherPinsState>) => void,
  get: () => MotherPinsState,
): void {
  const pending = new Set(get().restartPending)
  if (e.state === 'scheduled') pending.add(e.sessionId)
  else pending.delete(e.sessionId)
  set({ restartPending: pending })
  if (e.state === 'relaunching' && e.ccSessionId) holdPaneForRelaunch(e.sessionId, e.ccSessionId)
  if (e.state === 'restarted' && e.session) adoptRelaunchedSession(e.session)
  if (e.state === 'restarted') showToast({ title: 'Mãe reiniciada sem as travas de filha' })
  if (e.state === 'failed')
    showToast({ title: 'Não foi possível reiniciar a mãe', body: e.error ?? '' })
}

export function pinKeyOfNode(node: Pick<SessionGraphNode, 'sessionId' | 'ccSessionId'>): string {
  return node.ccSessionId ?? node.sessionId
}

export function useMotherPinKeys(): string[] {
  const load = useMotherPinsStore((s) => s.load)
  useEffect(() => {
    void load()
  }, [load])
  return useMotherPinsStore((s) => s.keys)
}
