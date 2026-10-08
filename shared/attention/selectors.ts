import { PRODUCED_ATTENTION_KINDS, type AttentionItem } from '../types/attention'

const PRODUCED: ReadonlySet<string> = new Set(PRODUCED_ATTENTION_KINDS)

// O que o humano vê. Itens 'info' (resultado não lido pela mãe, PTY ociosa após
// done) só entram se a superfície pedir. Kind sem produtor declarado (F1+) fica de
// fora AQUI, e não em cada superfície: badge e lista contam o mesmo conjunto.
export function humanQueue(
  items: AttentionItem[],
  opts: { includeInfo?: boolean } = {},
): AttentionItem[] {
  return items.filter(
    (i) => PRODUCED.has(i.kind) && (opts.includeInfo ? true : i.severity !== 'info'),
  )
}

// A filha está parada esperando resposta: pergunta legada ou pedido tipado.
export function isAskItem(i: Pick<AttentionItem, 'kind'>): boolean {
  return i.kind === 'child_question' || i.kind === 'request'
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

// Recorte de uma feature: o MESMO predicado do card do Ctrl+` (buildSwitcherEntries).
// Item cuja sessão o mapa desenha pertence à lane pela sessão; senão, pela feature.
// laneSessionIds = sessões da lane que estão em inUse.
export function itemsForFeature(
  queue: AttentionItem[],
  laneSessionIds: ReadonlySet<string>,
  inUse: ReadonlySet<string>,
  featureId: string,
): AttentionItem[] {
  return queue.filter((i) =>
    i.sessionId && inUse.has(i.sessionId)
      ? laneSessionIds.has(i.sessionId)
      : i.featureId === featureId,
  )
}
