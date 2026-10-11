import { spawn, type ChildProcess } from 'node:child_process'
import { join, resolve } from 'node:path'
import { buildSync } from 'esbuild'

// Roda um script de test-support num processo Node de verdade (bundle do código
// de produção). runAndKill espera o `marker` no stdout e manda SIGKILL logo em
// seguida: sem chance de fechar a conexão nem de fazer checkpoint do WAL.

interface RunOpts {
  entry: string
  dir: string
  args: string[]
  env?: Record<string, string>
}

const bundles = new Map<string, string>()

function bundle(entry: string, dir: string): string {
  const key = `${dir}:${entry}`
  const cached = bundles.get(key)
  if (cached) return cached
  const outfile = join(dir, `${entry.replace(/\W/g, '_')}.cjs`)
  buildSync({
    entryPoints: [resolve(__dirname, entry)],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile,
    external: ['better-sqlite3', 'electron'],
    logLevel: 'silent',
  })
  bundles.set(key, outfile)
  return outfile
}

function start(opts: RunOpts): {
  child: ChildProcess
  out: { stdout: string; stderr: string }
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
} {
  const child = spawn(process.execPath, [bundle(opts.entry, opts.dir), ...opts.args], {
    env: {
      ...process.env,
      ...opts.env,
      NODE_PATH: resolve(__dirname, '../../../../node_modules'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const out = { stdout: '', stderr: '' }
  child.stdout?.on('data', (b) => (out.stdout += String(b)))
  child.stderr?.on('data', (b) => (out.stderr += String(b)))
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((res) =>
    child.on('exit', (code, signal) => res({ code, signal })),
  )
  return { child, out, exited }
}

export async function runAndKill(
  opts: RunOpts & { marker: string },
): Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string }> {
  const { child, out, exited } = start(opts)
  await new Promise<void>((res, rej) => {
    child.stdout?.on('data', () => out.stdout.includes(opts.marker) && res())
    void exited.then(() =>
      rej(new Error(`processo saiu antes de "${opts.marker}": ${out.stderr || out.stdout}`)),
    )
  })
  child.kill('SIGKILL')
  return { ...(await exited), stdout: out.stdout }
}

export async function runToEnd(opts: RunOpts): Promise<string> {
  const { out, exited } = start(opts)
  const { code } = await exited
  if (code !== 0) throw new Error(`processo saiu com ${code}: ${out.stderr}`)
  return out.stdout
}
