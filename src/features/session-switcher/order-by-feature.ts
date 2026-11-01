/**
 * Ordem dentro de um grupo do seletor: primeiro as sessões com feature,
 * agrupadas por feature (a feature da sessão mais recente primeiro), com a mãe
 * à frente e as filhas logo abaixo dela; depois as soltas, por recência. Só por
 * recência, a mãe da única feature ativa caía na última linha, abaixo de 8
 * sessões soltas. `childOf` marca as filhas postas sob a mãe (o "↳").
 */
export function orderByFeature<T extends { id: string }>(
  items: T[],
  featureOf: ReadonlyMap<string, string | null>,
  motherOfChild: ReadonlyMap<string, string>,
): { items: T[]; childOf: ReadonlyMap<string, string> } {
  const present = new Set(items.map((s) => s.id))
  const childOf = new Map<string, string>()
  for (const s of items) {
    const mother = motherOfChild.get(s.id)
    if (mother && mother !== s.id && present.has(mother)) childOf.set(s.id, mother)
  }
  const out: T[] = []
  const placed = new Set<string>()
  const place = (s: T) => {
    if (placed.has(s.id)) return
    placed.add(s.id)
    out.push(s)
    for (const c of items) if (childOf.get(c.id) === s.id) place(c)
  }
  const keyOf = (s: T): string | null => {
    const mother = childOf.get(s.id)
    return featureOf.get(s.id) ?? (mother ? (featureOf.get(mother) ?? null) : null)
  }
  const features = [...new Set(items.map(keyOf).filter((f): f is string => !!f))]
  for (const f of features)
    for (const s of items) if (keyOf(s) === f && !childOf.has(s.id)) place(s)
  for (const s of items) if (!childOf.has(s.id) || !placed.has(childOf.get(s.id)!)) place(s)
  return { items: out, childOf }
}
