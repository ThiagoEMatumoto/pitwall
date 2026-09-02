import { spawn, type ChildProcess } from 'node:child_process'
import { readWavPcm } from './wav'

// Uma captura por trilha: `them` = o que sai no sink (o outro lado da
// chamada), `me` = o mic. Dois pw-record com PCM s16le 16 kHz mono no stdout,
// lido em blocos — nada vai pra disco.
//
// Modo fixture (e2e): em vez de spawnar, lê um WAV e emite em blocos de 100 ms
// no ritmo de `pace` (1 = tempo real, 0 = tudo de uma vez). Quando o arquivo
// acaba a captura continua emitindo silêncio até stop(), como uma reunião que
// segue em silêncio — senão o gravador pararia sozinho no fim do arquivo.

export type Track = 'me' | 'them'

export interface CaptureHandle {
  onData(cb: (pcm: Buffer) => void): void
  onExit(cb: (code: number | null, stderr: string) => void): void
  stop(): void
}

export interface StartCaptureOptions {
  track: Track
  /** node.name do sink (them) ou source (me); null usa o default do PipeWire. */
  target: string | null
  fixturePath?: string
  /** Modo fixture sem arquivo = só silêncio (trilha sem fixture no e2e). */
  mode?: 'pipewire' | 'fixture'
  pace?: number
  spawnImpl?: typeof spawn
}

export const RATE = 16000
const BLOCK_MS = 100
const BLOCK_BYTES = (RATE * BLOCK_MS * 2) / 1000
const SIGKILL_AFTER_MS = 1500
const STDERR_LIMIT = 4096

export function pwRecordArgs(track: Track, target: string | null): string[] {
  const args: string[] = []
  if (target) args.push('--target', target)
  // `-P` recebe a string inteira como UM argumento (sem aspas extras).
  if (track === 'them') args.push('-P', '{ stream.capture.sink = true }')
  args.push('--raw', '--format', 's16', '--rate', String(RATE), '--channels', '1', '--latency', '20ms', '-')
  return args
}

export function fixtureFromEnv(track: Track, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = track === 'them' ? env.CM_MEETING_FIXTURE_SYSTEM : env.CM_MEETING_FIXTURE_MIC
  return value || undefined
}

export function fixturePaceFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.CM_MEETING_FIXTURE_PACE ?? '1')
  return Number.isFinite(n) && n >= 0 ? n : 1
}

export function startCapture(opts: StartCaptureOptions): CaptureHandle {
  const mode = opts.mode ?? (opts.fixturePath ? 'fixture' : 'pipewire')
  return mode === 'fixture' ? startFixture(opts) : startPipewire(opts)
}

function startPipewire(opts: StartCaptureOptions): CaptureHandle {
  const spawnImpl = opts.spawnImpl ?? spawn
  let onData: (pcm: Buffer) => void = () => {}
  let onExit: (code: number | null, stderr: string) => void = () => {}
  let stderr = ''
  let exited = false
  let killTimer: NodeJS.Timeout | null = null

  let child: ChildProcess
  try {
    child = spawnImpl('pw-record', pwRecordArgs(opts.track, opts.target), {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    queueMicrotask(() => onExit(null, message))
    return { onData: (cb) => (onData = cb), onExit: (cb) => (onExit = cb), stop: () => {} }
  }

  child.stdout?.on('data', (buf: Buffer) => onData(buf))
  child.stderr?.on('data', (buf: Buffer) => {
    if (stderr.length < STDERR_LIMIT) stderr += buf.toString('utf8')
  })
  const finish = (code: number | null, extra?: string): void => {
    if (exited) return
    exited = true
    if (killTimer) clearTimeout(killTimer)
    onExit(code, [stderr.trim(), extra].filter(Boolean).join('\n'))
  }
  child.on('error', (err) => finish(null, err.message))
  child.on('exit', (code) => finish(code))

  return {
    onData: (cb) => (onData = cb),
    onExit: (cb) => (onExit = cb),
    stop: () => {
      if (exited) return
      child.kill('SIGINT')
      killTimer = setTimeout(() => {
        if (!exited) child.kill('SIGKILL')
      }, SIGKILL_AFTER_MS)
    },
  }
}

function startFixture(opts: StartCaptureOptions): CaptureHandle {
  const pace = opts.pace ?? 1
  let onData: (pcm: Buffer) => void = () => {}
  let onExit: (code: number | null, stderr: string) => void = () => {}
  let stopped = false
  let timer: NodeJS.Timeout | null = null

  let pcm: Buffer = Buffer.alloc(0)
  if (opts.fixturePath) {
    const wav = readWavPcm(opts.fixturePath)
    if (wav.rate !== RATE || wav.channels !== 1) {
      throw new Error(`fixture ${opts.fixturePath} precisa ser ${RATE} Hz mono`)
    }
    pcm = wav.pcm
  }
  const silence = Buffer.alloc(BLOCK_BYTES)
  let offset = 0

  const emitBlock = (): void => {
    if (stopped) return
    if (offset < pcm.length) {
      onData(pcm.subarray(offset, Math.min(pcm.length, offset + BLOCK_BYTES)))
      offset += BLOCK_BYTES
    } else {
      onData(silence)
    }
  }

  const start = (): void => {
    if (stopped) return
    if (pace === 0) {
      while (offset < pcm.length && !stopped) emitBlock()
      timer = setInterval(emitBlock, BLOCK_MS)
    } else {
      timer = setInterval(emitBlock, BLOCK_MS / pace)
    }
  }
  // Próximo tick: quem chamou ainda vai registrar onData.
  setImmediate(start)

  return {
    onData: (cb) => (onData = cb),
    onExit: (cb) => (onExit = cb),
    stop: () => {
      if (stopped) return
      stopped = true
      if (timer) clearInterval(timer)
      // Mantém o contrato do pw-record: parada pedida encerra com código 0.
      queueMicrotask(() => onExit(0, ''))
    },
  }
}
