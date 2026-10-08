import type { AttentionItem } from '../types/attention'

// O que o humano vê. Itens 'info' (resultado não lido pela mãe, PTY ociosa após
// done) só entram se a superfície pedir.
export function humanQueue(
  items: AttentionItem[],
  opts: { includeInfo?: boolean } = {},
): AttentionItem[] {
  return items.filter((i) => (opts.includeInfo ? true : i.severity !== 'info'))
}

export function attentionHandoffIds(items: AttentionItem[]): Set<string> {
  return new Set(items.flatMap((i) => (i.handoffId ? [i.handoffId] : [])))
}

// A unidade de contagem de toda superfície: o sujeito (sessão, ou handoff sem
// sessão). Menu + falha da mesma sessão é um chip só, como no HUD.
export function attentionSubjectKey(i: AttentionItem): string {
  return i.sessionId ? `s:${i.sessionId}` : `h:${i.handoffId ?? i.dedupKey}`
}

// O "length da projeção" que cada superfície tem de reproduzir pela soma das partes.
export function countAttentionSubjects(items: AttentionItem[]): number {
  return new Set(items.map(attentionSubjectKey)).size
}

// Item pertence à lane se a sessão dele está nela; sem sessão, pela feature.
export function countForLane(
  items: AttentionItem[],
  sessionIds: ReadonlySet<string>,
  featureId: string | null,
): number {
  const subjects = new Set<string>()
  for (const i of items) {
    if (i.sessionId ? sessionIds.has(i.sessionId) : featureId != null && i.featureId === featureId)
      subjects.add(attentionSubjectKey(i))
  }
  return subjects.size
}
