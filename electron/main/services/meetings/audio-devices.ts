import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

// Descoberta dos nós PipeWire pra captura. `wpctl inspect @DEFAULT_AUDIO_SINK@`
// imprime `node.name = "alsa_output...."` — é esse nome que vai no --target do
// pw-record (nunca o `.monitor`: cai silenciosamente no mic).

export type Exec = (cmd: string, args: string[]) => Promise<{ stdout: string }>

const execFileAsync = promisify(execFile)

const defaultExec: Exec = (cmd, args) =>
  execFileAsync(cmd, args, { timeout: 5_000 }) as Promise<{ stdout: string }>

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
