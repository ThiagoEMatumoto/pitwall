import type { ScopeOomEvent } from '../../../shared/types/ipc'

// O kernel matou o próprio claude por memória: a conversa volta sozinha por
// --resume, porque quem deixou o trabalho rodando pode não estar olhando. Uma
// vez por conversa a cada 10 min: se o claude estourar de novo logo depois,
// fica só o toast, sem loop de resume.
export const OOM_AUTO_RESUME_WINDOW_MS = 10 * 60_000

interface Deps {
  // cc_session_id da sessão que morreu; null = sem conversa para retomar.
  ccOf(sessionId: string): string | null
  now?: () => number
}

export class OomAutoResume {
  // Por conversa, não por sessions.id: o resume gera um sessions.id novo.
  private lastAt = new Map<string, number>()

  constructor(private readonly deps: Deps) {}

  // Devolve o evento com o cc a retomar quando o resume automático vale.
  annotate(event: ScopeOomEvent): ScopeOomEvent {
    if (event.claudeAlive) return event
    const cc = this.deps.ccOf(event.sessionId)
    if (!cc) return event
    const now = (this.deps.now ?? Date.now)()
    const last = this.lastAt.get(cc)
    if (last !== undefined && now - last < OOM_AUTO_RESUME_WINDOW_MS) return event
    this.lastAt.set(cc, now)
    return { ...event, resumeCcSessionId: cc }
  }
}
