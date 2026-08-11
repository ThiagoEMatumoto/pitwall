import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { createInterface, Interface } from 'node:readline'
import type { MeetingSegment, MeetingSpeaker, MeetingStatus } from '../../../shared/types/ipc'

// Supervisor do sidecar de captura/transcrição. Espelha a ESTRUTURA do
// pty-manager (TypedEmitter + Map<id,proc> + killAll), mas o transporte é
// child_process.spawn (NÃO node-pty): precisamos de stdout (NDJSON, 1 evento por
// linha) e stderr (logs) SEPARADOS — o PTY funde ambos e injeta FORCE_COLOR, o
// que corromperia o JSON. Reconciliação no 'exit' espelha ipc/sessions.ts: um
// sidecar que morre durante a captura sem emitir `done` marca a reunião failed.

// ---- contrato NDJSON sidecar→main ----

interface StatusEvent {
  type: 'status'
  state: MeetingStatus
}

// Diarização: o sidecar emite um `speaker` por label descoberto ANTES dos
// segments que o referenciam, carregando o is_local_user (a trilha do mic = você).
interface SpeakerEvent {
  type: 'speaker'
  label: string
  is_local_user?: boolean
}

interface SegmentEvent {
  type: 'segment'
  idx: number
  start_ms?: number | null
  end_ms?: number | null
  speaker?: string | null
  text: string
  confidence?: number | null
}

interface PartialEvent {
  type: 'partial'
  idx: number
  start_ms?: number | null
  end_ms?: number | null
  speaker?: string | null
  text: string
}

interface DoneEvent {
  type: 'done'
  segments?: number
  duration_ms?: number | null
}

interface ErrorEvent {
  type: 'error'
  message: string
}

type SidecarEvent =
  | StatusEvent
  | SpeakerEvent
  | SegmentEvent
  | PartialEvent
  | DoneEvent
  | ErrorEvent

// ---- dependências injetáveis (testabilidade) ----

export interface PartialPayload {
  meetingId: string
  idx: number
  startMs: number | null
  endMs: number | null
  speakerLabel: string | null
  text: string
}

export interface SidecarStore {
  update(input: { id: string; status?: MeetingStatus; durationMs?: number | null }): unknown
  appendSegment(input: {
    meetingId: string
    startMs?: number | null
    endMs?: number | null
    speakerLabel?: string | null
    text: string
    confidence?: number | null
    isPartial?: boolean
  }): MeetingSegment
  // Diarização: persiste um label descoberto + o flag is_local_user (mic = você).
  registerSpeaker(meetingId: string, label: string, isLocalUser: boolean): MeetingSpeaker
}

export type SidecarBroadcast = (channel: string, payload: unknown) => void

export interface StartOptions {
  // Interpretador/binário (default: 'python3', resolvido via login shell).
  command?: string
  // Argumentos completos passados ao binário. Default:
  // [<repo>/sidecar/fake_sidecar.py, '--meeting-id', <id>].
  args?: string[]
}

interface SidecarManagerEvents {
  exit: (e: { meetingId: string; code: number | null; signal: NodeJS.Signals | null }) => void
}

class TypedEmitter extends EventEmitter {
  override on<K extends keyof SidecarManagerEvents>(
    event: K,
    listener: SidecarManagerEvents[K],
  ): this {
    return super.on(event, listener)
  }
  override emit<K extends keyof SidecarManagerEvents>(
    event: K,
    ...args: Parameters<SidecarManagerEvents[K]>
  ): boolean {
    return super.emit(event, ...args)
  }
  override off<K extends keyof SidecarManagerEvents>(
    event: K,
    listener: SidecarManagerEvents[K],
  ): this {
    return super.off(event, listener)
  }
}

// Estados em que a reunião está "viva" sob o sidecar. Se o processo morre nesses
// estados sem ter emitido `done`, é morte anômala → failed.
const ACTIVE_STATES: ReadonlySet<MeetingStatus> = new Set<MeetingStatus>([
  'capturing',
  'recording',
  'transcribing',
  'diarizing',
])

const STOP_GRACE_MS = 3000

// Grace CURTO e bounded p/ o shutdown forçado: SIGTERM (o sidecar trata SIGINT/
// SIGTERM e para o pw-record, liberando o device) → espera → SIGKILL. Coordenado
// com o budget do before-quit (~6s): ~1.5s é confortável e evita orfanar o
// processo de captura no quit/crash.
const KILL_GRACE_MS = 1500

interface Tracked {
  child: ChildProcessWithoutNullStreams
  rl: Interface
  // Última transição de status conhecida — base da reconciliação no exit.
  status: MeetingStatus
  // Recebeu `done`? Então o exit é esperado (não reconcilia para failed).
  doneSeen: boolean
}

export interface SidecarManagerDeps {
  store: SidecarStore
  broadcast: SidecarBroadcast
  // Resolve o binário do interpretador (default 'python3'); injetável p/ testes.
  resolveCommand?: () => Promise<string>
  // Args default quando StartOptions.args não vier. Recebe o meetingId.
  defaultArgs?: (meetingId: string) => string[]
  // Resolve command+args JUNTOS no momento do start (async). Tem precedência
  // sobre resolveCommand/defaultArgs quando presente — necessário p/ o sidecar
  // real, onde o interpretador (python do venv) e o script são decididos juntos
  // a partir da pref, e não independentemente. `env` opcional: env completo do
  // spawn (process.env + vars customizadas do usuário); ausente ⇒ herda process.env.
  resolveStart?: (
    meetingId: string,
  ) => Promise<{ command: string; args: string[]; env?: NodeJS.ProcessEnv }>
  // O stderr do sidecar vai pro log do main, e o env do spawn carrega as chaves
  // de API do usuário: um traceback do sidecar que ecoe o ambiente escreveria o
  // segredo no log. Este redator é construído por spawn (snapshot dos valores) e
  // aplicado a toda linha logada. Ausente ⇒ identidade (testes).
  makeLogRedactor?: () => (text: string) => string
}

export class MeetingSidecarManager extends TypedEmitter {
  private procs = new Map<string, Tracked>()
  private readonly deps: SidecarManagerDeps

  constructor(deps: SidecarManagerDeps) {
    super()
    this.deps = deps
  }

  isRunning(meetingId: string): boolean {
    return this.procs.has(meetingId)
  }

  runningIds(): string[] {
    return Array.from(this.procs.keys())
  }

  async start(meetingId: string, opts: StartOptions = {}): Promise<void> {
    if (this.procs.has(meetingId)) {
      throw new Error(`sidecar for meeting ${meetingId} already running`)
    }

    // resolveStart decide command+args juntos (sidecar real). StartOptions
    // explícitos (testes) têm precedência sobre tudo.
    let command: string
    let args: string[]
    // env do spawn: undefined ⇒ herda process.env (comportamento legado);
    // resolveStart pode devolver process.env + vars customizadas do usuário.
    let env: NodeJS.ProcessEnv | undefined
    if (opts.command !== undefined || opts.args !== undefined) {
      command =
        opts.command ?? (this.deps.resolveCommand ? await this.deps.resolveCommand() : 'python3')
      args = opts.args ?? (this.deps.defaultArgs ? this.deps.defaultArgs(meetingId) : [])
    } else if (this.deps.resolveStart) {
      ;({ command, args, env } = await this.deps.resolveStart(meetingId))
    } else {
      command = this.deps.resolveCommand ? await this.deps.resolveCommand() : 'python3'
      args = this.deps.defaultArgs ? this.deps.defaultArgs(meetingId) : []
    }

    // stdin é mantido aberto (pipe) p/ o orphan-guard do sidecar: quando o main
    // morre, o pipe fecha e o sidecar se auto-encerra, liberando o device.
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], env })

    const rl = createInterface({ input: child.stdout })
    const tracked: Tracked = { child, rl, status: 'capturing', doneSeen: false }
    this.procs.set(meetingId, tracked)

    rl.on('line', (line) => this.handleLine(meetingId, line))

    const redact = this.deps.makeLogRedactor?.() ?? ((text: string) => text)
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8').trimEnd()
      if (text) console.error(`[sidecar ${meetingId}] ${redact(text)}`)
    })

    child.on('error', (err) => {
      console.error(`[sidecar ${meetingId}] spawn error:`, err)
    })

    child.on('exit', (code, signal) => this.handleExit(meetingId, code, signal))
  }

  private handleLine(meetingId: string, line: string): void {
    const trimmed = line.trim()
    if (!trimmed) return
    let event: SidecarEvent
    try {
      event = JSON.parse(trimmed) as SidecarEvent
    } catch {
      console.error(`[sidecar ${meetingId}] dropping non-JSON line: ${trimmed.slice(0, 200)}`)
      return
    }
    this.dispatch(meetingId, event)
  }

  private dispatch(meetingId: string, event: SidecarEvent): void {
    const tracked = this.procs.get(meetingId)
    switch (event.type) {
      case 'status': {
        if (tracked) tracked.status = event.state
        this.deps.store.update({ id: meetingId, status: event.state })
        this.deps.broadcast('meeting:status', { id: meetingId, status: event.state })
        break
      }
      case 'speaker': {
        // Diarização: registra o label + is_local_user. Chega ANTES dos segments
        // que o referenciam, então a UI já sabe quem é "você" ao renderar.
        const speaker = this.deps.store.registerSpeaker(
          meetingId,
          event.label,
          event.is_local_user ?? false,
        )
        this.deps.broadcast('meeting:speaker', speaker)
        break
      }
      case 'segment': {
        const seg = this.deps.store.appendSegment({
          meetingId,
          startMs: event.start_ms ?? null,
          endMs: event.end_ms ?? null,
          speakerLabel: event.speaker ?? null,
          text: event.text,
          confidence: event.confidence ?? null,
          isPartial: false,
        })
        this.deps.broadcast('meeting:transcript:segment', seg)
        break
      }
      case 'partial': {
        // Efêmero: NÃO persiste, só transita pela UI. O `segment` final com o
        // mesmo conteúdo é quem grava.
        const payload: PartialPayload = {
          meetingId,
          idx: event.idx,
          startMs: event.start_ms ?? null,
          endMs: event.end_ms ?? null,
          speakerLabel: event.speaker ?? null,
          text: event.text,
        }
        this.deps.broadcast('meeting:transcript:partial', payload)
        break
      }
      case 'done': {
        if (tracked) {
          tracked.doneSeen = true
          tracked.status = 'ready'
        }
        this.deps.store.update({
          id: meetingId,
          status: 'ready',
          durationMs: event.duration_ms ?? null,
        })
        this.deps.broadcast('meeting:status', { id: meetingId, status: 'ready' })
        break
      }
      case 'error': {
        console.error(`[sidecar ${meetingId}] reported error: ${event.message}`)
        if (tracked) tracked.status = 'failed'
        this.deps.store.update({ id: meetingId, status: 'failed' })
        this.deps.broadcast('meeting:status', { id: meetingId, status: 'failed' })
        break
      }
    }
  }

  private handleExit(
    meetingId: string,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    const tracked = this.procs.get(meetingId)
    this.procs.delete(meetingId)
    if (tracked) {
      tracked.rl.close()
      // Reconciliação: morte durante captura sem `done` ⇒ failed (espelha o
      // failIfRunning de ipc/sessions.ts). Estados terminais (done/error) já
      // ajustaram o status; não sobrescrevemos.
      if (!tracked.doneSeen && ACTIVE_STATES.has(tracked.status)) {
        this.deps.store.update({ id: meetingId, status: 'failed' })
        this.deps.broadcast('meeting:status', { id: meetingId, status: 'failed' })
      }
    }
    this.emit('exit', { meetingId, code, signal })
  }

  // SIGINT graceful (deixa o sidecar emitir `done` parcial) → timeout → SIGKILL.
  stop(meetingId: string): void {
    const tracked = this.procs.get(meetingId)
    if (!tracked) return
    const { child } = tracked
    child.kill('SIGINT')
    const timer = setTimeout(() => {
      if (this.procs.has(meetingId)) child.kill('SIGKILL')
    }, STOP_GRACE_MS)
    // Não segurar o event loop no quit: o timer morre junto se já saiu.
    timer.unref?.()
  }

  // Shutdown: SIGTERM primeiro (o sidecar trata e para o pw-record, liberando o
  // device — SIGKILL direto orfanaria a captura no quit/crash) → grace CURTO e
  // bounded → SIGKILL p/ quem não saiu. Síncrono e não-bloqueante: o escalonamento
  // roda via timer unref'd (não segura o event loop no quit). NÃO emite 'exit'
  // manualmente nem limpa o Map — deixa o 'exit' natural disparar handleExit, que
  // reconcilia (capturing sem done → failed) e remove a entrada.
  killAllSidecars(): void {
    const children = Array.from(this.procs.values()).map((t) => t.child)
    for (const child of children) {
      child.kill('SIGTERM')
    }
    if (children.length === 0) return
    const timer = setTimeout(() => {
      for (const child of children) {
        if (!child.killed) child.kill('SIGKILL')
      }
    }, KILL_GRACE_MS)
    timer.unref?.()
  }
}
