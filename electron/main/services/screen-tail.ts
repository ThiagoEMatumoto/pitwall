import type { IBufferCell, Terminal as HeadlessTerminal } from '@xterm/headless'
import { inputBoxRows } from '../../../shared/tui/attention-reason'
import { stripTailChrome } from '../../../shared/tui/tail-chrome'
import type {
  ScreenTailLine,
  ScreenTailSegment,
  ScreenTailUpdate,
} from '../../../shared/types/send-prompt'

// Saída ao vivo dos cartões abertos do mapa: o fim da tela do espelho headless
// (tui-menu-watch), com as cores de primeiro plano, empurrado só para quem
// assinou e só quando muda. Um xterm por cartão no renderer custaria um parser
// ANSI + DOM por sessão; aqui a emulação já existe.

export const TAIL_THROTTLE_MS = 400
export const MAX_TAIL_SUBSCRIPTIONS = 25

type Fg = ScreenTailSegment['fg']

function fgOf(cell: IBufferCell): Fg {
  if (cell.isFgDefault()) return undefined
  const color = cell.getFgColor()
  if (cell.isFgRGB()) return `#${color.toString(16).padStart(6, '0')}`
  return color
}

function sameStyle(seg: ScreenTailSegment, fg: Fg, bold: boolean, dim: boolean): boolean {
  return seg.fg === fg && !!seg.b === bold && !!seg.d === dim
}

function segmentsOf(term: HeadlessTerminal, y: number): ScreenTailLine {
  const line = term.buffer.active.getLine(y)
  if (!line) return []
  const out: ScreenTailSegment[] = []
  for (let x = 0; x < line.length; x++) {
    const cell = line.getCell(x)
    // Largura 0 = metade direita de um caractere largo: o texto já veio na esquerda.
    if (!cell || cell.getWidth() === 0) continue
    const text = cell.getChars() || ' '
    const fg = fgOf(cell)
    const bold = cell.isBold() !== 0
    const dim = cell.isDim() !== 0
    const last = out[out.length - 1]
    if (last && sameStyle(last, fg, bold, dim)) {
      last.t += text
      continue
    }
    out.push({
      t: text,
      ...(fg !== undefined ? { fg } : {}),
      ...(bold ? { b: true } : {}),
      ...(dim ? { d: true } : {}),
    })
  }
  while (out.length > 0) {
    const last = out[out.length - 1]
    last.t = last.t.trimEnd()
    if (last.t !== '') break
    out.pop()
  }
  return out
}

// Últimas `n` linhas da TELA (não do scrollback), sem moldura (réguas, prompt
// vazio, brancos repetidos — tail-chrome.ts). A caixa de input do claude e o
// rodapé abaixo dela saem: são ~6 das últimas 12 linhas, e o cartão já tem a
// própria barra de prompt (o rascunho não enviado vira aviso nela, pelo inputDirty).
export function readStyledTail(term: HeadlessTerminal, n: number): ScreenTailLine[] {
  const buf = term.buffer.active
  const first = Math.max(0, buf.length - term.rows)
  const plain: string[] = []
  const lines: ScreenTailLine[] = []
  for (let y = first; y < buf.length; y++) {
    plain.push(buf.getLine(y)?.translateToString(true) ?? '')
    lines.push(segmentsOf(term, y))
  }
  const box = inputBoxRows(plain)
  const end = box ? Math.max(0, box.start - 1) : lines.length
  // A moldura sai ANTES de cortar as últimas n: senão réguas e prompt vazio
  // ocupavam metade das linhas que o cartão mostra.
  const rows = lines.slice(0, end).map((line, i) => ({ line, text: plain[i] }))
  return stripTailChrome(rows, (r) => r.text, { line: [], text: '' })
    .map((r) => r.line)
    .slice(-n)
}

export type TailSnapshot = Omit<ScreenTailUpdate, 'sessionId'>

export interface ScreenTailFeedOptions {
  read: (sessionId: string) => Promise<TailSnapshot | null>
  send: (subscriber: number, update: ScreenTailUpdate) => void
  throttleMs?: number
  cap?: number
}

interface SessionClock {
  timer: NodeJS.Timeout | null
  lastReadAt: number
}

// Quem assina é o renderer (webContents.id); o que ele assina é a lista inteira
// de cartões abertos E visíveis — cada chamada substitui a anterior.
export class ScreenTailFeed {
  private subs = new Map<number, Set<string>>()
  // Último payload enviado a cada assinante, por sessão: "só quando muda".
  private sent = new Map<number, Map<string, string>>()
  private clocks = new Map<string, SessionClock>()
  private readonly throttleMs: number
  private readonly cap: number

  constructor(private readonly opts: ScreenTailFeedOptions) {
    this.throttleMs = opts.throttleMs ?? TAIL_THROTTLE_MS
    this.cap = opts.cap ?? MAX_TAIL_SUBSCRIPTIONS
  }

  subscribe(subscriber: number, sessionIds: string[]): void {
    const next = new Set(sessionIds.slice(0, this.cap))
    const prev = this.subs.get(subscriber) ?? new Set<string>()
    const sent = this.sent.get(subscriber) ?? new Map<string, string>()
    // Quem saiu e voltar depois recebe a tela de novo, mesmo sem mudança.
    for (const id of prev) if (!next.has(id)) sent.delete(id)
    this.subs.set(subscriber, next)
    this.sent.set(subscriber, sent)
    for (const id of next) if (!prev.has(id)) this.schedule(id)
    this.releaseUnwatched()
  }

  drop(subscriber: number): void {
    this.subs.delete(subscriber)
    this.sent.delete(subscriber)
    this.releaseUnwatched()
  }

  onData(sessionId: string): void {
    if (this.watched(sessionId)) this.schedule(sessionId)
  }

  onExit(sessionId: string): void {
    this.clear(sessionId)
    for (const sent of this.sent.values()) sent.delete(sessionId)
  }

  subscribedCount(subscriber: number): number {
    return this.subs.get(subscriber)?.size ?? 0
  }

  private watched(sessionId: string): boolean {
    for (const ids of this.subs.values()) if (ids.has(sessionId)) return true
    return false
  }

  private releaseUnwatched(): void {
    for (const id of [...this.clocks.keys()]) if (!this.watched(id)) this.clear(id)
  }

  private clear(sessionId: string): void {
    const clock = this.clocks.get(sessionId)
    if (clock?.timer) clearTimeout(clock.timer)
    this.clocks.delete(sessionId)
  }

  // Throttle por sessão: no máximo uma leitura a cada throttleMs, e a rajada que
  // chega no meio cai na leitura agendada (nunca é perdida).
  private schedule(sessionId: string): void {
    const clock = this.clocks.get(sessionId) ?? { timer: null, lastReadAt: -Infinity }
    this.clocks.set(sessionId, clock)
    if (clock.timer) return
    const wait = Math.max(0, clock.lastReadAt + this.throttleMs - Date.now())
    clock.timer = setTimeout(() => {
      clock.timer = null
      clock.lastReadAt = Date.now()
      void this.flush(sessionId)
    }, wait)
  }

  private async flush(sessionId: string): Promise<void> {
    let snapshot: TailSnapshot | null
    try {
      snapshot = await this.opts.read(sessionId)
    } catch (err) {
      console.warn('[screen-tail] leitura falhou', sessionId, err)
      return
    }
    if (!snapshot) return
    const key = JSON.stringify(snapshot)
    for (const [subscriber, ids] of this.subs) {
      if (!ids.has(sessionId)) continue
      const sent = this.sent.get(subscriber)!
      if (sent.get(sessionId) === key) continue
      sent.set(sessionId, key)
      this.opts.send(subscriber, { sessionId, ...snapshot })
    }
  }
}
