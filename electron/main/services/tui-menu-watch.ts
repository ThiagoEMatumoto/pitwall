import xtermHeadless from '@xterm/headless'
import { EventEmitter } from 'node:events'
import {
  isUnparsedWaiting,
  scanScreen,
  type LiveStatus,
  type ScreenScan,
} from '../../../shared/tui/attention-reason'
import { buildOtherKeys, buildSelectKeys, playKeys } from '../../../shared/tui/respond-keys'
import { menuFingerprint, type TuiMenu } from '../../../shared/tui/tui-menu-parser'
import type {
  AttentionAction,
  AttentionMenuSnapshot,
  AttentionReasonCounters,
  AttentionRespondInput,
  AttentionRespondResult,
} from '../../../shared/types/ipc'
import type { PtyDataEvent, PtyExitEvent, PtySizeEvent } from './pty-manager'

// Espelho headless da tela de cada PTY viva, no main. O parser de menu só rodava
// dentro do Terminal.tsx montado — e a fila de atenção existe justamente pra
// trazer as sessões SEM pane. Aqui cada PTY ganha um xterm headless (mesma
// família do @xterm/xterm do renderer, mesma emulação de ANSI), alimentado pelos
// mesmos bytes do backlog, e o parser roda só depois que a saída assenta.

// CJS sem named exports detectáveis pelo Node ESM: só o default resolve.
const { Terminal } = xtermHeadless as unknown as {
  Terminal: typeof import('@xterm/headless').Terminal
}
type HeadlessTerminal = InstanceType<typeof Terminal>

export const SCAN_DEBOUNCE_MS = 150
// Teto do debounce: com saída contínua (spinner, streaming) a rajada nunca
// assenta, e o scan ficaria preso na tela de antes do turno inteiro.
export const SCAN_MAX_WAIT_MS = 500
// Logo depois de responder um menu a tela fica sem menu por um instante com o
// status ainda em waiting (o sessions/<pid>.json atualiza depois). Só conta como
// "não reconhecida" a tela que ficou parada assim por este tempo.
export const UNPARSED_STABLE_MS = 1500
// Quanto uma resposta segura a sessão: até o menu respondido sair da tela ou isto.
export const RESPOND_LOCK_MS = 2000
const SCROLLBACK = 1000
const EMPTY_SCAN: ScreenScan = { menu: null, inputPrompt: false, nonBlankLines: 0 }

export interface PtySource {
  on(event: 'spawn' | 'resize', listener: (e: PtySizeEvent) => void): unknown
  on(event: 'data', listener: (e: PtyDataEvent) => void): unknown
  on(event: 'exit', listener: (e: PtyExitEvent) => void): unknown
  write(sessionId: string, data: string): void
}

// Quais PTYs ganham espelho headless: só sessões de agente cujo provider tem
// menus na TUI. Shell com dev server despejando log não paga xterm + parse.
// null = PTY fora do escopo; ccSessionId alimenta o índice cc→pty.
export type ScreenSelector = (ptyId: string) => { ccSessionId: string | null } | null

interface Entry {
  term: HeadlessTerminal
  timer: NodeJS.Timeout | null
  // Quando a rajada atual começou a adiar o scan (null = sem scan pendente).
  pendingSince: number | null
  scan: ScreenScan
  key: string
  ccSessionId: string | null
  // Último status visto pelo noteUnparsed (a confirmação adiada relê daqui).
  status: LiveStatus | null
  unparsedTimer: NodeJS.Timeout | null
  // Uma contagem por tela (key): zera só quando a key muda.
  unparsedCounted: boolean
  // Aparição do menu na tela: sobe a cada menu que ENTRA (inclusive o mesmo
  // menu voltando depois de sumir), já que o fingerprint de um comando
  // retentado é idêntico ao do anterior.
  menuSeq: number
  // Resposta em voo: key do menu respondido (null enquanto confere a tela).
  inflight: { key: string | null; timer: NodeJS.Timeout | null } | null
}

function readTail(term: HeadlessTerminal, n: number): string {
  const buf = term.buffer.active
  let text = ''
  for (let y = Math.max(0, buf.length - n); y < buf.length; y++) {
    text += (buf.getLine(y)?.translateToString(true) ?? '') + '\n'
  }
  return text
}

function scanKey(scan: ScreenScan): string {
  if (scan.menu) return menuFingerprint(scan.menu)
  return scan.inputPrompt ? 'prompt' : 'none'
}

// As teclas saem do menu FRESCO: o renderer só diz qual opção. Multi-select e
// abas ficam de fora (exigem navegação que o popover não oferece) — responde no terminal.
function keysFor(menu: TuiMenu, action: AttentionAction): string[] {
  const opt = menu.options.find((o) => o.index === action.optionIndex)
  if (!opt || opt.sentinel === 'chat' || menu.multiSelect || menu.tabs) return []
  if (action.kind === 'other') {
    return opt.sentinel === 'other' ? buildOtherKeys(opt.index, action.text) : []
  }
  return opt.sentinel === 'other' ? [] : buildSelectKeys(menu, opt.index)
}

export class TuiMenuWatch extends EventEmitter {
  private entries = new Map<string, Entry>()
  private byCc = new Map<string, string>()
  private source: PtySource | null = null
  private select: ScreenSelector = () => ({ ccSessionId: null })
  private unparsed = 0
  private lastUnparsedAt: number | null = null

  attach(source: PtySource, select?: ScreenSelector): void {
    if (this.source) return
    this.source = source
    if (select) this.select = select
    source.on('spawn', (e) => this.open(e.sessionId, e.cols, e.rows))
    source.on('resize', (e) => this.entries.get(e.sessionId)?.term.resize(e.cols, e.rows))
    source.on('data', (e) => this.feed(e.sessionId, e.data))
    source.on('exit', (e) => this.close(e.sessionId))
  }

  has(sessionId: string): boolean {
    return this.entries.has(sessionId)
  }

  current(sessionId: string): ScreenScan | null {
    return this.entries.get(sessionId)?.scan ?? null
  }

  // PTY espelhada desta sessão do agente (um ccSessionId tem várias linhas em
  // sessions quando retomado; vale a PTY viva mais recente).
  ptyForCc(ccSessionId: string): string | undefined {
    return this.byCc.get(ccSessionId)
  }

  private open(sessionId: string, cols: number, rows: number): void {
    this.close(sessionId)
    const target = this.select(sessionId)
    if (!target) return
    this.entries.set(sessionId, {
      term: new Terminal({ cols, rows, scrollback: SCROLLBACK, allowProposedApi: true }),
      timer: null,
      pendingSince: null,
      scan: EMPTY_SCAN,
      key: '',
      ccSessionId: target.ccSessionId,
      status: null,
      unparsedTimer: null,
      unparsedCounted: false,
      menuSeq: 0,
      inflight: null,
    })
    if (target.ccSessionId) this.byCc.set(target.ccSessionId, sessionId)
  }

  private feed(sessionId: string, data: string): void {
    const entry = this.entries.get(sessionId)
    if (!entry) return
    entry.term.write(data)
    const now = Date.now()
    entry.pendingSince ??= now
    if (entry.timer && now - entry.pendingSince >= SCAN_MAX_WAIT_MS) return
    if (entry.timer) clearTimeout(entry.timer)
    const wait = Math.min(SCAN_DEBOUNCE_MS, SCAN_MAX_WAIT_MS - (now - entry.pendingSince))
    entry.timer = setTimeout(
      () => {
        entry.timer = null
        entry.pendingSince = null
        void this.rescan(sessionId)
      },
      Math.max(0, wait),
    )
  }

  private close(sessionId: string): void {
    const entry = this.entries.get(sessionId)
    if (!entry) return
    if (entry.timer) clearTimeout(entry.timer)
    if (entry.unparsedTimer) clearTimeout(entry.unparsedTimer)
    if (entry.inflight?.timer) clearTimeout(entry.inflight.timer)
    entry.term.dispose()
    this.entries.delete(sessionId)
    if (entry.ccSessionId && this.byCc.get(entry.ccSessionId) === sessionId) {
      this.byCc.delete(entry.ccSessionId)
    }
    if (entry.key !== '') this.emit('change', sessionId)
  }

  async rescan(sessionId: string): Promise<ScreenScan | null> {
    const entry = this.entries.get(sessionId)
    if (!entry) return null
    // write() do xterm é assíncrono: drena o que está na fila antes de ler a tela.
    await new Promise<void>((resolve) => entry.term.write('', resolve))
    if (this.entries.get(sessionId) !== entry) return null
    const scan = scanScreen((n) => readTail(entry.term, n), entry.term.buffer.active.length)
    const key = scanKey(scan)
    entry.scan = scan
    if (key !== entry.key) {
      entry.key = key
      if (scan.menu) entry.menuSeq++
      if (entry.inflight?.key != null) this.releaseInflight(entry)
      entry.unparsedCounted = false
      this.cancelUnparsed(entry)
      this.emit('change', sessionId)
    }
    return scan
  }

  // Arma a confirmação; quem conta é confirmUnparsed, se a mesma tela seguir
  // em waiting sem menu por UNPARSED_STABLE_MS.
  noteUnparsed(sessionId: string, status: LiveStatus): void {
    const entry = this.entries.get(sessionId)
    if (!entry) return
    entry.status = status
    if (entry.unparsedCounted || !isUnparsedWaiting(status, entry.scan)) {
      this.cancelUnparsed(entry)
      return
    }
    if (entry.unparsedTimer) return
    const key = entry.key
    entry.unparsedTimer = setTimeout(() => {
      entry.unparsedTimer = null
      void this.confirmUnparsed(sessionId, entry, key)
    }, UNPARSED_STABLE_MS)
  }

  private cancelUnparsed(entry: Entry): void {
    if (entry.unparsedTimer) clearTimeout(entry.unparsedTimer)
    entry.unparsedTimer = null
  }

  private async confirmUnparsed(sessionId: string, entry: Entry, key: string): Promise<void> {
    await this.rescan(sessionId)
    if (this.entries.get(sessionId) !== entry || entry.key !== key || entry.unparsedCounted) return
    if (!entry.status || !isUnparsedWaiting(entry.status, entry.scan)) return
    entry.unparsedCounted = true
    this.unparsed++
    this.lastUnparsedAt = Date.now()
    console.warn(
      JSON.stringify({
        event: 'attention_reason_unparsed',
        sessionId,
        nonBlankLines: entry.scan.nonBlankLines,
        total: this.unparsed,
      }),
    )
  }

  counters(): AttentionReasonCounters {
    return { attentionReasonUnparsed: this.unparsed, lastUnparsedAt: this.lastUnparsedAt }
  }

  async snapshot(sessionId: string): Promise<AttentionMenuSnapshot | null> {
    const scan = await this.rescan(sessionId)
    if (!scan?.menu) return null
    const entry = this.entries.get(sessionId)
    if (!entry) return null
    return {
      sessionId,
      fingerprint: menuFingerprint(scan.menu),
      menuSeq: entry.menuSeq,
      menu: scan.menu,
    }
  }

  // Uma resposta por aparição de menu: a trava vale do início da conferência até
  // o menu respondido sair da tela (rescan) ou RESPOND_LOCK_MS.
  async respond(input: AttentionRespondInput): Promise<AttentionRespondResult> {
    const source = this.source
    const entry = this.entries.get(input.sessionId)
    if (!source || !entry) return { ok: false, error: 'not-running', snapshot: null }
    if (entry.inflight) return { ok: false, error: 'busy', snapshot: null }
    const inflight: NonNullable<Entry['inflight']> = { key: null, timer: null }
    entry.inflight = inflight
    const result = await this.checkAndPlay(source, input)
    if (entry.inflight !== inflight) return result
    if (!result.ok) {
      entry.inflight = null
      return result
    }
    inflight.key = entry.key
    inflight.timer = setTimeout(() => this.expireInflight(input.sessionId, entry), RESPOND_LOCK_MS)
    return result
  }

  private async checkAndPlay(
    source: PtySource,
    input: AttentionRespondInput,
  ): Promise<AttentionRespondResult> {
    const snapshot = await this.snapshot(input.sessionId)
    if (!snapshot) return { ok: false, error: 'no-menu', snapshot: null }
    if (snapshot.fingerprint !== input.fingerprint || snapshot.menuSeq !== input.menuSeq) {
      return { ok: false, error: 'menu-changed', snapshot }
    }
    const keys = keysFor(snapshot.menu, input.action)
    if (keys.length === 0) return { ok: false, error: 'invalid-action', snapshot }
    await playKeys(keys, (seq) => source.write(input.sessionId, seq))
    return { ok: true }
  }

  private releaseInflight(entry: Entry): void {
    if (entry.inflight?.timer) clearTimeout(entry.inflight.timer)
    entry.inflight = null
  }

  // Expirou com o mesmo menu na tela: não dá pra provar que é a aparição que o
  // usuário respondeu (a TUI pode ter reposto um idêntico entre dois scans), então
  // conta como aparição nova — quem tem o seq velho precisa reler o menu.
  private expireInflight(sessionId: string, entry: Entry): void {
    if (this.entries.get(sessionId) !== entry || !entry.inflight) return
    const answeredKey = entry.inflight.key
    entry.inflight = null
    if (answeredKey === entry.key && entry.scan.menu) {
      entry.menuSeq++
      this.emit('change', sessionId)
    }
  }
}

export const tuiMenuWatch = new TuiMenuWatch()
