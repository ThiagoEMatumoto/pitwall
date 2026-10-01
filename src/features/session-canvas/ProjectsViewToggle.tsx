import { useEffect } from 'react'
import { Network, SquareTerminal } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import { formatCombo, matchCombo, resolveCombo } from '@/lib/keybindings'
import { useKeybindingsStore } from '@/lib/keybindings-store'
import { useAppStore } from '@/store/appStore'
import { useProjectsViewStore, type ProjectsView } from './projects-view-store'

const OPTIONS: Array<{ view: ProjectsView; label: string; icon: typeof Network }> = [
  { view: 'map', label: 'Mapa', icon: Network },
  { view: 'terminals', label: 'Terminais', icon: SquareTerminal },
]

// Alternador Mapa ⇄ Terminais no topo da área Projetos. Dono do próprio atalho
// (projects.toggleMap): só reage com a área Projetos na frente.
export function ProjectsViewToggle() {
  const view = useProjectsViewStore((s) => s.view)
  const setView = useProjectsViewStore((s) => s.setView)
  const overrides = useKeybindingsStore((s) => s.overrides)
  const combo = resolveCombo('projects.toggleMap', overrides)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (useAppStore.getState().area !== 'projects' || !matchCombo(e, combo)) return
      e.preventDefault()
      e.stopPropagation()
      useProjectsViewStore.getState().toggleView()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [combo])

  return (
    <div
      role="group"
      aria-label="Vista da área Projetos"
      title={`Alternar vista (${formatCombo(combo)})`}
      className="m-1 flex shrink-0 items-center gap-0.5 rounded-md border border-[var(--color-border)] p-0.5 text-[11px]"
    >
      {OPTIONS.map((o) => (
        <button
          key={o.view}
          type="button"
          aria-pressed={view === o.view}
          data-testid={`projects-view-${o.view}`}
          onClick={() => setView(o.view)}
          className={`flex items-center gap-1 rounded px-1.5 py-0.5 transition ${
            view === o.view
              ? 'bg-[var(--color-surface-2)] text-[var(--color-text)]'
              : 'text-[var(--color-text-dim)] hover:text-[var(--color-text)]'
          }`}
        >
          <Icon as={o.icon} size={12} />
          {o.label}
        </button>
      ))}
    </div>
  )
}
