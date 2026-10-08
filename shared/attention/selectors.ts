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

// Item pertence à lane se a sessão dele está nela; sem sessão, pela feature.
export function countForLane(
  items: AttentionItem[],
  sessionIds: ReadonlySet<string>,
  featureId: string | null,
): number {
  return items.filter((i) =>
    i.sessionId ? sessionIds.has(i.sessionId) : featureId != null && i.featureId === featureId,
  ).length
}
