// Panes dormindo do lazy restore, vistas do main. Uma pane dormindo não tem
// processo: quem entrega de fora do renderer (agent-bus, wake da mãe,
// send-prompt) só a alcança acordando-a primeiro. O renderer é o dono da pane
// (layout, paneId); o main pede o resume a ele e espera a PTY ficar pronta.
//
// O SendMessage NATIVO do Claude Code não passa por aqui (socket por pid): para
// ele uma pane dormindo simplesmente não existe. Aceito; o badge avisa.
//
// Sem electron: a janela, a PTY e a tela chegam por deps (como a PromptQueue).
import { randomUUID } from 'node:crypto'
import type { ScreenScan } from '../../../shared/tui/attention-reason'
import type { DormantPaneInfo, WakeRequest, WakeResult } from '../../../shared/types/ipc'

export const WAKE_RESULT_TIMEOUT_MS = 30_000
export const WAKE_READY_TIMEOUT_MS = 90_000
export const WAKE_READY_POLL_MS = 500
// Wake que falhou costuma falhar de novo (sem janela, transcript sumido): cada
// remetente a mais esperaria o teto inteiro outra vez. Por isso falha na hora.
export const WAKE_FAILURE_COOLDOWN_MS = 60_000

// Mesmo texto do resume recusado (conversation-holder), para o wake_failed dizer o porquê.
export function openElsewhereError(pid: number): string {
  return `conversa aberta em outro processo (pid ${pid})`
}

export type DormantWakeReason = 'agent-bus' | 'handoff-wake' | 'send-prompt'

export type DormantWakeOutcome =
  | { ok: true; sessionId: string }
  // sessionId não nulo = a sessão subiu mas a PTY morreu antes de ficar pronta.
  | { ok: false; error: string; sessionId: string | null }

export interface DormantPanesDeps {
  // false = sem janela para pedir o resume.
  requestWake(request: WakeRequest): boolean
  isRunning(sessionId: string): boolean
  // pid de um processo fora do Pitwall com a conversa aberta; null = livre.
  foreignHolderPid?(ccSessionId: string): number | null
  // A mesma fonte da PromptQueue: tela relida agora.
  screen(sessionId: string): Promise<ScreenScan | null>
  warn(event: Record<string, unknown>): void
  resultTimeoutMs?: number
  readyTimeoutMs?: number
  readyPollMs?: number
  failureCooldownMs?: number
  now?(): number
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export interface PtyReadyDeps {
  isRunning(sessionId: string): boolean
  screen(sessionId: string): Promise<ScreenScan | null>
  readyTimeoutMs?: number
  readyPollMs?: number
}

// Pronta = PTY viva com a TUI reconhecida (tela espelhada). Sem isso o on-idle
// recusaria com no-screen. O turno ocioso NÃO é esperado aqui: quem entrega usa
// a fila on-idle, que já espera o idle/waiting certo.
export async function waitPtyReady(
  sessionId: string,
  deps: PtyReadyDeps,
): Promise<'ready' | 'exited' | 'timeout'> {
  const deadline = Date.now() + (deps.readyTimeoutMs ?? WAKE_READY_TIMEOUT_MS)
  const poll = deps.readyPollMs ?? WAKE_READY_POLL_MS
  for (;;) {
    if (!deps.isRunning(sessionId)) return 'exited'
    if ((await deps.screen(sessionId)) != null) return 'ready'
    if (Date.now() >= deadline) return 'timeout'
    await sleep(poll)
  }
}

export class DormantPanes {
  private byCc = new Map<string, DormantPaneInfo>()
  // Um wake por cc: dois remetentes ao mesmo tempo não podem retomar duas vezes.
  private inflight = new Map<string, Promise<DormantWakeOutcome>>()
  private awaiting = new Map<string, (result: WakeResult) => void>()
  private failedAt = new Map<string, number>()

  constructor(private deps: DormantPanesDeps) {}

  // A lista inteira a cada sync: o renderer é a fonte, o main só espelha.
  setDormant(list: DormantPaneInfo[]): void {
    this.byCc = new Map(list.map((p) => [p.ccSessionId, p]))
  }

  findDormantByCc(ccSessionId: string): DormantPaneInfo | null {
    return this.byCc.get(ccSessionId) ?? null
  }

  // Mesmo critério do resolveAlias do agent-bus: título, case-insensitive.
  findDormantByAlias(name: string): DormantPaneInfo[] {
    const key = name.trim().toLowerCase()
    if (!key) return []
    return [...this.byCc.values()].filter((p) => p.title?.toLowerCase() === key)
  }

  findDormantByRepo(repoId: string): DormantPaneInfo[] {
    return [...this.byCc.values()].filter((p) => p.repoId === repoId)
  }

  onWakeResult(result: WakeResult): void {
    const resolve = this.awaiting.get(result.requestId)
    if (!resolve) return
    this.awaiting.delete(result.requestId)
    resolve(result)
  }

  wakeDormant(ccSessionId: string, reason: DormantWakeReason): Promise<DormantWakeOutcome> {
    const running = this.inflight.get(ccSessionId)
    if (running) return running
    const now = this.deps.now ?? Date.now
    const failedAt = this.failedAt.get(ccSessionId)
    const cooldown = this.deps.failureCooldownMs ?? WAKE_FAILURE_COOLDOWN_MS
    if (failedAt !== undefined && now() - failedAt < cooldown) {
      return Promise.resolve({ ok: false, error: 'wake-cooldown', sessionId: null })
    }
    const next = this.wakeNow(ccSessionId)
      .then((outcome) => {
        if (outcome.ok) this.failedAt.delete(ccSessionId)
        else if (outcome.error !== 'not-dormant') this.failedAt.set(ccSessionId, now())
        this.deps.warn({
          event: outcome.ok ? 'dormant_woke' : 'dormant_wake_failed',
          ccSessionId,
          reason,
          sessionId: outcome.sessionId,
          error: outcome.ok ? undefined : outcome.error,
        })
        return outcome
      })
      // Também quando o wake lança: senão o cc ficava preso no inflight para sempre.
      .finally(() => this.inflight.delete(ccSessionId))
    this.inflight.set(ccSessionId, next)
    return next
  }

  private async wakeNow(ccSessionId: string): Promise<DormantWakeOutcome> {
    if (!this.byCc.has(ccSessionId)) return { ok: false, error: 'not-dormant', sessionId: null }
    const holder = this.deps.foreignHolderPid?.(ccSessionId) ?? null
    if (holder !== null) {
      return { ok: false, error: openElsewhereError(holder), sessionId: null }
    }
    const result = await this.requestResume(ccSessionId)
    if (!result.sessionId) {
      return { ok: false, error: result.error ?? 'resume-failed', sessionId: null }
    }
    // Acordou: não está mais dormindo, mesmo antes do próximo sync do renderer.
    this.byCc.delete(ccSessionId)
    return this.waitReady(result.sessionId)
  }

  private requestResume(ccSessionId: string): Promise<WakeResult> {
    const requestId = randomUUID()
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.awaiting.delete(requestId)
        resolve({ requestId, sessionId: null, error: 'wake-result-timeout' })
      }, this.deps.resultTimeoutMs ?? WAKE_RESULT_TIMEOUT_MS)
      this.awaiting.set(requestId, (r) => {
        clearTimeout(timer)
        resolve(r)
      })
      if (!this.deps.requestWake({ requestId, ccSessionId })) {
        this.onWakeResult({ requestId, sessionId: null, error: 'no-window' })
      }
    })
  }

  private async waitReady(sessionId: string): Promise<DormantWakeOutcome> {
    const ready = await waitPtyReady(sessionId, this.deps)
    if (ready === 'exited') return { ok: false, error: 'exited-before-ready', sessionId }
    // PTY viva sem tela no teto: devolve o id mesmo assim (sucesso degradado); a
    // fila on-idle decide se e quando entrega.
    if (ready === 'timeout') this.deps.warn({ event: 'dormant_ready_timeout', sessionId })
    return { ok: true, sessionId }
  }
}

let current: DormantPanes | null = null
let enabled: () => boolean = () => true

// enabled = a pref sessions.lazyRestore (o main real passa o leitor dela). Lida a
// cada chamada: desligar vale na hora, sem reiniciar.
export function setDormantPanes(panes: DormantPanes | null, isEnabled?: () => boolean): void {
  current = panes
  enabled = isEnabled ?? (() => true)
}

// null com a pref desligada: agent-bus, wake da mãe, send-prompt e a resposta a
// pedido escalado seguem o caminho de antes da feature (not-running/not_running).
export function getDormantPanes(): DormantPanes | null {
  return current && enabled() ? current : null
}

// O que o agent-bus enxerga das panes dormindo. Relido a cada chamada: com a pref
// desligada não há pane dormindo e o ask cai no "nenhuma sessão viva" de antes.
export function agentBusDormantDeps(): {
  byAlias(name: string): DormantPaneInfo[]
  byRepo(repoId: string): DormantPaneInfo[]
  wake(ccSessionId: string): Promise<DormantWakeOutcome>
} {
  return {
    byAlias: (name) => getDormantPanes()?.findDormantByAlias(name) ?? [],
    byRepo: (repoId) => getDormantPanes()?.findDormantByRepo(repoId) ?? [],
    wake: (cc) =>
      getDormantPanes()?.wakeDormant(cc, 'agent-bus') ??
      Promise.resolve({ ok: false, error: 'no-registry', sessionId: null }),
  }
}
