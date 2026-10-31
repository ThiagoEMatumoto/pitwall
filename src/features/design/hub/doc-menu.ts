import type { MenuSection } from '@/components/ui/Menu'
import type { DesignFolder } from '@shared/types/design'

// "Mover para" as a Menu section: Sem pasta + every folder, current one checked.
export function moveSection(
  folders: DesignFolder[],
  current: string | null,
  onMove: (folderId: string | null) => void,
): MenuSection {
  return {
    title: 'Mover para',
    items: [
      { label: 'Sem pasta', active: current === null, onClick: () => onMove(null) },
      ...folders.map((f) => ({
        label: f.name,
        active: current === f.id,
        onClick: () => onMove(f.id),
      })),
    ],
  }
}
