import {
  AudioLines,
  BarChart3,
  Blocks,
  Clapperboard,
  DoorOpen,
  ClipboardList,
  Folder,
  Home,
  Inbox,
  ListTodo,
  Network,
  PenTool,
  Settings,
  Target,
  Workflow,
} from 'lucide-react'
import type { LucideProps } from 'lucide-react'
import type { ComponentType } from 'react'
import type { Area } from '@/store/appStore'
import { useAppStore } from '@/store/appStore'
import { Icon, ICON_SIZE_HEADER } from '@/components/ui/Icon'
import { ApexDot } from '@/features/brand'
import { useWaitingCount } from '@/features/session-switcher/useWaitingCount'
import { attentionCount } from '@/features/session-switcher/attention-queue'
import { useAttentionQueue } from '@/features/session-switcher/useAttentionQueue'
import { openRoomFromNav } from '@/features/feature-room/open-room-entry'

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
  { id: 'room', icon: DoorOpen, label: 'Room' },
  { id: 'meetings', icon: AudioLines, label: 'Reuniões' },
  { id: 'projects', icon: Folder, label: 'Projetos' },
  { id: 'architecture', icon: Network, label: 'Arquitetura' },
  { id: 'diagrams', icon: Workflow, label: 'Diagramas' },
  { id: 'design', icon: PenTool, label: 'Design' },
  { id: 'videos', icon: Clapperboard, label: 'Vídeos' },
  { id: 'handoffs', icon: Inbox, label: 'Handoffs' },
  { id: 'features', icon: ClipboardList, label: 'Features' },
  { id: 'objectives', icon: Target, label: 'Objetivos' },
  { id: 'tasks', icon: ListTodo, label: 'Tarefas' },
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
  // O mesmo "N no box" da TitleBar (a fila do Alt+A inteira): a Room é onde ele se resolve.
  const needsYou = attentionCount(useAttentionQueue())

  return (
    <nav className="flex h-full w-14 shrink-0 flex-col items-center justify-between border-r border-[var(--color-border)] bg-[var(--color-bg)] py-3">
      <ul className="flex flex-col items-center gap-1">
        {AREAS.map((a) => {
          const active = a.id === area
          const label =
            a.id === 'projects' && waitingCount > 0
              ? `${a.label} · ${waitingCount} aguardando você`
              : a.id === 'room' && needsYou > 0
                ? `${a.label} · ${needsYou} precisa de você`
                : a.label
          return (
            <li key={a.id}>
              <button
                type="button"
                data-testid={`rail-${a.id}`}
                onClick={() => (a.id === 'room' ? openRoomFromNav() : setArea(a.id))}
                title={label}
                // Sem isto, o texto do badge vira o nome do botão e o "Room" some.
                aria-label={label}
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
                {a.id === 'room' && needsYou > 0 && (
                  <span
                    data-testid="rail-room-badge"
                    aria-hidden="true"
                    className="absolute right-[1px] top-[1px] min-w-[15px] rounded-full bg-[var(--color-accent)] px-1 text-center text-[9px] font-semibold leading-[15px] text-[var(--color-bg)] tabular-nums"
                  >
                    {needsYou}
                  </span>
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
