// Cada push do grafo (~300ms com sessão trabalhando) recria todos os nós e
// arestas: sem reaproveitar os iguais, o memo dos cartões/notas nunca pula um
// render e o mapa inteiro redesenha a cada tick.

// Campos que o React Flow escreve no nó; não vêm do graphToFlow.
const FLOW_MANAGED = new Set(['measured', 'selected', 'dragging', 'resizing'])

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const ra = a as Record<string, unknown>
  const rb = b as Record<string, unknown>
  const keys = Object.keys(ra)
  if (keys.length !== Object.keys(rb).length) return false
  return keys.every((k) => deepEqual(ra[k], rb[k]))
}

function sameItem(next: object, prev: object): boolean {
  const rn = next as Record<string, unknown>
  const rp = prev as Record<string, unknown>
  const keys = new Set([...Object.keys(rn), ...Object.keys(rp)])
  for (const k of keys) {
    if (!FLOW_MANAGED.has(k) && !deepEqual(rn[k], rp[k])) return false
  }
  return true
}

export function reuseUnchanged<T extends { id: string; selected?: boolean; resizing?: boolean }>(
  next: T[],
  prev: T[],
): T[] {
  const byId = new Map(prev.map((p) => [p.id, p]))
  let changed = next.length !== prev.length
  const out = next.map((n, i) => {
    const p = byId.get(n.id)
    // No meio de um redimensionar, width/height são do gesto (o NodeResizer os
    // escreve): o nó do layout traria a vaga antiga e o cartão pularia de volta.
    // Fica congelado até soltar; o soltar grava o tamanho e o próximo push já o traz.
    if (p?.resizing || (p && sameItem(n, p))) {
      if (prev[i] !== p) changed = true
      return p
    }
    changed = true
    return p?.selected ? { ...n, selected: true } : n
  })
  return changed ? out : prev
}
