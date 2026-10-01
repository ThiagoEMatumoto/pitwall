import { create } from 'zustand'

// Área Projetos: Terminais (dockview) ⇄ Mapa de sessões. Preferência local do
// renderer (mesmo padrão do crew-dock-store): lembra a última vista e o filtro de
// escopo do mapa entre aberturas do app.
const PERSIST_KEY = 'cm:projects-view'

export type ProjectsView = 'terminals' | 'map'
// 'all' = todos os projetos; 'project' = o projeto selecionado na sidebar.
export type MapScopeMode = 'all' | 'project'

interface Persisted {
  view: ProjectsView
  scopeMode: MapScopeMode
}

const DEFAULTS: Persisted = { view: 'terminals', scopeMode: 'all' }

function readPersisted(): Persisted {
  try {
    const raw = localStorage.getItem(PERSIST_KEY)
    if (!raw) return DEFAULTS
    const parsed = JSON.parse(raw) as Partial<Persisted>
    return {
      view: parsed.view === 'map' ? 'map' : 'terminals',
      scopeMode: parsed.scopeMode === 'project' ? 'project' : 'all',
    }
  } catch {
    return DEFAULTS
  }
}

function writePersisted(p: Persisted): void {
  try {
    localStorage.setItem(PERSIST_KEY, JSON.stringify(p))
  } catch {
    // localStorage indisponível — a escolha vale só nesta janela.
  }
}

const pick = (s: Persisted): Persisted => ({ view: s.view, scopeMode: s.scopeMode })

interface ProjectsViewState extends Persisted {
  setView: (view: ProjectsView) => void
  toggleView: () => void
  setScopeMode: (mode: MapScopeMode) => void
}

export const useProjectsViewStore = create<ProjectsViewState>((set, get) => ({
  ...readPersisted(),
  setView: (view) => {
    writePersisted({ ...pick(get()), view })
    set({ view })
  },
  toggleView: () => get().setView(get().view === 'map' ? 'terminals' : 'map'),
  setScopeMode: (scopeMode) => {
    writePersisted({ ...pick(get()), scopeMode })
    set({ scopeMode })
  },
}))
