// Autoria de artefatos: um diagrama ou design escrito por uma sessão fica
// ligado a ela (e ao handoff, se ela for filha), para o chat achar os artefatos
// que a sessão criou e o editor achar a sessão que o está escrevendo. O id vem
// do carimbo do app (ctx.motherSessionId), nunca do modelo.

import * as diagramStore from '../diagram-store'
import * as designStore from '../design/design-store'
import * as handoffStore from '../handoff-store'
import type { McpNotify, McpRequestContext } from './tools'

export interface AuthorParent {
  parentType: 'session' | 'handoff'
  parentId: string
}

export function authorParents(ctx: McpRequestContext): AuthorParent[] {
  const sessionId = ctx.motherSessionId
  if (!sessionId) return []
  const parents: AuthorParent[] = [{ parentType: 'session', parentId: sessionId }]
  const handoff = handoffStore.getByChildSession(sessionId)
  if (handoff) parents.push({ parentType: 'handoff', parentId: handoff.id })
  return parents
}

// Links do create + os de autoria, sem duplicar o que o modelo já mandou.
export function withAuthorLinks<T extends { parentType: string; parentId: string }>(
  links: T[] | undefined,
  ctx: McpRequestContext,
): Array<T | AuthorParent> {
  const merged: Array<T | AuthorParent> = [...(links ?? [])]
  for (const parent of authorParents(ctx)) {
    if (!merged.some((l) => sameParent(l, parent))) merged.push(parent)
  }
  return merged
}

function sameParent(a: { parentType: string; parentId: string }, b: AuthorParent): boolean {
  return a.parentType === b.parentType && a.parentId === b.parentId
}

export function recordDiagramAuthorship(
  notify: McpNotify,
  ctx: McpRequestContext,
  diagramId: string,
): void {
  const parents = authorParents(ctx)
  if (parents.length === 0) return
  const existing = diagramStore.listLinks(diagramId)
  const missing = parents.filter((p) => !existing.some((l) => sameParent(l, p)))
  if (missing.length === 0) return
  let links = existing
  for (const p of missing) links = diagramStore.link({ diagramId, ...p })
  notify.broadcast('diagramLinks:updated', { diagramId, links })
}

export function recordDesignAuthorship(
  notify: McpNotify,
  ctx: McpRequestContext,
  documentId: string,
): void {
  const parents = authorParents(ctx)
  if (parents.length === 0) return
  if (!designStore.getDocumentMeta(documentId)) return
  const existing = designStore.listLinks(documentId)
  const missing = parents.filter((p) => !existing.some((l) => sameParent(l, p)))
  if (missing.length === 0) return
  let links = existing
  for (const p of missing) links = designStore.link({ documentId, ...p })
  notify.broadcast('design:links-updated', { docId: documentId, links })
}
