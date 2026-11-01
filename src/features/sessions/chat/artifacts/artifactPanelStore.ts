import { create } from 'zustand'
import type { ArtifactRef } from './artifact-refs'

// Painel "Ver ao lado" por sessão: qual artefato está aberto e se está visível.
// Lembra o último artefato de cada sessão entre reloads (preferência local do
// renderer, como o sidebar recolhido — não é estado de domínio).

export const PANEL_STORAGE_KEY = 'pitwall.artifact-panel.v1'
export const PANEL_MIN_WIDTH = 320
export const PANEL_DEFAULT_WIDTH = 460
// Deixa sempre uma coluna de conversa legível ao lado do painel.
export const CHAT_MIN_WIDTH = 360
const MAX_REMEMBERED_SESSIONS = 50

export interface PanelEntry {
  ref: ArtifactRef
  open: boolean
}

interface Persisted {
  width: number
  sessions: Record<string, PanelEntry>
}

interface ArtifactPanelState extends Persisted {
  show: (sessionId: string, ref: ArtifactRef) => void
  close: (sessionId: string) => void
  setWidth: (width: number) => void
}

function load(): Persisted {
  try {
    const raw = globalThis.localStorage?.getItem(PANEL_STORAGE_KEY)
    if (!raw) return { width: PANEL_DEFAULT_WIDTH, sessions: {} }
    const parsed = JSON.parse(raw) as Partial<Persisted>
    return {
      width: typeof parsed.width === 'number' ? parsed.width : PANEL_DEFAULT_WIDTH,
      sessions: parsed.sessions && typeof parsed.sessions === 'object' ? parsed.sessions : {},
    }
  } catch {
    return { width: PANEL_DEFAULT_WIDTH, sessions: {} }
  }
}

function save(state: Persisted): void {
  try {
    globalThis.localStorage?.setItem(
      PANEL_STORAGE_KEY,
      JSON.stringify({ width: state.width, sessions: state.sessions }),
    )
  } catch {
    // Storage cheio/bloqueado: o painel só não sobrevive ao reload.
  }
}

// Mais recente por último: aparar pelo começo descarta as sessões antigas.
function withEntry(
  sessions: Record<string, PanelEntry>,
  sessionId: string,
  entry: PanelEntry,
): Record<string, PanelEntry> {
  const { [sessionId]: _drop, ...rest } = sessions
  const keys = Object.keys(rest)
  const kept = keys.slice(Math.max(0, keys.length - (MAX_REMEMBERED_SESSIONS - 1)))
  return { ...Object.fromEntries(kept.map((k) => [k, rest[k]])), [sessionId]: entry }
}

export const useArtifactPanelStore = create<ArtifactPanelState>((set, get) => ({
  ...load(),
  show: (sessionId, ref) => {
    set((s) => ({ sessions: withEntry(s.sessions, sessionId, { ref, open: true }) }))
    save(get())
  },
  close: (sessionId) => {
    const entry = get().sessions[sessionId]
    if (!entry) return
    set((s) => ({ sessions: { ...s.sessions, [sessionId]: { ...entry, open: false } } }))
    save(get())
  },
  setWidth: (width) => {
    set({ width: Math.max(PANEL_MIN_WIDTH, Math.round(width)) })
    save(get())
  },
}))
