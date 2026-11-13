// Hibernação por ociosidade: sessão claude parada há N minutos sai com /exit e a
// pane vira dormant (o mesmo estado do lazy restore, acordável pelos mesmos
// caminhos). Fail-closed: cada gate que não PROVA ociosidade recusa, e cada
// recusa conta por motivo — os contadores são a única forma de alguém notar um
// gate que recusa tudo.
//
// A filha de handoff concluído (done) tem janela própria e dispensa a pane: sai
// com o mesmo /exit, fica sem aba e segue vinculada ao handoff.
//
// O /exit sai pela PromptQueue com when 'on-idle', a mesma guarda de toda entrega
// (sem menu, sem rascunho, tela reconhecida). Nunca Ctrl-U, nunca limpar input,
// nunca kill: se não sair, a sessão fica viva.
//
// Sem electron: tudo que fala com PTY, banco, disco e fila chega por deps.
import type { SendPromptInput, SendPromptResult } from '../../../../shared/types/send-prompt'
import {
  HIBERNATE_REFUSALS,
  paneCheckRefusal,
  type HandoffChildKind,
  type HibernateRefusal,
  type PaneCheck,
  type HibernateStats,
  type SessionHibernatedEvent,
} from '../../../../shared/hibernate'
import { perfCount, perfSelfTime, type PerfWait } from '../perf-probe'
import type { ProcTreeVerdict } from './proc-tree'
import type { TranscriptPeek } from './schedule-scan'

export const HIBERNATE_TICK_MS = 60_000
// O marcador cai aqui: um exit depois disso é um exit comum (o claude que não saiu
// em 75s pode sair por qualquer motivo, e só o /exit entregue conta como hibernação).
// Hooks SessionEnd legítimos levam até 60s antes de o processo sair.
export const EXIT_TIMEOUT_MS = 75_000
// O exit da PTY chega a dois ouvintes (este e a PromptQueue) sem ordem garantida:
// a fila pergunta wasHibernatedExit depois que este já consumiu o marcador.
const RECENT_EXIT_MS = 60_000
export const EXIT_COMMAND = '/exit'

export interface HibernateCandidate {
  // sessions.id (a PTY).
  sessionId: string
  ccSessionId: string
}

// O recorte de ~/.claude/sessions/<pid>.json que o gate lê (escritor = o claude).
export interface SessionFileState {
  pid: number
  procStart: string | null
  status: 'busy' | 'idle' | 'waiting' | 'shell' | null
  statusUpdatedAt: number | null
}

export interface IdleHibernatorDeps {
  // Pref sessions.lazyRestore (opt-in): sem ela não existe pane dormant nem wake,
  // então hibernar seria só matar a sessão. false = desligado, como afterMin <= 0.
  lazyRestore(): boolean
  // Minutos da pref; <= 0 = desligado.
  afterMin(): number
  // Minutos da janela da filha de handoff concluído; <= 0 = desligado. Não
  // depende do lazyRestore: ela não vira dormant.
  childAfterMin(): number
  // PTYs vivas do provider claude com ccSessionId.
  candidates(): HibernateCandidate[]
  // Pane (aba) acordada no renderer para esta conversa, pelo open_panes salvo
  // (debounce): filtro barato antes do round-trip.
  hasPane(ccSessionId: string): boolean
  // Round-trip com o renderer logo antes do /exit: a aba que mostra esta PTY
  // agora e se o usuário está nela, ou null (sem janela, sem resposta no prazo).
  confirmPane(sessionId: string, ccSessionId: string): Promise<PaneCheck | null>
  // Registra a dormant no main já no exit, sem esperar o dormantSync do renderer:
  // uma mensagem que chega nessa janela precisa achar a pane para acordá-la.
  registerDormant(ccSessionId: string, paneId: string): void
  // Estado "hibernada" no app.db (sessions.hibernated_at). true = grava durável
  // ANTES do /exit (lança se não conseguir); false = o /exit não virou hibernação.
  persistHibernating(sessionId: string, on: boolean): void
  lastIoAt(sessionId: string): number | null
  // null = sem arquivo, ilegível ou sem pid.
  sessionFile(ccSessionId: string): SessionFileState | null
  // Mesmo critério do índice de sessões: pid vivo E o mesmo processo (procStart).
  isPidAlive(file: SessionFileState): boolean
  // sessions.id da PTY viva desta conversa (findAliveByCc), ou null.
  aliveSessionId(ccSessionId: string): string | null
  activeHandoffCcSessionIds(): string[]
  // 'done' hiberna pela janela da filha. 'other' (falhou, parou) nunca hiberna:
  // o exit dela é o que o handoff ainda espera para se resolver.
  handoffChildKind(ccSessionId: string): HandoffChildKind
  queueHas(sessionId: string): boolean
  transcriptPath(ccSessionId: string): string | null
  // null = transcript ilegível. 'reading' = ainda sendo lido, fora do tick.
  scanTranscript(path: string): Promise<TranscriptPeek | null>
  procTree(pid: number): ProcTreeVerdict
  send(input: SendPromptInput): Promise<SendPromptResult>
  cancel(queueId: string): void
  // Coalescing do input segurado: o item da fila já criado recebe o texto acumulado.
  replaceText(queueId: string, text: string): boolean
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
  paneId: string | null
  // Filha de handoff concluído: o exit não deixa pane dormant.
  child: boolean
  // A fila escreveu o /exit. Daqui até o exit, todo write do app é segurado.
  delivered: boolean
  // O usuário escreveu no PTY antes de o /exit sair: a caixa pode ter texto cujo
  // eco a tela relida ainda não mostrou, e o /exit seria colado depois dele.
  inputSeen: boolean
  // Bytes segurados depois do /exit, reentregues crus na sessão acordada por um
  // único item da fila (queueId), atualizado por replaceText a cada write novo.
  held: string
  queueId: string | null
  holding: boolean
  timer: NodeJS.Timeout | null
}

export class IdleHibernator {
  private stats: HibernateStats = {
    afterMin: 0,
    childAfterMin: 0,
    hibernated: 0,
    refused: emptyRefusals(),
    lastTickAt: null,
  }
  // sessions.id → /exit em curso. Marcado ANTES do envio: o exit pode chegar
  // antes de o send devolver.
  private pending = new Map<string, Pending>()
  private recentExits = new Map<string, NodeJS.Timeout>()
  private timer: NodeJS.Timeout | null = null
  private ticking = false

  constructor(private deps: IdleHibernatorDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  getStats(): HibernateStats {
    return { ...this.stats, refused: { ...this.stats.refused } }
  }

  // O /exit já foi escrito e o exit ainda não veio: qualquer escrita agora cairia
  // num claude saindo. A fila e o sessions:write seguram até o wake.
  isHibernating(sessionId: string): boolean {
    return this.pending.get(sessionId)?.delivered === true
  }

  // A fila chama logo antes de qualquer write no PTY. false = não escreve agora (o
  // item segue na fila). Para o /exit da hibernação é a última releitura do input:
  // uma tecla digitada durante a releitura da tela ainda não ecoou, e o /exit
  // seria submetido junto com ela. Escrito o /exit, o marcador vira delivered aqui,
  // sem esperar o send devolver.
  beforeWrite(sessionId: string, text: string, inputDirty: boolean): boolean {
    const pending = this.pending.get(sessionId)
    if (!pending) return true
    if (pending.delivered) return false
    if (text !== EXIT_COMMAND) return true
    if (pending.inputSeen || inputDirty) {
      this.deps.warn({ event: 'hibernate_exit_aborted_by_input', sessionId })
      return false
    }
    // Sem o estado no banco, um restart antes do wake perderia as flags do spawn:
    // não grava = não sai.
    try {
      this.deps.persistHibernating(sessionId, true)
    } catch (err) {
      this.deps.warn({ event: 'hibernate_persist_failed', sessionId, error: String(err) })
      return false
    }
    pending.delivered = true
    return true
  }

  private unpersist(sessionId: string): void {
    try {
      this.deps.persistHibernating(sessionId, false)
    } catch (err) {
      this.deps.warn({ event: 'hibernate_unpersist_failed', sessionId, error: String(err) })
    }
  }

  // Minutos efetivos: 0 se qualquer uma das duas prefs estiver desligada.
  private effectiveAfterMin(): number {
    if (!this.deps.lazyRestore()) return 0
    const afterMin = this.deps.afterMin()
    return afterMin > 0 ? afterMin : 0
  }

  private effectiveChildAfterMin(): number {
    const childAfterMin = this.deps.childAfterMin()
    return childAfterMin > 0 ? childAfterMin : 0
  }

  // As duas janelas, já gravadas nos contadores. on = alguma está ligada.
  private windows(): { afterMin: number; childAfterMin: number; on: boolean } {
    const afterMin = this.effectiveAfterMin()
    const childAfterMin = this.effectiveChildAfterMin()
    this.stats.afterMin = afterMin
    this.stats.childAfterMin = childAfterMin
    return { afterMin, childAfterMin, on: afterMin > 0 || childAfterMin > 0 }
  }

  // Liga o tick com a hibernação geral (lazyRestore E afterMin > 0) ou com a
  // janela da filha concluída. Chamado no boot e quando qualquer uma das três
  // prefs muda.
  reschedule(): void {
    const { on } = this.windows()
    if (on && !this.timer) {
      this.timer = setInterval(
        () => void this.scheduledTick(),
        this.deps.tickMs ?? HIBERNATE_TICK_MS,
      )
      this.timer.unref?.()
    } else if (!on && this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  // No timer ninguém trata a rejeição: um dep que lança (banco fechando no quit)
  // vira aviso, e o próximo tick tenta de novo.
  private async scheduledTick(): Promise<void> {
    try {
      await this.tick()
    } catch (err) {
      this.deps.warn({ event: 'hibernate_tick_failed', error: String(err) })
    }
  }

  isScheduled(): boolean {
    return this.timer !== null
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    for (const p of this.pending.values()) this.clearTimers(p)
    this.pending.clear()
    for (const t of this.recentExits.values()) clearTimeout(t)
    this.recentExits.clear()
  }

  private clearTimers(p: Pending): void {
    if (p.timer) clearTimeout(p.timer)
    p.timer = null
  }

  async tick(): Promise<void> {
    const { afterMin, childAfterMin, on } = this.windows()
    if (!on || this.ticking) return
    this.ticking = true
    try {
      // Com CM_PERF=1 spans['hibernate.tick'] da sonda é só o gate. O que o tick
      // passa esperando tem span próprio: a resposta do renderer em
      // 'hibernate.confirm' e o /exit pela fila em 'hibernate.exit'.
      await perfSelfTime('hibernate.tick', (wait) => this.sweep(afterMin, childAfterMin, wait))
    } finally {
      this.ticking = false
    }
  }

  private async sweep(afterMin: number, childAfterMin: number, wait: PerfWait): Promise<void> {
    this.stats.lastTickAt = this.now()
    const handoffCc = new Set(this.deps.activeHandoffCcSessionIds())
    for (const candidate of this.deps.candidates()) {
      if (this.pending.has(candidate.sessionId)) continue
      const doneChild =
        childAfterMin > 0 && this.deps.handoffChildKind(candidate.ccSessionId) === 'done'
      const windowMin = doneChild ? childAfterMin : afterMin
      // Hibernação geral desligada: só a filha concluída é avaliada. O gate lê o
      // transcript inteiro, e isso não pode rodar para toda sessão viva.
      if (windowMin <= 0) continue
      perfCount('hibernate.evaluated')
      const verdict = await this.evaluate(candidate, windowMin * 60_000, handoffCc, doneChild)
      if (!verdict.ok) {
        this.refuse(verdict.reason)
        continue
      }
      // O open_panes tem debounce: a aba pode ter fechado depois do último save.
      // E a aba focada, ou com o Composer em uso, nunca hiberna.
      const check = await wait('hibernate.confirm', () =>
        this.deps.confirmPane(candidate.sessionId, candidate.ccSessionId),
      )
      const refusal = paneCheckRefusal(check, doneChild)
      if (refusal) {
        this.refuse(refusal)
        continue
      }
      await wait('hibernate.exit', () =>
        this.hibernate(candidate, doneChild ? null : (check?.paneId ?? null), doneChild),
      )
    }
  }

  // Gates H2 a-f, dos baratos para os caros. O primeiro que falha decide o motivo.
  // doneChild = filha de handoff concluído avaliada pela janela dela: dispensa a
  // pane (a) e passa pelo gate de filha (d).
  async evaluate(
    c: HibernateCandidate,
    windowMs: number,
    handoffCc: Set<string>,
    doneChild = false,
  ): Promise<GateVerdict> {
    const now = this.now()
    const refuse = (reason: HibernateRefusal): GateVerdict => ({ ok: false, reason })
    // a) pane acordada: sem ela a sessão não teria onde virar dormant.
    if (!doneChild && !this.deps.hasPane(c.ccSessionId)) return refuse('no-pane')
    // b) I/O no PTY (saída, escrita ou resize do app).
    const io = this.deps.lastIoAt(c.sessionId)
    if (io === null || now - io < windowMs) return refuse('io-recent')
    // c) status do próprio claude.
    const file = this.deps.sessionFile(c.ccSessionId)
    if (!file) return refuse('status-missing')
    if (!this.deps.isPidAlive(file)) return refuse('status-dead')
    if (this.deps.aliveSessionId(c.ccSessionId) !== c.sessionId) return refuse('status-dead')
    if (file.status !== 'idle') return refuse('status-not-idle')
    if (file.statusUpdatedAt === null || now - file.statusUpdatedAt < windowMs) {
      return refuse('status-recent')
    }
    // d) handoff ativo (mãe ou filha), filha de handoff avaliada fora da janela
    // dela (falhou, parou, ou a janela está desligada) e fila de prompts.
    if (handoffCc.has(c.ccSessionId)) return refuse('handoff')
    if (!doneChild && this.deps.handoffChildKind(c.ccSessionId) !== 'none') {
      return refuse('handoff-child')
    }
    if (this.deps.queueHas(c.sessionId)) return refuse('queue')
    // e) agendamento em qualquer ponto do transcript, ou trabalho em background
    // que o status 'idle' não conta (Monitor, teammate, task MCP) ainda aberto.
    const path = this.deps.transcriptPath(c.ccSessionId)
    if (!path) return refuse('no-transcript')
    const transcript = await this.deps.scanTranscript(path)
    if (transcript === null) return refuse('no-transcript')
    if (transcript === 'reading') return refuse('transcript-reading')
    if (transcript !== 'clear') return refuse(transcript)
    // f) nada rodando embaixo do claude.
    const tree = this.deps.procTree(file.pid)
    if (!tree.ok) return refuse('proc-tree')
    return { ok: true, pid: file.pid }
  }

  // H3: /exit pela fila on-idle, com a guarda dela. Só conta como em curso
  // se a fila escreveu agora; segurado/enfileirado/recusado = cancela e não hiberna.
  async hibernate(
    c: HibernateCandidate,
    paneId: string | null = null,
    child = false,
  ): Promise<boolean> {
    const pending: Pending = {
      ccSessionId: c.ccSessionId,
      paneId,
      child,
      delivered: false,
      inputSeen: false,
      held: '',
      queueId: null,
      holding: false,
      timer: null,
    }
    this.pending.set(c.sessionId, pending)
    let sent: SendPromptResult
    try {
      sent = await this.deps.send({
        sessionId: c.sessionId,
        text: EXIT_COMMAND,
        when: 'on-idle',
        ephemeral: true,
      })
    } catch (err) {
      this.deps.warn({ event: 'hibernate_send_failed', sessionId: c.sessionId, error: String(err) })
      sent = { ok: false, error: 'not-running' }
    }
    // O exit pode ter chegado durante o envio: já foi contado em onExit.
    if (this.pending.get(c.sessionId) !== pending) return sent.ok && sent.delivered
    if (!sent.ok || !sent.delivered) {
      if (sent.ok) this.deps.cancel(sent.queued.id)
      if (pending.delivered) this.unpersist(c.sessionId)
      this.pending.delete(c.sessionId)
      this.refuse('guard-held')
      this.deps.warn({
        event: 'hibernate_guard_held',
        sessionId: c.sessionId,
        reason: sent.ok ? 'queued' : sent.error,
      })
      return false
    }
    pending.delivered = true
    pending.timer = setTimeout(() => {
      pending.timer = null
      if (this.pending.get(c.sessionId) !== pending) return
      // A sessão continua viva: o input segurado segue no item da fila, que volta a
      // entregar nela mesma agora que isHibernating é false.
      this.forget(c.sessionId, pending)
      this.unpersist(c.sessionId)
      this.refuse('exit-timeout')
      this.deps.warn({ event: 'hibernate_exit_timeout', sessionId: c.sessionId })
    }, this.deps.exitTimeoutMs ?? EXIT_TIMEOUT_MS)
    pending.timer.unref?.()
    return true
  }

  private forget(sessionId: string, pending: Pending): void {
    this.clearTimers(pending)
    this.pending.delete(sessionId)
  }

  // Write do app no PTY (sessions:write). true = segurado: o chamador NÃO escreve.
  // Antes do /exit sair, só anota (o beforeWrite aborta o /exit). Depois, o exit que
  // vier ainda é o do /exit, e o texto iria para um claude saindo: vai para a fila
  // e é reentregue cru na sessão acordada.
  onUserInput(sessionId: string, data: string): boolean {
    const pending = this.pending.get(sessionId)
    if (!pending || isTerminalReport(data)) return false
    if (!pending.delivered) {
      pending.inputSeen = true
      return false
    }
    pending.held += data
    this.flushHeld(sessionId, pending)
    return true
  }

  private flushHeld(sessionId: string, pending: Pending): void {
    if (pending.queueId) {
      if (!this.deps.replaceText(pending.queueId, pending.held)) {
        this.deps.warn({ event: 'hibernate_held_input_lost', sessionId, reason: 'item-gone' })
      }
      return
    }
    // O send ainda não devolveu o id: o .then leva o que se acumulou até lá.
    if (pending.holding) return
    pending.holding = true
    const text = pending.held
    void this.deps
      .send({ sessionId, text, when: 'on-idle', raw: true })
      .catch((err: unknown): SendPromptResult => {
        this.deps.warn({ event: 'hibernate_held_send_failed', sessionId, error: String(err) })
        return { ok: false, error: 'not-running' }
      })
      .then((sent) => {
        pending.holding = false
        if (!sent.ok) {
          this.deps.warn({ event: 'hibernate_held_input_lost', sessionId, reason: sent.error })
          return
        }
        if (sent.delivered) return
        pending.queueId = sent.queued.id
        if (pending.held !== text) this.flushHeld(sessionId, pending)
      })
  }

  // A aba foi fechada pelo X com o /exit em curso: quem fechou não quer a pane de
  // volta, então o exit que vier é comum (sem dormant, sem contar hibernação). A
  // filha concluída não depende da pane: segue hibernando.
  onPaneClosed(sessionId: string): void {
    const pending = this.pending.get(sessionId)
    if (!pending || pending.child) return
    this.forget(sessionId, pending)
    if (pending.delivered) this.unpersist(sessionId)
    this.deps.warn({ event: 'hibernate_cancelled_by_close', sessionId })
  }

  // O exit desta PTY é (ou acabou de ser) o de uma hibernação que deixa pane
  // dormant para acordar. Vale antes e depois de onExit, para os ouvintes do exit
  // não dependerem da ordem de registro. A filha concluída dorme sem pane: para a
  // fila o exit dela é comum, e os itens esperam a conversa voltar.
  wasHibernatedExit(sessionId: string): boolean {
    const pending = this.pending.get(sessionId)
    return pending ? !pending.child : this.recentExits.has(sessionId)
  }

  // Exit de PTY: se era o /exit da hibernação, devolve o evento que o renderer
  // usa para converter a pane em dormant (em vez de fechar).
  onExit(sessionId: string): SessionHibernatedEvent | null {
    // Sem exigir delivered: o exit pode chegar antes de o send devolver.
    const pending = this.pending.get(sessionId)
    if (!pending) return null
    this.forget(sessionId, pending)
    if (!pending.child) {
      const recent = setTimeout(() => this.recentExits.delete(sessionId), RECENT_EXIT_MS)
      recent.unref?.()
      this.recentExits.set(sessionId, recent)
    }
    if (pending.paneId) this.deps.registerDormant(pending.ccSessionId, pending.paneId)
    this.stats.hibernated++
    this.deps.warn({
      event: 'session_hibernated',
      sessionId,
      ccSessionId: pending.ccSessionId,
      child: pending.child,
      total: this.stats.hibernated,
    })
    const event = { sessionId, ccSessionId: pending.ccSessionId, paneId: pending.paneId }
    return pending.child ? { ...event, child: true } : event
  }

  private refuse(reason: HibernateRefusal): void {
    this.stats.refused[reason]++
  }
}

// O que o xterm responde sozinho (foco, posição do cursor, atributos, cores) não é
// o usuário digitando: com focus reporting ligado, trocar de aba já escreve.
const TERMINAL_REPORT_RE =
  /^(?:\x1b\[[IO]|\x1b\[\??[\d;]*[Rcn]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\))+$/

export function isTerminalReport(data: string): boolean {
  return TERMINAL_REPORT_RE.test(data)
}

let current: IdleHibernator | null = null

export function setIdleHibernator(h: IdleHibernator | null): void {
  current = h
}

export function getIdleHibernator(): IdleHibernator | null {
  return current
}
