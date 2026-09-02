import type { DesignAgentActivity, DesignSelection } from '../../../../shared/types/design'

// Estado efêmero do Design Studio, só em memória do main: o que o humano tem
// selecionado (lido por design_selection_get no MCP), qual documento está
// aberto e o que o agente está mexendo agora (HUD no canvas). Nada disso
// sobrevive a restart nem tem razão de ir pro banco.

export interface LiveSelection {
  artboardId: string | null
  nodeIds: string[]
  updatedAt: number
}

// Atividade sem `finish` some sozinha: um agente que morreu no meio não pode
// deixar o HUD piscando pra sempre.
export const ACTIVITY_TTL_MS = 5 * 60 * 1000

const selections = new Map<string, LiveSelection>()
const activities = new Map<string, DesignAgentActivity[]>()
let activeDocId: string | null = null

export function setSelection(input: DesignSelection): void {
  selections.set(input.docId, {
    artboardId: input.artboardId,
    nodeIds: [...input.nodeIds],
    updatedAt: Date.now(),
  })
}

export function getSelection(docId: string): LiveSelection | null {
  return selections.get(docId) ?? null
}

export function setActiveDoc(docId: string | null): void {
  activeDocId = docId
}

export function getActiveDoc(): string | null {
  return activeDocId
}

export function setActivity(activity: DesignAgentActivity): void {
  const current = activities.get(activity.docId) ?? []
  activities.set(activity.docId, [...current, activity])
}

export function clearActivity(
  docId: string,
  filter?: { artboardId?: string | null; nodeIds?: string[] },
): void {
  if (!filter) {
    activities.delete(docId)
    return
  }
  const current = activities.get(docId) ?? []
  const nodeSet = filter.nodeIds ? new Set(filter.nodeIds) : null
  const kept = current.filter((a) => {
    const artboardHit = filter.artboardId === undefined || a.artboardId === filter.artboardId
    const nodeHit = nodeSet === null || a.nodeIds.some((id) => nodeSet.has(id))
    return !(artboardHit && nodeHit)
  })
  if (kept.length) activities.set(docId, kept)
  else activities.delete(docId)
}

export function listActivity(docId: string, now = Date.now()): DesignAgentActivity[] {
  const current = activities.get(docId) ?? []
  const fresh = current.filter((a) => now - a.at < ACTIVITY_TTL_MS)
  if (fresh.length !== current.length) {
    if (fresh.length) activities.set(docId, fresh)
    else activities.delete(docId)
  }
  return fresh
}

// Só pra testes: zera tudo entre casos.
export function resetLiveState(): void {
  selections.clear()
  activities.clear()
  activeDocId = null
}
