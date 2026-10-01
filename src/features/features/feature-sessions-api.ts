import type { FeatureSessionSummary } from '../../../shared/types/ipc'

// Timestamp que ordena a lista de sessões da feature: a última coisa que
// aconteceu nela (encerrada quando encerrou, senão quando começou).
export function sessionMoment(s: FeatureSessionSummary): number {
  return s.endedAt ?? s.startedAt
}

export interface FeatureSessionEntry {
  session: FeatureSessionSummary
  // Filha listada logo abaixo da mãe (que está na lista).
  depth: 0 | 1
  childCount: number
  motherTitle: string | null
}

// Mãe primeiro, as descendentes logo abaixo dela (neta sob a filha, tudo num
// recuo só); o resto pela última coisa que aconteceu. Filha cuja mãe não
// trabalhou nesta feature fica no nível de cima. Um ciclo de mother_session_id
// não esconde ninguém: quem não foi alcançado a partir de uma raiz entra no topo.
export function orderWithMothers(list: FeatureSessionSummary[]): FeatureSessionEntry[] {
  const byRecency = [...list].sort((a, b) => sessionMoment(b) - sessionMoment(a))
  const ids = new Set(list.map((s) => s.id))
  const motherIn = (s: FeatureSessionSummary) => {
    const m = s.motherSessionId
    return m && m !== s.id && ids.has(m) ? m : null
  }
  const childrenOf = new Map<string, FeatureSessionSummary[]>()
  for (const s of byRecency) {
    const m = motherIn(s)
    if (m) childrenOf.set(m, [...(childrenOf.get(m) ?? []), s])
  }
  const titleOf = new Map(list.map((s) => [s.id, s.title ?? 'sessão sem título']))
  const out: FeatureSessionEntry[] = []
  const seen = new Set<string>()
  const emitDescendants = (motherId: string) => {
    for (const c of childrenOf.get(motherId) ?? []) {
      if (seen.has(c.id)) continue
      seen.add(c.id)
      out.push({
        session: c,
        depth: 1,
        childCount: childrenOf.get(c.id)?.length ?? 0,
        motherTitle: titleOf.get(motherId) ?? null,
      })
      emitDescendants(c.id)
    }
  }
  const emitRoot = (s: FeatureSessionSummary) => {
    seen.add(s.id)
    out.push({ session: s, depth: 0, childCount: childrenOf.get(s.id)?.length ?? 0, motherTitle: null })
    emitDescendants(s.id)
  }
  for (const s of byRecency) if (!motherIn(s) && !seen.has(s.id)) emitRoot(s)
  for (const s of byRecency) if (!seen.has(s.id)) emitRoot(s)
  return out
}
