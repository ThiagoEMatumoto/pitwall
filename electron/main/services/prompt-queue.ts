import { randomUUID } from 'node:crypto'
import type { LiveStatus, ScreenScan } from '../../../shared/tui/attention-reason'
import { isHandoffAnswerEnvelope } from '../../../shared/handoff-answer-envelope'
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

// Fila de prompts por sessão, entregues no fim do turno. A regra de segurança é
// uma só: só escrever com prova positiva de que a caixa de input está ociosa. O
// claude 2.1.286 grava 'idle' no fim de turno e às vezes ainda 'idle' com a
// permissão já aberta (o arquivo de status atrasa), e um menu que o parser não
// reconhece (drift da CLI) não aparece como menu — por isso a tela é relida na
// hora da entrega e nem o status nem a ausência de menu autorizam nada.

export const PROMPT_TTL_MS = 30 * 60_000
// Espera depois da borda do fim de turno: a TUI termina de desenhar a tela.
export const SETTLE_MS = 400
// Rede de segurança pra borda perdida (índice de status sem watcher, flip rápido).
export const POLL_MS = 3_000
// Depois de uma entrega, a próxima espera o claude trabalhar (o status ainda diz
// idle por um instante). Se ele nunca trabalhar, a fila não fica presa por isto.
export const AWAIT_WORK_MS = 15_000

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
}

type Verdict =
  | 'deliver'
  | 'busy'
  | 'menu-open'
  | 'attention'
  | 'unparsed'
  | 'no-screen'
  | 'input-dirty'
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
  fromSessionId?: string
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
  }
  private lastEvent: PromptQueueEvent | null = null
  // sessionId → quando a última entrega saiu (espera o claude trabalhar).
  private awaitingWork = new Map<string, number>()
  private delivering = new Set<string>()
  private settleTimers = new Map<string, NodeJS.Timeout>()
  private poll: NodeJS.Timeout | null = null

  constructor(private deps: PromptQueueDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  // A filha em needs_input espera a resposta da mãe: a <pitwall-answer> é
  // justamente o que ela aguarda, então não pode ficar presa no gate 'attention'
  // (com outro pedido aberto ela segue needs_input depois desta resposta).
  private askingFor(sessionId: string, text: string): boolean {
    return !isHandoffAnswerEnvelope(text) && this.deps.handoffAsking(sessionId)
  }

  snapshot(): PromptQueueSnapshot {
    return {
      items: this.items.map(({ holding: _h, outcome: _o, fromSessionId: _f, ...q }) => q),
      counters: { ...this.counters },
      lastEvent: this.lastEvent,
    }
  }

  async send(input: SendPromptInput): Promise<SendPromptResult> {
    const { sessionId, text, when, fromSessionId } = input
    if (!this.deps.isRunning(sessionId)) return { ok: false, error: 'not-running' }
    const scan = await this.deps.screen(sessionId)
    if (when === 'now') return this.sendNow(sessionId, text, scan, fromSessionId)
    if (!scan) return { ok: false, error: 'no-screen' }
    const item = this.enqueue(sessionId, text, fromSessionId)
    const isHead = this.items.find((i) => i.sessionId === sessionId) === item
    if (isHead && (await this.tryDeliver(sessionId))) {
      return { ok: true, delivered: true }
    }
    // A PTY pode morrer (ou o item ser cancelado) durante a releitura da tela: sair
    // da fila não é entrega. O evento terminal já saiu antes de o chamador saber o id.
    if (item.outcome === 'delivered') return { ok: true, delivered: true }
    if (item.outcome === 'cancelled') return { ok: false, error: 'cancelled' }
    if (item.outcome) return { ok: false, error: 'not-running' }
    const { holding: _h, outcome: _o, fromSessionId: _f, ...rest } = item
    return { ok: true, delivered: false, queued: rest }
  }

  private sendNow(
    sessionId: string,
    text: string,
    scan: ScreenScan | null,
    fromSessionId: string | undefined,
  ): SendPromptResult {
    const status = this.deps.status(sessionId)
    const asking = this.askingFor(sessionId, text)
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
    const item = this.items.find((i) => i.id === id)
    if (!item) return false
    item.text = text
    this.publish()
    return true
  }

  cancel(id: string): boolean {
    const item = this.items.find((i) => i.id === id)
    if (!item) return false
    this.finish(item, 'cancelled')
    return true
  }

  // Borda working → idle/waiting de uma PTY com mensagem na fila.
  onTurnEnded(sessionId: string): void {
    this.awaitingWork.delete(sessionId)
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

  private enqueue(sessionId: string, text: string, fromSessionId?: string): Item {
    const createdAt = this.now()
    const item: Item = {
      id: randomUUID(),
      sessionId,
      text,
      createdAt,
      expiresAt: createdAt + PROMPT_TTL_MS,
      heldByMenu: 0,
      heldReason: null,
      holding: false,
      fromSessionId,
    }
    this.items = [...this.items, item]
    this.ensurePoll()
    this.publish()
    return item
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
        this.askingFor(sessionId, head.text),
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
      this.write(sessionId, head.text, head.fromSessionId)
      this.finish(head, 'delivered')
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

  private finish(item: Item, kind: PromptQueueEventKind): void {
    item.outcome = kind
    this.items = this.items.filter((i) => i !== item)
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
    if (this.items.length === 0) this.dispose()
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
    const now = this.now()
    for (const item of this.items.filter((i) => i.expiresAt <= now)) this.finish(item, 'expired')
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
