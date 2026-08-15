import {
  BarChart3,
  Blocks,
  CalendarClock,
  ClipboardList,
  FileText,
  Folder,
  Home,
  Inbox,
  ListTodo,
  Mic,
  Network,
  ScrollText,
  Settings,
  Target,
} from 'lucide-react'
import type { LucideProps } from 'lucide-react'
import type { ComponentType } from 'react'
import type { Area } from '@/store/appStore'
import { useAppStore } from '@/store/appStore'
import { Icon, ICON_SIZE_HEADER } from '@/components/ui/Icon'
import { ApexDot } from '@/features/brand'
import { useWaitingCount } from '@/features/session-switcher/useWaitingCount'

// Fundo do item ativo: gradiente da marca translúcido + anel inset accent.
const ACTIVE_TILE: React.CSSProperties = {
  background:
    'linear-gradient(150deg, color-mix(in srgb, var(--color-accent) 28%, transparent), color-mix(in srgb, var(--color-accent2) 10%, transparent))',
  boxShadow: 'inset 0 0 0 1px color-mix(in srgb, var(--color-accent) 40%, transparent)',
}

interface AreaDef {
  id: Area
  icon: ComponentType<LucideProps>
  label: string
}

const AREAS: AreaDef[] = [
  // Home primeiro: é a área default no boot.
  { id: 'overview', icon: Home, label: 'Home' },
  { id: 'projects', icon: Folder, label: 'Projetos' },
  { id: 'architecture', icon: Network, label: 'Arquitetura' },
  { id: 'handoffs', icon: Inbox, label: 'Handoffs' },
  { id: 'dossiers', icon: ScrollText, label: 'Dossiês' },
  { id: 'content', icon: FileText, label: 'Conteúdo' },
  { id: 'features', icon: ClipboardList, label: 'Features' },
  { id: 'objectives', icon: Target, label: 'Objetivos' },
  { id: 'tasks', icon: ListTodo, label: 'Tarefas' },
  { id: 'jobs', icon: CalendarClock, label: 'Jobs' },
  { id: 'meetings', icon: Mic, label: 'Reuniões' },
  { id: 'cc-configs', icon: Blocks, label: 'Configs do CC' },
  { id: 'metrics', icon: BarChart3, label: 'Métricas' },
]

interface Props {
  onOpenSettings: () => void
}

export function IconRail({ onOpenSettings }: Props) {
  const area = useAppStore((s) => s.area)
  const setArea = useAppStore((s) => s.setArea)
  const waitingCount = useWaitingCount()

  return (
    <nav className="flex h-full w-14 shrink-0 flex-col items-center justify-between border-r border-[var(--color-border)] bg-[var(--color-bg)] py-3">
      <ul className="flex flex-col items-center gap-1">
        {AREAS.map((a) => {
          const active = a.id === area
          return (
            <li key={a.id}>
              <button
                type="button"
                onClick={() => setArea(a.id)}
                title={
                  a.id === 'projects' && waitingCount > 0
                    ? `${a.label} · ${waitingCount} aguardando você`
                    : a.label
                }
                className={`relative flex h-[38px] w-[38px] items-center justify-center rounded-[11px] transition ${
                  active
                    ? 'text-[var(--color-text)]'
                    : 'text-[var(--color-text-dim)] hover:bg-[var(--color-surface-2)]/60 hover:text-[var(--color-text)]'
                }`}
                style={active ? ACTIVE_TILE : undefined}
              >
                <Icon as={a.icon} size={ICON_SIZE_HEADER} />
                {a.id === 'projects' && waitingCount > 0 && (
                  <ApexDot
                    size={7}
                    active
                    className="absolute right-[3px] top-[3px]"
                    color="var(--color-accent)"
                    title={`${waitingCount} aguardando você`}
                  />
                )}
              </button>
            </li>
          )
        })}
      </ul>

      <button
        type="button"
        onClick={onOpenSettings}
        title="Configurações"
        className="flex h-[38px] w-[38px] items-center justify-center rounded-[11px] text-[var(--color-text-dim)] transition hover:bg-[var(--color-surface-2)]/60 hover:text-[var(--color-text)]"
      >
        <Icon as={Settings} size={ICON_SIZE_HEADER} />
      </button>
    </nav>
  )
}
