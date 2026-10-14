import type { ScopeOomEvent } from '../../../shared/types/ipc'

// O kernel matou o próprio claude por memória: a conversa volta sozinha por
// --resume, porque quem deixou o trabalho rodando pode não estar olhando. Uma
// vez por conversa a cada 10 min: se o claude estourar de novo logo depois,
// fica só o toast, sem loop de resume.
export const OOM_AUTO_RESUME_WINDOW_MS = 10 * 60_000
// Um OOM do slice das sessões derruba várias de uma vez; retomadas juntas,
// recriariam a pressão que as matou. Uma por vez, com intervalo, e só com o
// slice abaixo de 85% do teto.
export const OOM_RESUME_GAP_MS = 30_000
export const OOM_RESUME_PRESSURE_MAX = 0.85
export const OOM_RESUME_RETRY_MS = 15_000

interface Deps {
  // cc_session_id da sessão que morreu; null = sem conversa para retomar.
  ccOf(sessionId: string): string | null
  // memory.current / MemoryMax do slice das sessões; null = sem leitura (não segura).
  slicePressure(): number | null
  // Entrega o resume que saiu da fila depois do evento original.
  dispatch(event: ScopeOomEvent): void
}

export class OomAutoResume {
  // Por conversa, não por sessions.id: o resume gera um sessions.id novo.
  private lastAt = new Map<string, number>()
  private queue: ScopeOomEvent[] = []
  private lastDispatchAt = -Infinity
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly deps: Deps) {}

  // Devolve o evento a mandar agora: com o cc a retomar quando o resume vale e
  // pode sair já, ou marcado como enfileirado (o resume vem depois, via dispatch).
  annotate(event: ScopeOomEvent): ScopeOomEvent {
    if (event.claudeAlive) return event
    const cc = this.deps.ccOf(event.sessionId)
    if (!cc) return event
    const now = Date.now()
    const last = this.lastAt.get(cc)
    if (last !== undefined && now - last < OOM_AUTO_RESUME_WINDOW_MS) return event
    this.lastAt.set(cc, now)
    const resume = { ...event, resumeCcSessionId: cc }
    if (this.queue.length === 0 && this.canDispatch(now)) {
      this.lastDispatchAt = now
      return resume
    }
    this.queue.push(resume)
    this.schedule()
    return { ...event, resumeQueued: true }
  }

  private canDispatch(now: number): boolean {
    if (now - this.lastDispatchAt < OOM_RESUME_GAP_MS) return false
    const pressure = this.deps.slicePressure()
    return pressure === null || pressure < OOM_RESUME_PRESSURE_MAX
  }

  private schedule(): void {
    if (this.timer || this.queue.length === 0) return
    const sinceLast = Date.now() - this.lastDispatchAt
    const delay =
      sinceLast < OOM_RESUME_GAP_MS ? OOM_RESUME_GAP_MS - sinceLast : OOM_RESUME_RETRY_MS
    this.timer = setTimeout(() => {
      this.timer = null
      this.pump()
    }, delay)
    this.timer.unref?.()
  }

  private pump(): void {
    const now = Date.now()
    const next = this.queue[0]
    if (next && this.canDispatch(now)) {
      this.queue.shift()
      this.lastDispatchAt = now
      this.deps.dispatch(next)
    }
    this.schedule()
  }
}
