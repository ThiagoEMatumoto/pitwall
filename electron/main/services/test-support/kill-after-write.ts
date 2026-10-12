import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
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

// Sem o marker até aqui, o filho é morto e o erro diz em que ponto ele parou. Abaixo
// do timeout dos testes (60s) para a falha sair com diagnóstico, não como timeout mudo.
export const MARKER_DEADLINE_MS = 45_000

// Um bundle por entry no worker, fora do dir do teste (que é apagado a cada caso):
// o buildSync do esbuild trava o worker, e repeti-lo em cada caso só soma tempo
// sob carga.
const bundles = new Map<string, string>()
let bundleDir: string | null = null

function bundle(entry: string): string {
  const cached = bundles.get(entry)
  if (cached) return cached
  bundleDir ??= mkdtempSync(join(tmpdir(), 'cm-kill-bundle-'))
  const outfile = join(bundleDir, `${entry.replace(/\W/g, '_')}.cjs`)
  buildSync({
    entryPoints: [resolve(__dirname, entry)],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile,
    external: ['better-sqlite3', 'electron'],
    logLevel: 'silent',
  })
  bundles.set(entry, outfile)
  return outfile
}

// afterAll de quem usa: o worker do vitest não emite 'exit' de forma confiável.
export function disposeBundles(): void {
  if (bundleDir) rmSync(bundleDir, { recursive: true, force: true })
  bundleDir = null
  bundles.clear()
}

function start(opts: RunOpts): {
  child: ChildProcess
  out: { stdout: string; stderr: string }
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
} {
  const child = spawn(process.execPath, [bundle(opts.entry), ...opts.args], {
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
    // 'close', não 'exit': só com o stdio drenado o erro leva o stderr do filho.
    child.on('close', (code, signal) => res({ code, signal })),
  )
  return { child, out, exited }
}

// better-sqlite3 11 não suporta o Node 24 em que o vitest roda (produção é o Node 20
// do Electron 32): às vezes o GC finaliza um Statement e o addon aborta em
// RemoveEnvironmentCleanupHook, antes de o filho gravar e avisar. Só essa assinatura,
// ANTES do marker, é repetida: um run que chegou ao marker nunca é refeito, então a
// garantia (gravou → sobrevive ao SIGKILL) é sempre conferida num run inteiro.
const ADDON_GC_ABORT = /RemoveEnvironmentCleanupHook[\s\S]*better_sqlite3\.node/
const ADDON_GC_RETRIES = 2

class ExitedBeforeMarker extends Error {
  constructor(
    message: string,
    readonly addonGcAbort: boolean,
  ) {
    super(message)
  }
}

export async function runAndKill(
  opts: RunOpts & { marker: string },
): Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string }> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await runAndKillOnce(opts)
    } catch (err) {
      if (!(err instanceof ExitedBeforeMarker && err.addonGcAbort) || attempt >= ADDON_GC_RETRIES) {
        throw err
      }
      console.warn(
        `[kill-after-write] abort do better-sqlite3 no GC antes de "${opts.marker}"; repetindo`,
      )
    }
  }
}

async function runAndKillOnce(
  opts: RunOpts & { marker: string },
): Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string }> {
  const startedAt = Date.now()
  const { child, out, exited } = start(opts)
  let timer: NodeJS.Timeout | undefined
  try {
    await new Promise<void>((res, rej) => {
      child.stdout?.on('data', () => out.stdout.includes(opts.marker) && res())
      void exited.then(({ code, signal }) =>
        rej(
          new ExitedBeforeMarker(
            `processo saiu antes de "${opts.marker}" (code=${code} signal=${signal} em ${Date.now() - startedAt}ms): ${out.stderr || out.stdout}`,
            signal === 'SIGABRT' && ADDON_GC_ABORT.test(out.stderr),
          ),
        ),
      )
      timer = setTimeout(() => {
        child.kill('SIGKILL')
        rej(
          new Error(
            `sem "${opts.marker}" em ${Date.now() - startedAt}ms (pid ${child.pid}); ` +
              `stdout=${JSON.stringify(out.stdout.slice(-400))} stderr=${JSON.stringify(out.stderr.slice(-400))}`,
          ),
        )
      }, MARKER_DEADLINE_MS)
    })
  } finally {
    clearTimeout(timer)
  }
  child.kill('SIGKILL')
  return { ...(await exited), stdout: out.stdout }
}

export async function runToEnd(opts: RunOpts): Promise<string> {
  const { out, exited } = start(opts)
  const { code } = await exited
  if (code !== 0) throw new Error(`processo saiu com ${code}: ${out.stderr}`)
  return out.stdout
}
