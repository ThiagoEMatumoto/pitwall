import { randomUUID } from 'node:crypto'
import type { LiveStatus, ScreenScan } from '../../../shared/tui/attention-reason'
import type {
  PromptQueueCounters,
  PromptQueueEvent,
  PromptQueueEventKind,
  PromptQueueSnapshot,
  QueuedPrompt,
  SendPromptError,
  SendPromptInput,
  SendPromptResult,
  SendPromptWhen,
} from '../../../shared/types/send-prompt'
import type { PersistedPrompt, PromptQueueStore, TranscriptProof } from './prompt-queue-store'
import { promptQueuePersistFailures } from './prompt-queue-store'

// Fila de prompts por sessão, entregues no fim do turno. A regra de segurança é
// uma só: só escrever com prova positiva de que a caixa de input está ociosa. O
// claude 2.1.286 grava 'idle' no fim de turno e às vezes ainda 'idle' com a
// permissão já aberta (o arquivo de status atrasa), e um menu que o parser não
// reconhece (drift da CLI) não aparece como menu — por isso a tela é relida na
// hora da entrega e nem o status nem a ausência de menu autorizam nada.

export const PROMPT_TTL_MS = 30 * 60_000
// Item que sobreviveu a um kill/reboot nunca expira: espera a conversa voltar a ter
// PTY (resume ou wake) ou a decisão do usuário. Até STALE_RESTORE_MS de idade ele é
// entregue sozinho — 15 min cobrem com folga um crash/kill -9 e reabrir o app.
// Mais velho que isso (noite, fim de semana, queda de energia longa), o usuário
// pode já ter reenviado à mão ou a instrução perdeu o contexto ('pode fazer o
// deploy'): vira 'needs-confirmation' e só sai com Enviar/Descartar.
export const STALE_RESTORE_MS = 15 * 60_000
// expiresAt de item restaurado parado: não expira (o número cabe no JSON do IPC).
const NEVER = Number.MAX_SAFE_INTEGER
// Espera depois da borda do fim de turno: a TUI termina de desenhar a tela.
export const SETTLE_MS = 400
// Rede de segurança pra borda perdida (índice de status sem watcher, flip rápido).
export const POLL_MS = 3_000
// Depois de uma entrega, a próxima espera o claude trabalhar (o status ainda diz
// idle por um instante). Se ele nunca trabalhar, a fila não fica presa por isto.
export const AWAIT_WORK_MS = 15_000
// Depois do write a linha segue 'delivering' no app.db até o transcript provar que a
// mensagem entrou na conversa. Achada a linha 'user', ela só sai do banco com a
// resposta do assistant gravada depois dela ou passada a janela de writeback do
// kernel: o claude não faz fsync do JSONL, e uma queda de energia antes disso
// apagaria a mensagem dos dois lados.
export const WRITEBACK_MS = 30_000
// Sem a linha 'user' depois disto, a entrega vira 'talvez não entregue' (visível,
// Reenviar/Descartar) em vez de sumir ou ser reenviada às cegas.
export const CONFIRM_GIVEUP_MS = 60_000

export interface PromptQueueDeps {
  isRunning(sessionId: string): boolean
  // null = sem arquivo de status (sessão subindo ou fora do índice).
  status(sessionId: string): LiveStatus | null
  // Tela relida agora. null = PTY sem espelho headless.
  screen(sessionId: string): Promise<ScreenScan | null>
  // false = o status vem só da PTY (Codex): nunca diz 'waiting', então não prova nada.
  nativeStatus(sessionId: string): boolean
  handoffAsking(sessionId: string): boolean
  write(sessionId: string, text: string): void
  // Escrita de fato no PTY (agora ou ao sair da fila) — nunca no enfileiramento.
  delivered?(sessionId: string, fromSessionId: string | undefined): void
  emit(snapshot: PromptQueueSnapshot): void
  warn(event: Record<string, unknown>): void
  now?(): number
  // Persistência (app.db). Sem store a fila é só memória (testes antigos).
  store?: PromptQueueStore
  // Envelope de handoff (wake da mãe / resposta à filha) restaurado cujos handoffs
  // já terminaram: chegaria fora de contexto, sai descartado (discardedObsolete).
  isObsolete?(id: string, text: string): boolean
  // A mensagem 'delivering' entrou na conversa (e a conversa andou depois dela)?
  // Usado no boot e na confirmação de cada entrega.
  deliveryProof?(ccSessionId: string | null, text: string, since: number): TranscriptProof
}

const NO_PROOF: TranscriptProof = { verdict: 'unknown', answered: false }

// Entrega escrita no PTY cuja linha ainda está no banco esperando a prova.
interface Confirming {
  item: Item
  deliveringAt: number
  foundAt: number | null
}

type Verdict =
  'deliver' | 'busy' | 'menu-open' | 'attention' | 'unparsed' | 'no-screen' | 'input-dirty'
type HoldVerdict = 'menu-open' | 'unparsed' | 'input-dirty'

export function deliveryVerdict(
  status: LiveStatus | null,
  scan: ScreenScan | null,
  handoffAsking: boolean,
  when: SendPromptWhen = 'on-idle',
): Verdict {
  if (!scan) return 'no-screen'
  // O menu cru, sem o filtro por status: com o arquivo atrasado o gate por status
  // esconderia justamente a permissão que o \r aprovaria.
  if (scan.menu) return 'menu-open'
  // 'now' aceita sessão trabalhando: o claude enfileira o que chega no input.
  if (when === 'on-idle' && status !== 'idle' && status !== 'waiting') return 'busy'
  if (handoffAsking) return 'attention'
  if (!scan.inputPrompt) return 'unparsed'
  // Rascunho do usuário na caixa: o paste + \r o enviaria. Espera ele limpar/enviar.
  if (scan.inputDirty) return 'input-dirty'
  return 'deliver'
}

// Sem espelho não há tela pra provar nada: 'now' só escreve se o status nativo não
// diz que a sessão está esperando você (permissão/pergunta no 2.1.286). Status da
// PTY (Codex) só conhece starting/working/idle: o overlay de aprovação parado parece
// 'idle' e o \r o aprovaria — recusa sempre.
function blindVerdict(
  status: LiveStatus | null,
  handoffAsking: boolean,
  nativeStatus: boolean,
): Verdict {
  if (handoffAsking) return 'attention'
  if (!nativeStatus) return 'no-screen'
  return status === 'waiting' ? 'no-screen' : 'deliver'
}

const REFUSAL: Partial<Record<Verdict, SendPromptError>> = {
  'menu-open': 'menu-open',
  attention: 'attention',
  unparsed: 'unparsed',
  'no-screen': 'no-screen',
  'input-dirty': 'input-dirty',
}

const isHold = (v: Verdict): v is HoldVerdict =>
  v === 'menu-open' || v === 'unparsed' || v === 'input-dirty'

interface Item extends QueuedPrompt {
  holding: boolean
  // Alvo de verdade de um item persistido: a conversa, que troca de sessions.id ao retomar.
  ccSessionId: string | null
  fromSessionId?: string
  bypassAttention?: boolean
  // Veio do app.db no boot: não expira, e velho demais pede confirmação.
  restored?: boolean
  // O usuário mandou enviar (Reenviar/Enviar): não pede confirmação de novo.
  confirmed?: boolean
  // O insert no app.db falhou: só existe em memória. Não é entregue até gravar
  // (tryDeliver retenta) — um kill depois do write não deixaria prova nenhuma.
  unpersisted?: boolean
  // Como saiu da fila: o send() que a criou lê isto depois dos awaits.
  outcome?: PromptQueueEventKind
}

export class PromptQueue {
  private items: Item[] = []
  private counters: PromptQueueCounters = {
    delivered: 0,
    expired: 0,
    sessionGone: 0,
    refusedMenuOpen: 0,
    refusedUnparsed: 0,
    refusedInputDirty: 0,
    wakeFailed: 0,
    restored: 0,
    restoredDelivered: 0,
    maybeUndelivered: 0,
    needsConfirmation: 0,
    discardedObsolete: 0,
  }
  // Itens de antes de um kill/reboot sem PTY viva da conversa ainda, e os
  // 'maybe-undelivered' que esperam o usuário decidir. Fora de `items` porque o
  // tick trataria o sessionId antigo (PTY morta) como session-gone.
  private parked: Item[] = []
  // No quit limpo as PTYs morrem por killAll: isso não é session-gone para o banco.
  private shuttingDown = false
  private lastEvent: PromptQueueEvent | null = null
  // sessionId → quando a última entrega saiu (espera o claude trabalhar).
  private awaitingWork = new Map<string, number>()
  private delivering = new Set<string>()
  private confirming: Confirming[] = []
  // Linhas que deviam ter saído do banco (cancelada, expirada, entregue com prova)
  // e cujo DELETE falhou: o tick retenta, senão o boot as traria de volta.
  private pendingRemoval = new Set<string>()
  private settleTimers = new Map<string, NodeJS.Timeout>()
  private poll: NodeJS.Timeout | null = null

  constructor(private deps: PromptQueueDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  // A filha em needs_input espera a resposta da mãe: a resposta a um pedido é
  // justamente o que ela aguarda, então não pode ficar presa no gate 'attention'
  // (com outro pedido aberto ela segue needs_input depois desta resposta). Decidido
  // pela flag de quem enfileira, não pelo texto: qualquer um digita '<pitwall-answer'.
  private askingFor(sessionId: string, bypassAttention: boolean | undefined): boolean {
    return !bypassAttention && this.deps.handoffAsking(sessionId)
  }

  snapshot(): PromptQueueSnapshot {
    return {
      items: [...this.items, ...this.parked].map(publicItem),
      counters: { ...this.counters, persistFailed: promptQueuePersistFailures() },
      lastEvent: this.lastEvent,
    }
  }

  async send(input: SendPromptInput): Promise<SendPromptResult> {
    const { sessionId, text, when, fromSessionId, bypassAttention } = input
    if (!this.deps.isRunning(sessionId)) return { ok: false, error: 'not-running' }
    const scan = await this.deps.screen(sessionId)
    if (when === 'now') return this.sendNow(sessionId, text, scan, fromSessionId, bypassAttention)
    if (!scan) return { ok: false, error: 'no-screen' }
    const item = this.enqueue(sessionId, text, fromSessionId, bypassAttention)
    const isHead = this.items.find((i) => i.sessionId === sessionId) === item
    if (isHead && (await this.tryDeliver(sessionId))) {
      return { ok: true, delivered: true }
    }
    // A PTY pode morrer (ou o item ser cancelado) durante a releitura da tela: sair
    // da fila não é entrega. O evento terminal já saiu antes de o chamador saber o id.
    if (item.outcome === 'delivered') return { ok: true, delivered: true }
    if (item.outcome === 'cancelled') return { ok: false, error: 'cancelled' }
    if (item.outcome) return { ok: false, error: 'not-running' }
    return { ok: true, delivered: false, queued: publicItem(item) }
  }

  private sendNow(
    sessionId: string,
    text: string,
    scan: ScreenScan | null,
    fromSessionId: string | undefined,
    bypassAttention: boolean | undefined,
  ): SendPromptResult {
    const status = this.deps.status(sessionId)
    const asking = this.askingFor(sessionId, bypassAttention)
    const verdict = scan
      ? deliveryVerdict(status, scan, asking, 'now')
      : blindVerdict(status, asking, this.deps.nativeStatus(sessionId))
    const error = REFUSAL[verdict]
    if (error) {
      this.countRefusal(sessionId, verdict)
      return { ok: false, error }
    }
    this.write(sessionId, text, fromSessionId)
    return { ok: true, delivered: true }
  }

  // Coalescing: troca o texto de um item que ainda não saiu. Seguro contra a
  // entrega em curso: tryDeliver lê head.text DEPOIS do await da tela, e write+finish
  // são síncronos — ou o texto novo sai, ou o item já saiu e isto devolve false.
  replaceText(id: string, text: string): boolean {
    const item = this.find(id)
    if (!item) return false
    // Sem o texto novo no banco, um kill entregaria o velho: quem chama faz outro item.
    if (!item.unpersisted && !this.persist(id, 'updateText', (st) => st.updateText(id, text))) {
      return false
    }
    item.text = text
    this.publish()
    return true
  }

  cancel(id: string): boolean {
    const item = this.find(id)
    if (!item) return false
    this.finish(item, 'cancelled')
    return true
  }

  // "Talvez não entregue — reenviar?": o usuário decidiu reenviar. Volta a ser um
  // item normal da conversa; sem PTY viva, espera o resume como os outros.
  resend(id: string): boolean {
    const item = this.parked.find(
      (i) => i.id === id && i.recovery && i.recovery !== 'awaiting-session',
    )
    if (!item) return false
    this.persist(id, 'setState', (st) => st.setState(id, 'queued'))
    item.recovery = 'awaiting-session'
    item.confirmed = true
    if (this.deps.isRunning(item.sessionId)) this.attach([item], item.sessionId)
    else this.publish()
    return true
  }

  // Quit limpo: as PTYs vão morrer por killAll e a fila não deve apagar do banco o
  // que estava esperando — o próximo boot reentrega quando a conversa voltar.
  suspendForShutdown(): void {
    this.shuttingDown = true
    this.dispose()
  }

  // Boot, antes do restore(): o que vai voltar do app.db. Quem acompanha os itens
  // (ledger de handoff) se reidrata com isto antes de o restore publicar desfechos.
  restorable(): Array<{ id: string; text: string }> {
    try {
      return this.deps.store?.loadAll().map((r) => ({ id: r.id, text: r.text })) ?? []
    } catch (err) {
      this.deps.warn({ event: 'prompt_queue_load_failed', detail: String(err) })
      return []
    }
  }

  // Boot: carrega o que o processo anterior aceitou e não terminou. 'delivering'
  // nunca é reenviado às cegas: o transcript da conversa decide (ver
  // reconcileDelivering). Chamado uma vez, antes de qualquer PTY subir.
  restore(): void {
    const store = this.deps.store
    if (!store) return
    let rows: PersistedPrompt[]
    try {
      rows = store.loadAll()
    } catch (err) {
      // Banco ilegível: a fila nasce vazia em vez de derrubar o registro do IPC.
      this.deps.warn({ event: 'prompt_queue_load_failed', detail: String(err) })
      return
    }
    for (const row of rows) {
      const item = fromRow(row, row.ccSessionId ?? store.ccSessionOf(row.sessionId))
      this.counters.restored++
      this.parked = [...this.parked, item]
      if (this.discardIfObsolete(item)) continue
      if (row.state === 'delivering') this.reconcileDelivering(item, row)
      if (item.outcome) continue
      if (item.recovery === 'awaiting-session' && this.isStale(item)) {
        this.markNeedsConfirmation(item)
      }
    }
    if (this.parked.length > 0) this.ensurePoll()
    this.publish()
  }

  // Conversas dormindo com item que pode sair sozinho: quem chama (send-prompt)
  // acorda a pane, e o spawn traz o item por onSessionLive.
  wakeTargets(): string[] {
    const ccs = this.parked
      .filter((i) => i.recovery === 'awaiting-session' && !this.isStale(i) && i.ccSessionId)
      .map((i) => i.ccSessionId as string)
    return [...new Set(ccs)]
  }

  // O wake da conversa falhou: os itens dela ficam visíveis em vez de esperar
  // calados por um resume que pode não vir.
  surfaceTarget(ccSessionId: string): void {
    const mine = this.parked.filter(
      (i) => i.ccSessionId === ccSessionId && i.recovery === 'awaiting-session',
    )
    for (const item of mine) this.markNeedsConfirmation(item)
    if (mine.length > 0) this.publish()
  }

  private isStale(item: Item): boolean {
    return !!item.restored && !item.confirmed && this.now() - item.createdAt > STALE_RESTORE_MS
  }

  private discardIfObsolete(item: Item): boolean {
    if (!this.deps.isObsolete?.(item.id, item.text)) return false
    this.counters.discardedObsolete++
    this.deps.warn({
      event: 'prompt_queue_discarded_obsolete',
      id: item.id,
      total: this.counters.discardedObsolete,
    })
    this.finish(item, 'cancelled')
    return true
  }

  private markNeedsConfirmation(item: Item): void {
    item.recovery = 'needs-confirmation'
    item.expiresAt = NEVER
    if (!this.parked.includes(item)) {
      this.items = this.items.filter((i) => i !== item)
      this.parked = [...this.parked, item]
    }
    this.counters.needsConfirmation++
    this.deps.warn({
      event: 'prompt_queue_needs_confirmation',
      sessionId: item.sessionId,
      id: item.id,
    })
  }

  // Uma PTY nova da conversa `ccSessionId` (spawn/resume/wake): os itens dela que
  // sobreviveram ao boot passam a mirar esta PTY. Os 'maybe-undelivered' só são
  // reapontados — continuam esperando o usuário.
  onSessionLive(sessionId: string, ccSessionId: string | null): void {
    if (!ccSessionId) return
    const mine = this.parked.filter((i) => i.ccSessionId === ccSessionId)
    if (mine.length === 0) return
    const kept = mine.filter((i) => !this.discardIfObsolete(i))
    for (const item of kept) {
      this.persist(item.id, 'rebind', (st) => st.rebind(item.id, sessionId))
      item.sessionId = sessionId
      // Esperou a conversa voltar até ficar velho: pergunta antes de entregar.
      if (item.recovery === 'awaiting-session' && this.isStale(item)) {
        this.markNeedsConfirmation(item)
      }
    }
    this.attach(
      kept.filter((i) => i.recovery === 'awaiting-session'),
      sessionId,
    )
  }

  private attach(items: Item[], sessionId: string): void {
    const now = this.now()
    for (const item of items) {
      item.recovery = undefined
      item.sessionId = sessionId
      item.expiresAt = now + PROMPT_TTL_MS
    }
    this.parked = this.parked.filter((i) => !items.includes(i))
    // Antes dos que chegaram depois do boot: a ordem de aceite se mantém.
    this.items = [...items, ...this.items]
    this.ensurePoll()
    this.publish()
  }

  private reconcileDelivering(item: Item, row: PersistedPrompt): void {
    const since = row.deliveringAt ?? row.createdAt
    const { verdict } = this.deps.deliveryProof?.(item.ccSessionId, item.text, since) ?? NO_PROOF
    if (verdict === 'found') {
      this.counters.restoredDelivered++
      this.finish(item, 'delivered')
      return
    }
    if (verdict === 'absent') {
      this.persist(item.id, 'setState', (st) => st.setState(item.id, 'queued'))
      return
    }
    this.persist(item.id, 'setState', (st) => st.setState(item.id, 'uncertain'))
    this.markMaybeUndelivered(item)
  }

  private markMaybeUndelivered(item: Item): void {
    item.recovery = 'maybe-undelivered'
    this.counters.maybeUndelivered++
    this.deps.warn({
      event: 'prompt_queue_maybe_undelivered',
      sessionId: item.sessionId,
      id: item.id,
    })
    this.lastEvent = {
      kind: 'maybe-undelivered',
      id: item.id,
      sessionId: item.sessionId,
      text: item.text,
      at: this.now(),
    }
  }

  private find(id: string): Item | undefined {
    return this.items.find((i) => i.id === id) ?? this.parked.find((i) => i.id === id)
  }

  // Borda working → idle/waiting de uma PTY com mensagem na fila.
  onTurnEnded(sessionId: string): void {
    this.awaitingWork.delete(sessionId)
    this.confirmDeliveries(sessionId)
    if (!this.items.some((i) => i.sessionId === sessionId)) return
    const prev = this.settleTimers.get(sessionId)
    if (prev) clearTimeout(prev)
    this.settleTimers.set(
      sessionId,
      setTimeout(() => {
        this.settleTimers.delete(sessionId)
        void this.tryDeliver(sessionId)
      }, SETTLE_MS),
    )
  }

  onSessionExit(sessionId: string): void {
    this.awaitingWork.delete(sessionId)
    for (const item of this.items.filter((i) => i.sessionId === sessionId)) {
      this.finish(item, 'session-gone')
    }
  }

  dispose(): void {
    if (this.poll) clearInterval(this.poll)
    this.poll = null
    for (const t of this.settleTimers.values()) clearTimeout(t)
    this.settleTimers.clear()
  }

  private enqueue(
    sessionId: string,
    text: string,
    fromSessionId?: string,
    bypassAttention?: boolean,
  ): Item {
    const createdAt = this.now()
    const store = this.deps.store
    const item: Item = {
      id: randomUUID(),
      sessionId,
      ccSessionId: this.ccSessionOf(sessionId),
      text,
      createdAt,
      expiresAt: createdAt + PROMPT_TTL_MS,
      heldByMenu: 0,
      heldReason: null,
      holding: false,
      fromSessionId,
      bypassAttention,
    }
    // Grava ANTES de existir na fila. Se o banco falhar, o item fica só em memória
    // e não é entregue até o insert passar (tryDeliver retenta; persistFailed conta).
    if (store && !this.insertRow(item)) item.unpersisted = true
    this.items = [...this.items, item]
    this.ensurePoll()
    this.publish()
    return item
  }

  private ccSessionOf(sessionId: string): string | null {
    try {
      return this.deps.store?.ccSessionOf(sessionId) ?? null
    } catch {
      return null
    }
  }

  private insertRow(item: Item): boolean {
    return this.persist(item.id, 'insert', (st) =>
      st.insert({
        id: item.id,
        sessionId: item.sessionId,
        ccSessionId: item.ccSessionId,
        text: item.text,
        fromSessionId: item.fromSessionId ?? null,
        bypassAttention: item.bypassAttention === true,
        state: 'queued',
        createdAt: item.createdAt,
        deliveringAt: null,
      }),
    )
  }

  // Uma escrita no app.db. false = falhou (o store já contou em persistFailed):
  // quem chama não segue como se estivesse gravado. Sem store, nada a gravar.
  private persist(id: string, op: string, write: (store: PromptQueueStore) => void): boolean {
    const store = this.deps.store
    if (!store) return true
    try {
      write(store)
      return true
    } catch (err) {
      this.deps.warn({ event: 'prompt_queue_persist_failed', op, id, detail: String(err) })
      return false
    }
  }

  private removeRow(id: string): void {
    if (this.persist(id, 'remove', (st) => st.remove(id))) {
      this.pendingRemoval.delete(id)
      return
    }
    this.pendingRemoval.add(id)
    this.ensurePoll()
  }

  private retryRemovals(): void {
    for (const id of [...this.pendingRemoval]) this.removeRow(id)
  }

  private write(sessionId: string, text: string, fromSessionId?: string): void {
    this.deps.write(sessionId, text)
    this.awaitingWork.set(sessionId, this.now())
    this.deps.delivered?.(sessionId, fromSessionId)
  }

  // Entrega a PRIMEIRA mensagem da sessão se a tela provar que pode. Uma por turno:
  // a entrega começa outro turno, e a próxima espera ele terminar.
  private async tryDeliver(sessionId: string): Promise<boolean> {
    if (this.delivering.has(sessionId)) return false
    const since = this.awaitingWork.get(sessionId)
    if (since != null && this.now() - since < AWAIT_WORK_MS) return false
    const head = this.items.find((i) => i.sessionId === sessionId)
    if (!head) return false
    this.delivering.add(sessionId)
    try {
      if (!this.deps.isRunning(sessionId)) {
        this.onSessionExit(sessionId)
        return false
      }
      const scan = await this.deps.screen(sessionId)
      const verdict = deliveryVerdict(
        this.deps.status(sessionId),
        scan,
        this.askingFor(sessionId, head.bypassAttention),
      )
      // A mensagem pode ter sido cancelada enquanto a tela era relida.
      if (!this.items.includes(head)) return false
      if (isHold(verdict)) {
        this.hold(head, verdict)
        return false
      }
      if (head.holding) {
        head.holding = false
        head.heldReason = null
        this.publish()
      }
      if (verdict !== 'deliver') return false
      // Sem o registro durável não entrega: retenta o insert agora, e no próximo
      // fim de turno/poll se falhar de novo.
      if (head.unpersisted) {
        if (!this.insertRow(head)) return false
        head.unpersisted = false
      }
      // 'delivering' durável ANTES do write, e a linha só sai do banco com prova no
      // transcript (confirmDeliveries): um kill ou queda de energia antes de o claude
      // gravar a mensagem deixa o boot conferir em vez de perdê-la ou reenviá-la às cegas.
      const deliveringAt = this.now()
      if (!this.markDelivering(head, deliveringAt)) return false
      this.write(sessionId, head.text, head.fromSessionId)
      const keepRow = this.deps.store != null
      if (keepRow) {
        this.confirming = [...this.confirming, { item: head, deliveringAt, foundAt: null }]
        this.ensurePoll()
      }
      this.finish(head, 'delivered', keepRow)
      return true
    } finally {
      this.delivering.delete(sessionId)
    }
  }

  // Uma contagem por motivo contínuo: segue segurada pelo mesmo motivo = não conta de novo.
  private hold(item: Item, verdict: HoldVerdict): void {
    if (item.holding && item.heldReason === verdict) return
    item.holding = true
    item.heldReason = verdict
    if (verdict === 'menu-open') item.heldByMenu++
    this.countRefusal(item.sessionId, verdict)
    this.publish()
  }

  private countRefusal(sessionId: string, verdict: Verdict): void {
    if (verdict === 'menu-open') {
      this.counters.refusedMenuOpen++
      this.deps.warn({
        event: 'prompt_queue_menu_open',
        sessionId,
        total: this.counters.refusedMenuOpen,
      })
    }
    if (verdict === 'input-dirty') {
      this.counters.refusedInputDirty++
      this.deps.warn({
        event: 'prompt_queue_input_dirty',
        sessionId,
        total: this.counters.refusedInputDirty,
      })
    }
    if (verdict === 'unparsed') {
      this.counters.refusedUnparsed++
      this.deps.warn({
        event: 'prompt_queue_unparsed',
        sessionId,
        total: this.counters.refusedUnparsed,
      })
    }
  }

  // Sem a marca não há como provar no boot o que aconteceu: não escreve agora (o
  // item segue na fila e é retentado).
  private markDelivering(item: Item, at: number): boolean {
    return this.persist(item.id, 'markDelivering', (st) => st.markDelivering(item.id, at))
  }

  // keepRow: a entrega saiu da fila mas a linha espera a prova (confirmDeliveries).
  private finish(item: Item, kind: PromptQueueEventKind, keepRow = false): void {
    item.outcome = kind
    this.items = this.items.filter((i) => i !== item)
    this.parked = this.parked.filter((i) => i !== item)
    if (!this.shuttingDown && !keepRow && !item.unpersisted) this.removeRow(item.id)
    if (kind === 'delivered') this.counters.delivered++
    if (kind === 'expired') this.counters.expired++
    if (kind === 'session-gone') this.counters.sessionGone++
    if (kind === 'expired' || kind === 'session-gone') {
      this.deps.warn({ event: `prompt_queue_${kind}`, sessionId: item.sessionId })
    }
    this.lastEvent = {
      kind,
      id: item.id,
      sessionId: item.sessionId,
      text: item.text,
      at: this.now(),
    }
    this.disposeIfIdle()
    this.publish()
  }

  private disposeIfIdle(): void {
    const open = this.items.length + this.parked.length + this.confirming.length
    if (open + this.pendingRemoval.size === 0) this.dispose()
  }

  // Confere no transcript as entregas escritas no PTY (fim de turno e poll). A
  // linha do banco só sai com prova; sem prova até CONFIRM_GIVEUP_MS, o item volta
  // visível como 'talvez não entregue'.
  private confirmDeliveries(sessionId?: string): void {
    const now = this.now()
    const mine = this.confirming.filter((c) => !sessionId || c.item.sessionId === sessionId)
    for (const c of mine) {
      const { item } = c
      // Sem conversa nativa (Codex) não há transcript: sai depois do writeback.
      if (!item.ccSessionId) {
        if (now - c.deliveringAt >= WRITEBACK_MS) this.settleConfirmed(c)
        continue
      }
      const proof =
        this.deps.deliveryProof?.(item.ccSessionId, item.text, c.deliveringAt) ?? NO_PROOF
      if (proof.verdict === 'found') {
        c.foundAt ??= now
        if (proof.answered || now - c.foundAt >= WRITEBACK_MS) this.settleConfirmed(c)
        continue
      }
      if (now - c.deliveringAt >= CONFIRM_GIVEUP_MS) this.unconfirmed(c)
    }
  }

  private settleConfirmed(c: Confirming): void {
    this.confirming = this.confirming.filter((x) => x !== c)
    // Falhou: fica 'delivering' até o retry (o boot confere no transcript, sem duplicata).
    this.removeRow(c.item.id)
    this.disposeIfIdle()
  }

  private unconfirmed(c: Confirming): void {
    this.confirming = this.confirming.filter((x) => x !== c)
    const { item } = c
    this.persist(item.id, 'setState', (st) => st.setState(item.id, 'uncertain'))
    item.outcome = undefined
    item.expiresAt = NEVER
    this.parked = [...this.parked, item]
    this.markMaybeUndelivered(item)
    this.publish()
  }

  // O wake da sessão dormindo é de quem chama (send-prompt); o contador fica aqui,
  // junto dos outros que o snapshot já leva ao renderer.
  recordWakeFailed(sessionId: string, detail: string): void {
    this.counters.wakeFailed++
    this.deps.warn({
      event: 'prompt_queue_wake_failed',
      sessionId,
      detail,
      total: this.counters.wakeFailed,
    })
    this.publish()
  }

  private publish(): void {
    this.deps.emit(this.snapshot())
  }

  private ensurePoll(): void {
    if (this.poll) return
    this.poll = setInterval(() => void this.tick(), POLL_MS)
    this.poll.unref?.()
  }

  private async tick(): Promise<void> {
    this.retryRemovals()
    this.confirmDeliveries()
    const now = this.now()
    // Parados (restaurados, talvez-não-entregues) não expiram. Restaurado que não
    // sai em PROMPT_TTL_MS com a conversa viva volta a pedir confirmação.
    for (const item of this.items.filter((i) => i.expiresAt <= now)) {
      if (item.restored) {
        this.markNeedsConfirmation(item)
        this.publish()
      } else {
        this.finish(item, 'expired')
      }
    }
    const sessions = [...new Set(this.items.map((i) => i.sessionId))]
    for (const sessionId of sessions) {
      if (this.deps.status(sessionId) === 'working') {
        this.awaitingWork.delete(sessionId)
        continue
      }
      await this.tryDeliver(sessionId)
    }
  }
}

function publicItem({
  holding: _h,
  outcome: _o,
  fromSessionId: _f,
  bypassAttention: _b,
  ccSessionId: _c,
  restored: _r,
  confirmed: _k,
  unpersisted: _p,
  ...q
}: Item): QueuedPrompt {
  return q
}

function fromRow(row: PersistedPrompt, ccSessionId: string | null): Item {
  return {
    id: row.id,
    sessionId: row.sessionId,
    ccSessionId,
    text: row.text,
    createdAt: row.createdAt,
    expiresAt: NEVER,
    heldByMenu: 0,
    heldReason: null,
    recovery: row.state === 'uncertain' ? 'maybe-undelivered' : 'awaiting-session',
    holding: false,
    fromSessionId: row.fromSessionId ?? undefined,
    bypassAttention: row.bypassAttention || undefined,
    restored: true,
  }
}
