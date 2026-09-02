import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

// Descoberta dos nós PipeWire pra captura. `wpctl inspect @DEFAULT_AUDIO_SINK@`
// imprime `node.name = "alsa_output...."` — é esse nome que vai no --target do
// pw-record (nunca o `.monitor`: cai silenciosamente no mic).

export type Exec = (cmd: string, args: string[]) => Promise<{ stdout: string }>

const execFileAsync = promisify(execFile)

const defaultExec: Exec = (cmd, args) =>
  execFileAsync(cmd, args, { timeout: 5_000, maxBuffer: 8 * 1024 * 1024 }) as Promise<{ stdout: string }>

export function parseNodeName(output: string): string | null {
  const match = output.match(/node\.name\s*=\s*"([^"]+)"/)
  return match ? match[1] : null
}

async function inspect(target: string, exec: Exec): Promise<string | null> {
  try {
    const { stdout } = await exec('wpctl', ['inspect', target])
    return parseNodeName(stdout)
  } catch {
    return null
  }
}

export async function resolveDefaultDevices(
  exec: Exec = defaultExec,
): Promise<{ sink: string | null; source: string | null }> {
  const [sink, source] = await Promise.all([
    inspect('@DEFAULT_AUDIO_SINK@', exec),
    inspect('@DEFAULT_AUDIO_SOURCE@', exec),
  ])
  return { sink, source }
}

export async function hasPipewire(exec: Exec = defaultExec): Promise<boolean> {
  try {
    const { stdout } = await exec('which', ['pw-record'])
    return stdout.trim().length > 0
  } catch {
    return false
  }
}

// A source real de um stream de captura (o mic que o Chrome está usando) é o
// `output-node-id` do Link cujo `input-node-id` é o nó do stream. Sem link
// (stream ainda negociando, ou pw-dump sem Links) devolve null e quem chama
// cai no default.
interface PwObject {
  id?: number
  type?: string
  info?: {
    'output-node-id'?: number
    'input-node-id'?: number
    props?: Record<string, unknown>
  }
}

export function sourceForStream(dump: unknown, streamNodeId: number): string | null {
  if (!Array.isArray(dump)) return null
  const objects = dump as PwObject[]
  const link = objects.find(
    (o) => o.type === 'PipeWire:Interface:Link' && o.info?.['input-node-id'] === streamNodeId,
  )
  const sourceId = link?.info?.['output-node-id']
  if (sourceId === undefined) return null
  const node = objects.find((o) => o.type === 'PipeWire:Interface:Node' && o.id === sourceId)
  const props = node?.info?.props
  if (!props || props['media.class'] !== 'Audio/Source') return null
  const name = props['node.name']
  return typeof name === 'string' ? name : null
}

export async function resolveSourceForStream(streamNodeId: number, exec: Exec = defaultExec): Promise<string | null> {
  try {
    const { stdout } = await exec('pw-dump', [])
    return sourceForStream(JSON.parse(stdout), streamNodeId)
  } catch {
    return null
  }
}
