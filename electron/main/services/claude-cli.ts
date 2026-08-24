import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { getDb } from './db'
import { spawnEnv } from './custom-env'

const execFileAsync = promisify(execFile)

export interface RunResult {
  stdout: string
  stderr: string
  code: number
}

export interface RunOpts {
  timeoutMs?: number
  // Diretório de trabalho do processo claude. Sem isso, herda o cwd do app
  // (inútil pra job em repo). O job-runner headless passa o path do repo/scratch.
  cwd?: string
}

const CLAUDE_COMMAND_KEY = 'claude_command'

// Guard-rail para `claude -p` que processa texto de terceiros (transcript,
// ditado): nenhuma tool built-in (`--tools ""`) e nenhum servidor MCP
// (`--strict-mcp-config` sem --mcp-config). O modelo só pode responder texto —
// conteúdo injetado no prompt nunca vira execução de ação.
export const TEXT_ONLY_CLAUDE_ARGS = ['--tools', '', '--strict-mcp-config'] as const

// O claude vive tipicamente em ~/.local/bin e o env do Electron GUI não herda o
// PATH do rc do usuário. Resolvemos o caminho ABSOLUTO uma única vez via login
// shell e cacheamos. Os comandos depois rodam por execFile(absPath, ...) — NÃO
// via shell — pra evitar que linhas de banner/rc poluam o stdout do JSON.
let cachedPath: string | null = null
let resolving: Promise<string> | null = null

function prefClaudeCommand(): string {
  try {
    const row = getDb()
      .prepare('SELECT value FROM app_prefs WHERE key = ?')
      .get(CLAUDE_COMMAND_KEY) as { value: string } | undefined
    return row?.value?.trim() || 'claude'
  } catch {
    return 'claude'
  }
}

async function resolveClaudePath(): Promise<string> {
  if (cachedPath) return cachedPath
  if (resolving) return resolving

  resolving = (async () => {
    const fallback = prefClaudeCommand()
    if (process.platform === 'win32') {
      cachedPath = fallback
      return cachedPath
    }
    const shell = process.env.SHELL || 'zsh'
    try {
      const { stdout } = await execFileAsync(shell, ['-lic', 'command -v claude'], {
        timeout: 10_000,
        encoding: 'utf8',
      })
      // O login shell pode emitir banner; pegamos a última linha não-vazia que
      // pareça um caminho de executável.
      const lines = stdout
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean)
      const found = [...lines].reverse().find((l) => l.startsWith('/') || l === 'claude')
      cachedPath = found || fallback
    } catch {
      cachedPath = fallback
    }
    return cachedPath
  })()

  try {
    return await resolving
  } finally {
    resolving = null
  }
}

export async function runClaude(args: string[], opts: RunOpts = {}): Promise<RunResult> {
  const bin = await resolveClaudePath()
  try {
    const { stdout, stderr } = await execFileAsync(bin, args, {
      timeout: opts.timeoutMs ?? 60_000,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      cwd: opts.cwd,
      // process.env + vars customizadas do usuário (Configurações), lidas agora.
      env: spawnEnv(),
    })
    return { stdout, stderr, code: 0 }
  } catch (err) {
    const e = err as NodeJS.ErrnoException & {
      stdout?: string
      stderr?: string
      code?: number | string
    }
    // execFile rejeita tanto por exit code != 0 quanto por ENOENT (claude ausente).
    if (e.code === 'ENOENT') {
      return {
        stdout: '',
        stderr: `claude não encontrado (tentado: ${bin}). Verifique a instalação ou app_prefs.claude_command.`,
        code: 127,
      }
    }
    const code = typeof e.code === 'number' ? e.code : 1
    return {
      stdout: typeof e.stdout === 'string' ? e.stdout : '',
      stderr: typeof e.stderr === 'string' ? e.stderr : String(e.message ?? e),
      code,
    }
  }
}

// Extrai e parseia JSON da stdout, tolerante a linhas de banner antes do JSON:
// procura o primeiro `[` ou `{` e parseia dali até o fim.
export async function runClaudeJson<T = unknown>(
  args: string[],
  opts: RunOpts = {},
): Promise<{ data: T | null; result: RunResult }> {
  const result = await runClaude(args, opts)
  if (result.code !== 0) return { data: null, result }
  const out = result.stdout
  const start = (() => {
    const a = out.indexOf('[')
    const b = out.indexOf('{')
    if (a === -1) return b
    if (b === -1) return a
    return Math.min(a, b)
  })()
  if (start === -1) return { data: null, result }
  try {
    return { data: JSON.parse(out.slice(start)) as T, result }
  } catch {
    return { data: null, result }
  }
}
