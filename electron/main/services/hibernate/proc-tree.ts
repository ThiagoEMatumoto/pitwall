import { readdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'

// Item g da hibernação: um /exit mataria o que o claude deixou rodando embaixo
// dele (shell do Bash tool em background, navegador do Playwright). Lê a árvore
// real em /proc; falha ao ler /proc ou a raiz vira recusa — na dúvida, não hiberna.
//
// Forma real dos filhos diretos de um claude (2.1.29x, conferida com ps):
// - shell do Bash tool: `zsh -c source ~/.claude/shell-snapshots/snapshot-zsh-….sh …`.
//   Só existe enquanto um comando roda (foreground ou run_in_background).
// - servidor MCP stdio: `node …/mcp-server.js`, ou `npm exec @x/mcp` →
//   `sh -c 'x-mcp'` → node. Vivem a sessão inteira; o `sh -c` deles é launcher.
// - zumbis `[zsh] <defunct>` (estado Z) de shells que o claude não colheu.
// Por isso o shell só bloqueia com a assinatura do Bash tool, e dentro da
// subárvore de um MCP só um navegador de verdade bloqueia.

const BASH_TOOL_RE = /\bsource \S*\/shell-snapshots\//
const BROWSER_NAMES = new Set(['chrome', 'chromium', 'chromium-browser', 'headless_shell'])

export type ProcTreeVerdict = { ok: true } | { ok: false; blocker: string }

interface ProcInfo {
  pid: number
  ppid: number
  comm: string
  state: string
}

// /proc/<pid>/stat: "pid (comm) state ppid ...". O comm pode ter espaço e
// parênteses, então estado e ppid vêm depois do ÚLTIMO ')'.
function readStat(procRoot: string, pid: number): ProcInfo | null {
  let raw: string
  try {
    raw = readFileSync(join(procRoot, String(pid), 'stat'), 'utf8')
  } catch {
    return null // processo saiu entre o readdir e a leitura.
  }
  const open = raw.indexOf('(')
  const close = raw.lastIndexOf(')')
  if (open < 0 || close < open) return null
  const rest = raw.slice(close + 2).split(' ')
  const ppid = Number(rest[1])
  if (!Number.isInteger(ppid)) return null
  return { pid, ppid, comm: raw.slice(open + 1, close), state: rest[0] ?? '' }
}

function readCmdline(procRoot: string, pid: number): string {
  try {
    return readFileSync(join(procRoot, String(pid), 'cmdline'), 'utf8')
      .split('\0')
      .join(' ')
  } catch {
    return ''
  }
}

function isBrowser(comm: string, cmdline: string): boolean {
  return BROWSER_NAMES.has(comm) || BROWSER_NAMES.has(basename(cmdline.split(' ')[0] ?? ''))
}

export function inspectProcTree(rootPid: number, procRoot = '/proc'): ProcTreeVerdict {
  if (process.platform !== 'linux' && procRoot === '/proc') {
    return { ok: false, blocker: 'no-procfs' }
  }
  let entries: string[]
  try {
    entries = readdirSync(procRoot)
  } catch {
    return { ok: false, blocker: 'no-procfs' }
  }
  if (!readStat(procRoot, rootPid)) return { ok: false, blocker: 'root-gone' }
  const children = new Map<number, ProcInfo[]>()
  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue
    const info = readStat(procRoot, Number(name))
    if (!info || info.state === 'Z') continue // zumbi não roda nada.
    const list = children.get(info.ppid) ?? []
    list.push(info)
    children.set(info.ppid, list)
  }
  for (const child of children.get(rootPid) ?? []) {
    const cmdline = readCmdline(procRoot, child.pid)
    if (BASH_TOOL_RE.test(cmdline)) return { ok: false, blocker: `shell:${child.comm}` }
    // Todo o resto pendurado direto no claude é servidor MCP: só um navegador
    // aberto por ele (o do Playwright) tem estado que o /exit perderia.
    const stack = [child]
    while (stack.length) {
      const proc = stack.pop()!
      if (isBrowser(proc.comm, readCmdline(procRoot, proc.pid))) {
        return { ok: false, blocker: `browser:${proc.comm}` }
      }
      stack.push(...(children.get(proc.pid) ?? []))
    }
  }
  return { ok: true }
}
