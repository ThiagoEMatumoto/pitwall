// Hibernação por ociosidade: sessão claude parada há N minutos sai com /exit e a
// pane vira dormant (o mesmo estado do lazy restore, acordável pelos mesmos
// caminhos). Fail-closed: cada gate que não PROVA ociosidade recusa, e cada
// recusa conta por motivo — os contadores são a única forma de alguém notar um
// gate que recusa tudo.
//
// O /exit sai pela PromptQueue com when 'on-idle', a mesma guarda do agent-bus
// (sem menu, sem rascunho, tela reconhecida). Nunca Ctrl-U, nunca limpar input,
// nunca kill: se não sair, a sessão fica viva.
//
// Sem electron: tudo que fala com PTY, banco, disco e fila chega por deps.
import type { SendPromptInput, SendPromptResult } from '../../../../shared/types/send-prompt'
import {
  HIBERNATE_REFUSALS,
  type HibernateRefusal,
  type HibernateStats,
  type SessionHibernatedEvent,
} from '../../../../shared/hibernate'
import type { ProcTreeVerdict } from './proc-tree'

export const HIBERNATE_TICK_MS = 60_000
export const EXIT_TIMEOUT_MS = 30_000
export const EXIT_COMMAND = '/exit'

export interface HibernateCandidate {
  // sessions.id (a PTY).
  sessionId: string
  ccSessionId: string
}

// O recorte de ~/.claude/sessions/<pid>.json que o gate lê (escritor = o claude).
export interface SessionFileState {
  pid: number
  status: 'busy' | 'idle' | 'waiting' | 'shell' | null
  statusUpdatedAt: number | null
}

export interface IdleHibernatorDeps {
  // Minutos da pref; <= 0 = desligado.
  afterMin(): number
  // PTYs vivas do provider claude com ccSessionId.
  candidates(): HibernateCandidate[]
  // Pane (aba) acordada no renderer para esta conversa.
  hasPane(ccSessionId: string): boolean
  lastIoAt(sessionId: string): number | null
  // null = sem arquivo, ilegível ou sem pid.
  sessionFile(ccSessionId: string): SessionFileState | null
  isPidAlive(pid: number): boolean
  activeHandoffCcSessionIds(): string[]
  queueHas(sessionId: string): boolean
  // agent_ask envolvendo a conversa desde `since` (ou ainda pendente).
  agentMessageSince(ccSessionId: string, since: number): boolean
  transcriptPath(ccSessionId: string): string | null
  usedScheduling(path: string): Promise<boolean | null>
  procTree(pid: number): ProcTreeVerdict
  send(input: SendPromptInput): Promise<SendPromptResult>
  cancel(queueId: string): void
  warn(event: Record<string, unknown>): void
  now?(): number
  exitTimeoutMs?: number
  tickMs?: number
}

export type GateVerdict = { ok: true; pid: number } | { ok: false; reason: HibernateRefusal }

function emptyRefusals(): Record<HibernateRefusal, number> {
  return Object.fromEntries(HIBERNATE_REFUSALS.map((r) => [r, 0])) as Record<
    HibernateRefusal,
    number
  >
}

interface Pending {
  ccSessionId: string
  timer: NodeJS.Timeout | null
}

export class IdleHibernator {
  private stats: HibernateStats = {
    afterMin: 0,
    hibernated: 0,
    refused: emptyRefusals(),
    lastTickAt: null,
  }
  // sessions.id → /exit em curso. Marcado ANTES do envio: o exit pode chegar
  // antes de o send devolver.
  private pending = new Map<string, Pending>()
  private timer: NodeJS.Timeout | null = null
  private ticking = false

  constructor(private deps: IdleHibernatorDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  getStats(): HibernateStats {
    return { ...this.stats, refused: { ...this.stats.refused } }
  }

  isHibernating(sessionId: string): boolean {
    return this.pending.has(sessionId)
  }

  // Liga o tick só com a pref > 0. Chamado no boot e quando a pref muda.
  reschedule(): void {
    const afterMin = this.deps.afterMin()
    this.stats.afterMin = afterMin
    if (afterMin > 0 && !this.timer) {
      this.timer = setInterval(() => void this.tick(), this.deps.tickMs ?? HIBERNATE_TICK_MS)
      this.timer.unref?.()
    } else if (afterMin <= 0 && this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    for (const p of this.pending.values()) if (p.timer) clearTimeout(p.timer)
    this.pending.clear()
  }

  async tick(): Promise<void> {
    const afterMin = this.deps.afterMin()
    this.stats.afterMin = afterMin
    if (afterMin <= 0 || this.ticking) return
    this.ticking = true
    try {
      this.stats.lastTickAt = this.now()
      const handoffCc = new Set(this.deps.activeHandoffCcSessionIds())
      for (const candidate of this.deps.candidates()) {
        if (this.pending.has(candidate.sessionId)) continue
        const verdict = await this.evaluate(candidate, afterMin * 60_000, handoffCc)
        if (!verdict.ok) {
          this.refuse(verdict.reason)
          continue
        }
        await this.hibernate(candidate)
      }
    } finally {
      this.ticking = false
    }
  }

  // Gates H2 a-g, dos baratos para os caros. O primeiro que falha decide o motivo.
  async evaluate(
    c: HibernateCandidate,
    windowMs: number,
    handoffCc: Set<string>,
  ): Promise<GateVerdict> {
    const now = this.now()
    const refuse = (reason: HibernateRefusal): GateVerdict => ({ ok: false, reason })
    // a) pane acordada: sem ela a sessão não teria onde virar dormant.
    if (!this.deps.hasPane(c.ccSessionId)) return refuse('no-pane')
    // b) I/O no PTY (saída, escrita ou resize do app).
    const io = this.deps.lastIoAt(c.sessionId)
    if (io === null || now - io < windowMs) return refuse('io-recent')
    // c) status do próprio claude.
    const file = this.deps.sessionFile(c.ccSessionId)
    if (!file) return refuse('status-missing')
    if (!this.deps.isPidAlive(file.pid)) return refuse('status-dead')
    if (file.status !== 'idle') return refuse('status-not-idle')
    if (file.statusUpdatedAt === null || now - file.statusUpdatedAt < windowMs) {
      return refuse('status-recent')
    }
    // d) handoff ativo (mãe ou filha) e fila de prompts.
    if (handoffCc.has(c.ccSessionId)) return refuse('handoff')
    if (this.deps.queueHas(c.sessionId)) return refuse('queue')
    // e) agent_ask recente.
    if (this.deps.agentMessageSince(c.ccSessionId, now - windowMs)) return refuse('agent-msg')
    // f) agendamento em qualquer ponto do transcript.
    const path = this.deps.transcriptPath(c.ccSessionId)
    if (!path) return refuse('no-transcript')
    const scheduled = await this.deps.usedScheduling(path)
    if (scheduled === null) return refuse('no-transcript')
    if (scheduled) return refuse('scheduled')
    // g) nada rodando embaixo do claude.
    const tree = this.deps.procTree(file.pid)
    if (!tree.ok) return refuse('proc-tree')
    return { ok: true, pid: file.pid }
  }

  // H3: /exit pela fila on-idle com a guarda do agent-bus. Só conta como em curso
  // se a fila escreveu agora; segurado/enfileirado/recusado = cancela e não hiberna.
  async hibernate(c: HibernateCandidate): Promise<boolean> {
    const pending: Pending = { ccSessionId: c.ccSessionId, timer: null }
    this.pending.set(c.sessionId, pending)
    let sent: SendPromptResult
    try {
      sent = await this.deps.send({ sessionId: c.sessionId, text: EXIT_COMMAND, when: 'on-idle' })
    } catch (err) {
      this.deps.warn({ event: 'hibernate_send_failed', sessionId: c.sessionId, error: String(err) })
      sent = { ok: false, error: 'not-running' }
    }
    // O exit pode ter chegado durante o envio: já foi contado em onExit.
    if (this.pending.get(c.sessionId) !== pending) return sent.ok && sent.delivered
    if (!sent.ok || !sent.delivered) {
      if (sent.ok) this.deps.cancel(sent.queued.id)
      this.pending.delete(c.sessionId)
      this.refuse('guard-held')
      this.deps.warn({
        event: 'hibernate_guard_held',
        sessionId: c.sessionId,
        reason: sent.ok ? 'queued' : sent.error,
      })
      return false
    }
    pending.timer = setTimeout(() => {
      if (this.pending.get(c.sessionId) !== pending) return
      this.pending.delete(c.sessionId)
      this.refuse('exit-timeout')
      this.deps.warn({ event: 'hibernate_exit_timeout', sessionId: c.sessionId })
    }, this.deps.exitTimeoutMs ?? EXIT_TIMEOUT_MS)
    pending.timer.unref?.()
    return true
  }

  // Exit de PTY: se era o /exit da hibernação, devolve o evento que o renderer
  // usa para converter a pane em dormant (em vez de fechar).
  onExit(sessionId: string): SessionHibernatedEvent | null {
    const pending = this.pending.get(sessionId)
    if (!pending) return null
    if (pending.timer) clearTimeout(pending.timer)
    this.pending.delete(sessionId)
    this.stats.hibernated++
    this.deps.warn({
      event: 'session_hibernated',
      sessionId,
      ccSessionId: pending.ccSessionId,
      total: this.stats.hibernated,
    })
    return { sessionId, ccSessionId: pending.ccSessionId }
  }

  private refuse(reason: HibernateRefusal): void {
    this.stats.refused[reason]++
  }
}

let current: IdleHibernator | null = null

export function setIdleHibernator(h: IdleHibernator | null): void {
  current = h
}

export function getIdleHibernator(): IdleHibernator | null {
  return current
}
