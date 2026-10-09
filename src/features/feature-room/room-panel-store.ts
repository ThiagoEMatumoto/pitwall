import { create } from 'zustand'
import { useAppStore } from '@/store/appStore'
import { useProjectsViewStore } from '@/features/session-canvas/projects-view-store'

// A Room como painel lateral da área Projetos (à direita do dockview). Aberto e
// largura são preferência local do renderer, como o projects-view-store.
const PERSIST_KEY = 'cm:room-panel'

export const ROOM_PANEL_MIN = 280
export const ROOM_PANEL_MAX = 720
export const ROOM_PANEL_DEFAULT = 360

interface Persisted {
  open: boolean
  width: number
}

const DEFAULTS: Persisted = { open: false, width: ROOM_PANEL_DEFAULT }

export function clampRoomPanelWidth(w: number): number {
  if (!Number.isFinite(w)) return ROOM_PANEL_DEFAULT
  return Math.min(ROOM_PANEL_MAX, Math.max(ROOM_PANEL_MIN, Math.round(w)))
}

function readPersisted(): Persisted {
  try {
    const raw = localStorage.getItem(PERSIST_KEY)
    if (!raw) return DEFAULTS
    const parsed = JSON.parse(raw) as Partial<Persisted>
    return {
      open: parsed.open === true,
      width: clampRoomPanelWidth(Number(parsed.width ?? ROOM_PANEL_DEFAULT)),
    }
  } catch {
    return DEFAULTS
  }
}

function writePersisted(p: Persisted): void {
  try {
    localStorage.setItem(PERSIST_KEY, JSON.stringify(p))
  } catch {
    // localStorage indisponível — vale só nesta janela.
  }
}

// Pedido de foco vindo de fora (IconRail, Ctrl+`): o painel resolve a mãe no
// grafo e foca a pane dela. `seq` faz o mesmo pedido repetido valer de novo.
export interface RoomPanelFocus {
  featureId: string | null
  motherId: string | null
  seq: number
}

interface RoomPanelState extends Persisted {
  // Filtro da lista por feature (o Ctrl+` numa feature). null = todas as mães.
  featureFilter: string | null
  focus: RoomPanelFocus | null
  setOpen: (open: boolean) => void
  toggle: () => void
  setWidth: (width: number) => void
  setFeatureFilter: (featureId: string | null) => void
  show: (target?: { featureId?: string | null; motherId?: string | null }) => void
  consumeFocus: (seq: number) => void
}

export const useRoomPanelStore = create<RoomPanelState>((set, get) => ({
  ...readPersisted(),
  featureFilter: null,
  focus: null,
  setOpen: (open) => {
    writePersisted({ open, width: get().width })
    set({ open })
  },
  toggle: () => get().setOpen(!get().open),
  setWidth: (w) => {
    const width = clampRoomPanelWidth(w)
    writePersisted({ open: get().open, width })
    set({ width })
  },
  setFeatureFilter: (featureFilter) => set({ featureFilter }),
  // Destino padrão da Room: a visão de projeto (terminais) com o painel aberto.
  show: (target = {}) => {
    const featureId = target.featureId ?? null
    const motherId = target.motherId ?? null
    get().setOpen(true)
    set({
      featureFilter: featureId,
      focus:
        featureId || motherId ? { featureId, motherId, seq: (get().focus?.seq ?? 0) + 1 } : null,
    })
    useAppStore.getState().setArea('projects')
    useProjectsViewStore.getState().setView('terminals')
  },
  consumeFocus: (seq) => {
    if (get().focus?.seq === seq) set({ focus: null })
  },
}))
