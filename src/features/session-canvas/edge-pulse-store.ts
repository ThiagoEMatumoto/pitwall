// Pulsos ativos por par de sessões, fora do estado do mapa: um pulso re-renderiza só
// o fio daquele par (useSyncExternalStore por chave), nunca o mapa inteiro.
//
// Vários pulsos no mesmo par viram um TREM: cada um parte PULSE_SPACING_MS depois
// do anterior, então nunca se sobrepõem. Cada um vive o trajeto + o ping no destino.
import { useEffect, useSyncExternalStore } from 'react'
import type {
  SessionLinkPulse,
  SessionLinkPulseKind,
} from '../../../shared/types/session-link-pulse'

export const PULSE_TRAVEL_MS = 900
export const PULSE_SPACING_MS = 240
export const PULSE_PING_MS = 650
// Trem mais longo que isso não informa mais nada: o excedente é descartado.
export const PULSE_MAX_TRAIN = 6

export interface ActivePulse {
  id: string
  from: string
  to: string
  kind: SessionLinkPulseKind
  label?: string
  // Relógio de performance.now() (o mesmo do requestAnimationFrame).
  startAt: number
}

// Passo intermediário e nota pulsam no fio, mas não falam: com 10-20 sessões em
// enxame o leitor de tela anunciaria sem parar enquanto o usuário navega o mapa.
const SILENT_KINDS: ReadonlySet<SessionLinkPulseKind> = new Set(['progress', 'note'])

export const pulsePairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`)

const EMPTY: readonly ActivePulse[] = Object.freeze([])

type Schedule = (fn: () => void, ms: number) => void

export class EdgePulseStore {
  private byPair = new Map<string, readonly ActivePulse[]>()
  private pairListeners = new Map<string, Set<() => void>>()
  private anyListeners = new Set<() => void>()
  // Fios montados por par, na ordem de montagem: o primeiro desenha o trem.
  private claims = new Map<string, string[]>()
  private orphanCache: readonly ActivePulse[] = EMPTY
  private orphanDirty = false
  private label = ''

  constructor(
    private readonly now: () => number = () => performance.now(),
    private readonly schedule: Schedule = (fn, ms) => void setTimeout(fn, ms),
  ) {}

  add(p: Pick<SessionLinkPulse, 'id' | 'fromSessionId' | 'toSessionId' | 'kind' | 'label'>): void {
    const key = pulsePairKey(p.fromSessionId, p.toSessionId)
    const list = this.byPair.get(key) ?? EMPTY
    if (list.length >= PULSE_MAX_TRAIN || list.some((x) => x.id === p.id)) return
    const now = this.now()
    const last = list.at(-1)
    const startAt = last ? Math.max(now, last.startAt + PULSE_SPACING_MS) : now
    const pulse: ActivePulse = {
      id: p.id,
      from: p.fromSessionId,
      to: p.toSessionId,
      kind: p.kind,
      label: p.label,
      startAt,
    }
    if (p.label && !SILENT_KINDS.has(p.kind)) this.label = p.label
    this.set(key, [...list, pulse])
    this.schedule(() => this.remove(key, p.id), startAt - now + PULSE_TRAVEL_MS + PULSE_PING_MS)
  }

  private remove(key: string, id: string): void {
    const list = this.byPair.get(key)
    if (!list) return
    const next = list.filter((x) => x.id !== id)
    this.set(key, next.length ? next : EMPTY)
  }

  private set(key: string, list: readonly ActivePulse[]): void {
    if (list === EMPTY) this.byPair.delete(key)
    else this.byPair.set(key, list)
    this.orphanDirty = true
    for (const fn of this.pairListeners.get(key) ?? []) fn()
    for (const fn of this.anyListeners) fn()
  }

  // Legenda do último pulso ("mãe → otavio: mensagem"), para o aria-live do mapa.
  lastLabel(): string {
    return this.label
  }

  pulsesFor(key: string): readonly ActivePulse[] {
    return this.byPair.get(key) ?? EMPTY
  }

  subscribePair(key: string, fn: () => void): () => void {
    let set = this.pairListeners.get(key)
    if (!set) this.pairListeners.set(key, (set = new Set()))
    set.add(fn)
    return () => {
      set.delete(fn)
      if (set.size === 0) this.pairListeners.delete(key)
    }
  }

  subscribeAny(fn: () => void): () => void {
    this.anyListeners.add(fn)
    return () => this.anyListeners.delete(fn)
  }

  // Um fio montado "assume" o par: o pulso anda nele. Par sem fio (agent_ask entre
  // projetos, mãe com o leque recolhido) ganha um arco temporário na camada solta.
  // Dois fios no mesmo par (handoff + ask) não desenham dois trens: só o dono.
  claim(key: string, edgeId: string): () => void {
    this.claims.set(key, [...(this.claims.get(key) ?? []), edgeId])
    this.touchClaims(key)
    return () => {
      const rest = (this.claims.get(key) ?? []).filter((id) => id !== edgeId)
      if (rest.length) this.claims.set(key, rest)
      else this.claims.delete(key)
      this.touchClaims(key)
    }
  }

  ownerOf(key: string): string | null {
    return this.claims.get(key)?.[0] ?? null
  }

  private touchClaims(key: string): void {
    for (const fn of this.pairListeners.get(key) ?? []) fn()
    this.touchOrphans()
  }

  private touchOrphans(): void {
    this.orphanDirty = true
    for (const fn of this.anyListeners) fn()
  }

  orphans(): readonly ActivePulse[] {
    if (!this.orphanDirty) return this.orphanCache
    this.orphanDirty = false
    const next = [...this.byPair].flatMap(([key, list]) => (this.claims.has(key) ? [] : list))
    const same =
      next.length === this.orphanCache.length && next.every((p, i) => p === this.orphanCache[i])
    if (!same) this.orphanCache = next.length ? next : EMPTY
    return this.orphanCache
  }
}

export const edgePulseStore = new EdgePulseStore()

export function usePairPulses(a: string, b: string): readonly ActivePulse[] {
  const key = pulsePairKey(a, b)
  return useSyncExternalStore(
    (fn) => edgePulseStore.subscribePair(key, fn),
    () => edgePulseStore.pulsesFor(key),
  )
}

// Assume o par enquanto o fio está montado e diz se é ESTE fio que desenha o trem.
export function usePairOwner(a: string, b: string, edgeId: string, enabled: boolean): boolean {
  const key = pulsePairKey(a, b)
  useEffect(() => (enabled ? edgePulseStore.claim(key, edgeId) : undefined), [key, edgeId, enabled])
  const owner = useSyncExternalStore(
    (fn) => edgePulseStore.subscribePair(key, fn),
    () => edgePulseStore.ownerOf(key),
  )
  return enabled && owner === edgeId
}

export function useOrphanPulses(): readonly ActivePulse[] {
  return useSyncExternalStore(
    (fn) => edgePulseStore.subscribeAny(fn),
    () => edgePulseStore.orphans(),
  )
}

// ---- geometria/tempo puros (testáveis sem DOM) ----

// O fio é desenhado de source → target. Pulso no sentido contrário anda ao revés.
export function pulseDirection(
  edgeSourceSessionId: string,
  pulse: Pick<ActivePulse, 'from'>,
): 'forward' | 'reverse' {
  return pulse.from === edgeSourceSessionId ? 'forward' : 'reverse'
}

// easeInOutCubic: arranca macio, acelera no meio, pousa macio no destino.
export function easePulse(t: number): number {
  const x = Math.min(1, Math.max(0, t))
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2
}

// Fração do path percorrida (0 = ponta source, 1 = ponta target), já com direção.
export function pulseFraction(elapsedMs: number, direction: 'forward' | 'reverse'): number {
  const e = easePulse(elapsedMs / PULSE_TRAVEL_MS)
  return direction === 'forward' ? e : 1 - e
}

// Arco temporário entre dois pontos: curva quadrática que estufa para um lado
// (proporcional à distância), para não se confundir com um fio de verdade.
export function arcPath(a: { x: number; y: number }, b: { x: number; y: number }): string {
  const mx = (a.x + b.x) / 2
  const my = (a.y + b.y) / 2
  const dx = b.x - a.x
  const dy = b.y - a.y
  const bulge = Math.min(160, Math.hypot(dx, dy) * 0.25)
  const len = Math.hypot(dx, dy) || 1
  const cx = mx + (-dy / len) * bulge
  const cy = my + (dx / len) * bulge
  return `M ${a.x} ${a.y} Q ${cx} ${cy} ${b.x} ${b.y}`
}

// Cor por tipo — só tokens do tema.
export const PULSE_COLOR: Record<SessionLinkPulseKind, string> = {
  task: 'var(--color-accent)',
  message: 'var(--color-accent)',
  progress: 'var(--color-success)',
  report: 'var(--color-success)',
  answer: 'var(--color-success)',
  reply: 'var(--color-success)',
  question: 'var(--color-warning)',
  ask: 'var(--color-warning)',
  note: 'var(--color-text-dim)',
}
