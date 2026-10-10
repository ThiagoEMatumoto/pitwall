import { readdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'

// Item g da hibernação: um /exit mataria o que o claude deixou rodando embaixo
// dele (shell em background, navegador do Playwright, Monitor). Lê a árvore real
// em /proc; qualquer leitura que falhe vira recusa — na dúvida, não hiberna.

const SHELLS = new Set(['bash', 'zsh', 'sh', 'dash', 'fish'])
const BROWSER_RE = /chrom(e|ium)|headless_shell|playwright/i

export type ProcTreeVerdict = { ok: true } | { ok: false; blocker: string }

interface ProcInfo {
  pid: number
  ppid: number
  comm: string
}

// /proc/<pid>/stat: "pid (comm) state ppid ...". O comm pode ter espaço e
// parênteses, então o ppid vem depois do ÚLTIMO ')'.
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
  return { pid, ppid, comm: raw.slice(open + 1, close) }
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

function blockerOf(comm: string, cmdline: string): string | null {
  const exe = basename(cmdline.split(' ')[0] ?? '')
  if (SHELLS.has(comm) || SHELLS.has(exe)) return `shell:${comm}`
  if (BROWSER_RE.test(comm) || BROWSER_RE.test(cmdline)) return `browser:${comm}`
  if (cmdline.includes('Monitor')) return `monitor:${comm}`
  return null
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
    if (!info) continue
    const list = children.get(info.ppid) ?? []
    list.push(info)
    children.set(info.ppid, list)
  }
  const stack = [...(children.get(rootPid) ?? [])]
  while (stack.length) {
    const proc = stack.pop()!
    const blocker = blockerOf(proc.comm, readCmdline(procRoot, proc.pid))
    if (blocker) return { ok: false, blocker }
    stack.push(...(children.get(proc.pid) ?? []))
  }
  return { ok: true }
}
