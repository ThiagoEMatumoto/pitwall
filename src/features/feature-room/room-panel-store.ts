import { create } from 'zustand'
import { useAppStore } from '@/store/appStore'
import { useProjectsViewStore } from '@/features/session-canvas/projects-view-store'

// A Room como painel lateral da área Projetos (à direita do dockview). Aberto e
// largura são preferência local do renderer, como o projects-view-store.
const PERSIST_KEY = 'cm:room-panel'

// Largura: 300 de padrão e 260 de mínimo. A 360 o painel tirava tanto do
// dockview que, com 3-4 panes lado a lado, cada uma caía para ~35 colunas; 260
// ainda cabe o tile (título, cauda de 2 linhas, composer) sem quebrar o cabeçalho.
export const ROOM_PANEL_MIN = 260
export const ROOM_PANEL_MAX = 720
export const ROOM_PANEL_DEFAULT = 300

// Modo compacto: com o dockview abaixo deste limiar (o espaço que ele TERIA com o
// painel cheio), o painel recolhe para uma faixa com a contagem e um ícone por
// mãe. O dockview é o trabalho; o painel é o radar — quem cede espaço é o radar.
// Decide pela largura do dockview, não por pane: é o que o painel controla.
export const ROOM_PANEL_COMPACT = 48
// Elemento do AppShell que hospeda o dockview: o painel mede ele.
export const DOCKVIEW_HOST_ID = 'dockview-host'
export const DOCKVIEW_MIN_WITH_PANEL = 720

// Pura (testável): compacta quando o dockview com o painel CHEIO ficaria abaixo do
// limiar. hostWidth é a largura atual do dockview — já sem o painel cheio quando
// compacto, por isso soma a diferença de volta; assim não oscila na fronteira.
export function shouldCompactRoomPanel(
  hostWidth: number,
  panelWidth: number,
  compact: boolean,
): boolean {
  const withFullPanel = compact ? hostWidth - (panelWidth - ROOM_PANEL_COMPACT) : hostWidth
  return withFullPanel < DOCKVIEW_MIN_WITH_PANEL
}

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
  // Derivado da largura do dockview (não persiste): ver shouldCompactRoomPanel.
  compact: boolean
  setCompact: (compact: boolean) => void
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
  compact: false,
  setCompact: (compact) => {
    if (get().compact !== compact) set({ compact })
  },
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

// Largura que o painel ocupa à direita de <main> agora (0 fora da visão de
// projeto ou fechado). Quem encosta na direita (toasts) recua por ela.
export function useRoomPanelInset(): number {
  const inProjects = useAppStore((s) => s.area === 'projects')
  const open = useRoomPanelStore((s) => s.open)
  const width = useRoomPanelStore((s) => s.width)
  const compact = useRoomPanelStore((s) => s.compact)
  if (!inProjects || !open) return 0
  return compact ? ROOM_PANEL_COMPACT : width
}
