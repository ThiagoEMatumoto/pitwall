// Tamanho da modal do terminal (lift do mapa) POR SESSÃO, como o maestri.liftSizes:
// cada sessão reabre do tamanho em que o usuário a deixou. Só conveniência deste
// navegador (localStorage); sem nada salvo, o padrão de sempre.

export interface LiftSize {
  w: number
  h: number
}

export type LiftEdge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

export const LIFT_SIZES_KEY = 'pitwall.liftSizes'
export const LIFT_MIN: LiftSize = { w: 520, h: 320 }
// Respiro do backdrop (p-6) em cada lado: o teto é a janela menos isso.
export const LIFT_PAD = 24
export const LIFT_MAX_SAVED = 60
const DEFAULT_MAX_W = 1400

export function clampLiftSize(size: LiftSize, view: LiftSize): LiftSize {
  const maxW = view.w - 2 * LIFT_PAD
  const maxH = view.h - 2 * LIFT_PAD
  // O teto vence o mínimo: numa janela minúscula a modal ainda cabe nela.
  return {
    w: Math.round(Math.min(maxW, Math.max(LIFT_MIN.w, size.w))),
    h: Math.round(Math.min(maxH, Math.max(LIFT_MIN.h, size.h))),
  }
}

export function defaultLiftSize(view: LiftSize): LiftSize {
  return clampLiftSize({ w: Math.min(DEFAULT_MAX_W, view.w * 0.94), h: view.h * 0.9 }, view)
}

// A modal fica centrada: puxar uma borda cresce/encolhe dos DOIS lados, então o
// delta conta dobrado — é o que mantém a borda puxada debaixo do ponteiro.
export function resizeLift(
  start: LiftSize,
  edge: LiftEdge,
  dx: number,
  dy: number,
  view: LiftSize,
): LiftSize {
  const sx = edge.includes('e') ? 2 : edge.includes('w') ? -2 : 0
  const sy = edge.includes('s') ? 2 : edge.includes('n') ? -2 : 0
  return clampLiftSize({ w: start.w + sx * dx, h: start.h + sy * dy }, view)
}

function isSize(v: unknown): v is LiftSize {
  const s = v as LiftSize | null
  return (
    !!s &&
    typeof s === 'object' &&
    Number.isFinite(s.w) &&
    Number.isFinite(s.h) &&
    s.w > 0 &&
    s.h > 0
  )
}

export function readLiftSizes(): Record<string, LiftSize> {
  try {
    const raw = localStorage.getItem(LIFT_SIZES_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const out: Record<string, LiftSize> = {}
    for (const [id, v] of Object.entries(parsed ?? {})) if (isSize(v)) out[id] = { w: v.w, h: v.h }
    return out
  } catch {
    return {}
  }
}

function write(sizes: Record<string, LiftSize>): void {
  try {
    localStorage.setItem(LIFT_SIZES_KEY, JSON.stringify(sizes))
  } catch {
    // localStorage indisponível: o tamanho vale só enquanto a modal está aberta.
  }
}

export function liftSizeOf(sessionId: string, view: LiftSize): LiftSize {
  const saved = readLiftSizes()[sessionId]
  return saved ? clampLiftSize(saved, view) : defaultLiftSize(view)
}

// Ordem de inserção = recência: a re-salva vai para o fim e a poda tira do começo.
export function rememberLiftSize(sessionId: string, size: LiftSize): void {
  const { [sessionId]: _old, ...rest } = readLiftSizes()
  const entries = [...Object.entries(rest), [sessionId, { w: size.w, h: size.h }] as const]
  write(Object.fromEntries(entries.slice(-LIFT_MAX_SAVED)))
}

export function forgetLiftSize(sessionId: string): void {
  const { [sessionId]: _old, ...rest } = readLiftSizes()
  write(rest)
}
