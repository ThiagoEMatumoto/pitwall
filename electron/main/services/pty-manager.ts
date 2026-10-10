import { spawn, IPty } from 'node-pty'
import { EventEmitter } from 'node:events'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { nextPtySample, type PtySample } from './providers/pty-status'
import {
  reportScopeFailure,
  scopeUnitName,
  scopeWrapEnabled,
  stopScopeUnit,
  wrapInScope,
} from './systemd-scope'

export interface SpawnOptions {
  sessionId: string
  command: string
  args?: string[]
  cwd: string
  env?: NodeJS.ProcessEnv
  cols?: number
  rows?: number
  // Status pela própria tela (provider sem índice nativo, o Codex): só quem pede
  // paga o hash do tail por chunk.
  sampleActivity?: boolean
}

export interface PtyDataEvent {
  sessionId: string
  data: string
}

export interface PtyExitEvent {
  sessionId: string
  exitCode: number
  signal: number | null
}

// Tamanho da PTY: quem espelha a tela fora do renderer (tui-menu-watch) precisa
// dele desde o spawn — sem pane montada ninguém mais redimensiona.
export interface PtySizeEvent {
  sessionId: string
  cols: number
  rows: number
}

interface PtyEvents {
  spawn: (e: PtySizeEvent) => void
  resize: (e: PtySizeEvent) => void
  data: (e: PtyDataEvent) => void
  exit: (e: PtyExitEvent) => void
}

class TypedEmitter extends EventEmitter {
  override on<K extends keyof PtyEvents>(event: K, listener: PtyEvents[K]): this {
    return super.on(event, listener)
  }
  override emit<K extends keyof PtyEvents>(event: K, ...args: Parameters<PtyEvents[K]>): boolean {
    return super.emit(event, ...args)
  }
  override off<K extends keyof PtyEvents>(event: K, listener: PtyEvents[K]): this {
    return super.off(event, listener)
  }
}

const BACKLOG_CAP = 256 * 1024
// Janela em que a saída é tratada como eco/reflow de input do app.
const INPUT_ECHO_MS = 300
// Até o pid deixar de ser o systemd-run, uma saída é falha do wrapper (bus caiu,
// unit duplicada), não do comando. O teto cobre o timeout de 25s do D-Bus.
const SCOPE_EXEC_POLL_MS = 25
const SCOPE_EXEC_WATCH_MAX_MS = 30_000
// Depois do SIGHUP no pid da PTY, o que sobrou no scope (MCPs, processos em
// background) é parado junto.
const SCOPE_STOP_GRACE_MS = 3_000

function procComm(pid: number): string | null {
  try {
    return readFileSync(`/proc/${pid}/comm`, 'utf8').trim()
  } catch {
    return null
  }
}

class PtyManager extends TypedEmitter {
  private ptys = new Map<string, IPty>()
  // Histórico de saída por sessão desde o spawn, para replay quando o renderer
  // anexa depois do processo já ter emitido bytes (banner inicial do claude).
  private backlog = new Map<string, string>()
  // Último byte e assinatura do tail visível: o status de quem não tem índice
  // nativo (Codex). Só para PTY spawnada com sampleActivity.
  private samples = new Map<string, PtySample>()
  // Última escrita/resize vinda do app: o eco da tecla e o reflow que vêm logo
  // depois não são o agente trabalhando.
  private lastInputAt = new Map<string, number>()
  // Unit .scope de cada sessão spawnada via systemd-run.
  private scopeUnits = new Map<string, string>()
  // Saída pedida pelo app não é falha do systemd-run.
  private killed = new WeakSet<IPty>()

  spawn(opts: SpawnOptions): void {
    if (this.ptys.has(opts.sessionId)) {
      throw new Error(`session ${opts.sessionId} already running`)
    }

    if (!existsSync(opts.cwd) || !statSync(opts.cwd).isDirectory()) {
      throw new Error(`cwd does not exist or is not a directory: ${opts.cwd}`)
    }

    this.spawnPty(opts, scopeWrapEnabled())
  }

  private spawnPty(opts: SpawnOptions, inScope: boolean): void {
    const cols = opts.cols ?? 80
    const rows = opts.rows ?? 24
    const unit = inScope ? scopeUnitName(opts.sessionId) : null
    const target = unit
      ? wrapInScope(opts.command, opts.args ?? [], unit)
      : { command: opts.command, args: opts.args ?? [] }
    const pty = spawn(target.command, target.args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: opts.cwd,
      env: {
        ...process.env,
        FORCE_COLOR: '1',
        TERM: 'xterm-256color',
        ...(opts.env ?? {}),
      },
    })

    this.ptys.set(opts.sessionId, pty)
    if (unit) this.scopeUnits.set(opts.sessionId, unit)
    else this.scopeUnits.delete(opts.sessionId)
    if (!this.backlog.has(opts.sessionId)) this.backlog.set(opts.sessionId, '')
    if (opts.sampleActivity) {
      this.samples.set(opts.sessionId, { lastByteAt: null, tailHash: null, hashChangedAt: null })
    }
    this.emit('spawn', { sessionId: opts.sessionId, cols, rows })

    const deliver = (data: string): void => {
      const prev = this.backlog.get(opts.sessionId) ?? ''
      const next = prev + data
      const capped = next.length > BACKLOG_CAP ? next.slice(next.length - BACKLOG_CAP) : next
      this.backlog.set(opts.sessionId, capped)
      const sample = this.samples.get(opts.sessionId)
      if (sample) {
        const now = Date.now()
        const echo = now - (this.lastInputAt.get(opts.sessionId) ?? -Infinity) < INPUT_ECHO_MS
        this.samples.set(opts.sessionId, nextPtySample(sample, capped, now, { echo }))
      }
      this.emit('data', { sessionId: opts.sessionId, data })
    }

    // Até o exec, a saída é do systemd-run: segurada, para o erro dele não virar o
    // "primeiro data" que arma a injeção do comando inicial (sessions.ts) nem
    // aparecer no terminal quando o spawn cai para o direto.
    let held: string[] = []
    // O que o pid escreveu antes do exec: decide se a saída foi falha do wrapper.
    let preExec = ''
    const flushHeld = (): void => {
      const chunks = held
      held = []
      for (const c of chunks) deliver(c)
    }
    const execWatch = unit ? this.watchScopeExec(pty.pid, flushHeld) : null

    pty.onData((data) => {
      if (execWatch && !execWatch.execSeen() && preExec.length < 4096) preExec += data
      if (execWatch && !execWatch.released()) held.push(data)
      else deliver(data)
    })

    pty.onExit(({ exitCode, signal }) => {
      execWatch?.stop()
      const current = this.ptys.get(opts.sessionId)
      if (current && current !== pty) return
      if (
        current &&
        execWatch &&
        !execWatch.execSeen() &&
        exitCode === 1 &&
        /Failed to /.test(preExec) &&
        !this.killed.has(pty)
      ) {
        // O systemd-run morreu sem virar o comando: refaz direto, uma vez, no
        // tamanho atual (pode ter havido resize no meio).
        reportScopeFailure(preExec.trim().split('\n')[0] ?? `exit ${exitCode}`)
        this.ptys.delete(opts.sessionId)
        this.spawnPty({ ...opts, cols: pty.cols, rows: pty.rows }, false)
        return
      }
      flushHeld()
      this.ptys.delete(opts.sessionId)
      this.scopeUnits.delete(opts.sessionId)
      this.samples.delete(opts.sessionId)
      this.lastInputAt.delete(opts.sessionId)
      this.emit('exit', { sessionId: opts.sessionId, exitCode, signal: signal ?? null })
    })
  }

  // execSeen = o pid foi visto como outro processo que não o systemd-run nem o
  // fork do próprio app antes do exec (mesmo comm do pai). released = a saída
  // segurada já foi liberada: no exec ou, sem ele, no teto.
  private watchScopeExec(
    pid: number,
    onRelease: () => void,
  ): { execSeen: () => boolean; released: () => boolean; stop: () => void } {
    const ownComm = procComm(process.pid)
    let execSeen = false
    let released = false
    const startedAt = Date.now()
    const timer = setInterval(() => {
      const comm = procComm(pid)
      execSeen = comm !== null && comm !== 'systemd-run' && comm !== ownComm
      // No teto, para de segurar a saída: um terminal mudo é pior que um fallback perdido.
      if (execSeen || Date.now() - startedAt > SCOPE_EXEC_WATCH_MAX_MS) {
        released = true
        clearInterval(timer)
        onRelease()
      }
    }, SCOPE_EXEC_POLL_MS)
    timer.unref?.()
    return {
      execSeen: () => execSeen,
      released: () => released,
      stop: () => clearInterval(timer),
    }
  }

  scopeUnitFor(sessionId: string): string | null {
    return this.scopeUnits.get(sessionId) ?? null
  }

  // null = PTY desconhecida (nunca spawnada aqui ou já encerrada).
  getActivitySample(sessionId: string): PtySample | null {
    return this.samples.get(sessionId) ?? null
  }

  getBacklog(sessionId: string): string {
    return this.backlog.get(sessionId) ?? ''
  }

  write(sessionId: string, data: string): void {
    const pty = this.ptys.get(sessionId)
    if (!pty) throw new Error(`session ${sessionId} not running`)
    if (this.samples.has(sessionId)) this.lastInputAt.set(sessionId, Date.now())
    pty.write(data)
  }

  resize(sessionId: string, cols: number, rows: number): void {
    const pty = this.ptys.get(sessionId)
    if (!pty) return
    if (this.samples.has(sessionId)) this.lastInputAt.set(sessionId, Date.now())
    pty.resize(cols, rows)
    this.emit('resize', { sessionId, cols, rows })
  }

  kill(sessionId: string): void {
    const pty = this.ptys.get(sessionId)
    if (!pty) return
    this.killed.add(pty)
    pty.kill()
    const unit = this.scopeUnits.get(sessionId)
    if (unit) setTimeout(() => stopScopeUnit(unit), SCOPE_STOP_GRACE_MS).unref?.()
    this.backlog.delete(sessionId)
    this.samples.delete(sessionId)
    this.lastInputAt.delete(sessionId)
  }

  killAll(): void {
    for (const pty of this.ptys.values()) {
      this.killed.add(pty)
      pty.kill()
    }
    // Quit: só o SIGHUP, como antes; um stop agora mandaria SIGTERM junto e
    // poderia cortar o flush do transcript.
    this.scopeUnits.clear()
    this.ptys.clear()
    this.backlog.clear()
    this.samples.clear()
    this.lastInputAt.clear()
  }

  isRunning(sessionId: string): boolean {
    return this.ptys.has(sessionId)
  }

  runningIds(): string[] {
    return Array.from(this.ptys.keys())
  }
}

export const ptyManager = new PtyManager()
