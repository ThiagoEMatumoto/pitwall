import type { Feature, Task } from '../../../shared/types/ipc'

export const FEATURE_GROUP = 'Features'
export const TASK_GROUP = 'Tarefas'

// Centenas de features/tarefas: sem teto elas empurrariam sessões e comandos
// pra fora da tela já na 2ª letra.
export const ENTITY_GROUP_CAPS: Record<string, number> = {
  [FEATURE_GROUP]: 6,
  [TASK_GROUP]: 6,
}

// Só entram com busca digitada: na paleta vazia são ruído, e com 1 letra quase
// tudo casa.
export function showEntityResults(query: string): boolean {
  return query.trim().length >= 2
}

export function featureSearchText(f: Pick<Feature, 'title' | 'objective' | 'slug'>): string {
  return [f.title, f.slug, f.objective ?? ''].join(' ')
}

export function taskSearchText(t: Pick<Task, 'title' | 'tags'>): string {
  return [t.title, ...t.tags].join(' ')
}

// Concluída/cancelada não é algo que se procura pra agir.
export function searchableTasks<T extends Pick<Task, 'status'>>(tasks: T[]): T[] {
  return tasks.filter((t) => t.status !== 'done' && t.status !== 'cancelled')
}

// Feature cross-project não tem "um projeto dono" que a descreva: a paleta diz
// quantos repos e sessões ela junta. De um repo só, segue o nome do projeto.
export function featureHint(
  f: Pick<Feature, 'id' | 'projectId' | 'repos'>,
  projectName: ReadonlyMap<string, string>,
  sessionFeatureIds: readonly (string | null | undefined)[],
): string | undefined {
  const repos = f.repos?.length ?? 0
  if (repos <= 1) return projectName.get(f.projectId)
  const sessions = sessionFeatureIds.filter((id) => id === f.id).length
  const s = sessions === 1 ? '1 sessão' : `${sessions} sessões`
  return sessions > 0 ? `${repos} repos · ${s}` : `${repos} repos`
}
