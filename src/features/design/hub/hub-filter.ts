import type { DesignDocumentMeta, DesignFolder } from '@shared/types/design'
import type { HubSection, HubSort } from '@/store/designStore'

// Case- and accent-insensitive ("landing" finds "Lânding").
export function normalize(text: string): string {
  return text.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().trim()
}

export function sectionDocs(
  section: HubSection,
  docs: DesignDocumentMeta[],
  archivedDocs: DesignDocumentMeta[],
): DesignDocumentMeta[] {
  if (section === 'archived') return archivedDocs
  if (section === 'recent') return docs
  if (section === 'unfiled') return docs.filter((d) => d.folderId === null)
  return docs.filter((d) => d.folderId === section)
}

export function visibleDocs(
  list: DesignDocumentMeta[],
  query: string,
  sort: HubSort,
): DesignDocumentMeta[] {
  const q = normalize(query)
  const filtered = q ? list.filter((d) => normalize(d.title).includes(q)) : list
  return [...filtered].sort((a, b) =>
    sort === 'name'
      ? a.title.localeCompare(b.title, 'pt-BR', { sensitivity: 'base' })
      : b.updatedAt - a.updatedAt,
  )
}

export function sectionTitle(section: HubSection, folders: DesignFolder[]): string {
  if (section === 'recent') return 'Recentes'
  if (section === 'unfiled') return 'Sem pasta'
  if (section === 'archived') return 'Arquivados'
  return folders.find((f) => f.id === section)?.name ?? 'Pasta'
}

// Drop targets of the hub sidebar. '' stands for "Sem pasta".
const DROP_PREFIX = 'drop:'
export const dropId = (folderId: string | null) => `${DROP_PREFIX}${folderId ?? ''}`

// undefined = not a folder target (released elsewhere).
export function parseDropId(id: string | number | undefined): string | null | undefined {
  if (typeof id !== 'string' || !id.startsWith(DROP_PREFIX)) return undefined
  return id.slice(DROP_PREFIX.length) || null
}
