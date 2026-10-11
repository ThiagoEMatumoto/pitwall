import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { inspectProcTree } from './proc-tree'

// Árvore REAL em /proc: o processo-raiz faz o papel do claude e os filhos são
// processos de verdade, não fixture. Grupo próprio (detached) para matar tudo.
const roots: ChildProcess[] = []

function spawnRaw(cmd: string, args: string[]): ChildProcess {
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore' })
  roots.push(child)
  return child
}
const spawnRoot = (script: string) => spawnRaw(process.execPath, ['-e', script])

const KEEP_ALIVE = 'setInterval(() => {}, 1000);'
const spawnKid = (cmd: string, args: string[]) =>
  `require('child_process').spawn(${JSON.stringify(cmd)}, ${JSON.stringify(args)}, { stdio: 'ignore' });`

async function until<T>(read: () => T, ok: (v: T) => boolean, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const v = read()
    if (ok(v) || Date.now() > deadline) return v
    await new Promise((r) => setTimeout(r, 30))
  }
}

function pgrep(args: string[]): number[] {
  try {
    return execFileSync('pgrep', args, { encoding: 'utf8' }).trim().split('\n').map(Number)
  } catch {
    return [] // pgrep sai 1 sem resultado.
  }
}

// Descendentes como "comm estado", lidos de /proc (só leitura).
function descendants(pid: number): string[] {
  const out: string[] = []
  for (const kid of pgrep(['-P', String(pid)])) {
    try {
      const stat = readFileSync(`/proc/${kid}/stat`, 'utf8')
      const close = stat.lastIndexOf(')')
      out.push(`${stat.slice(stat.indexOf('(') + 1, close)} ${stat[close + 2]}`)
    } catch {
      continue
    }
    out.push(...descendants(kid))
  }
  return out
}

// Assinatura do Bash tool do claude: `<shell> -c source …/shell-snapshots/… ; cmd`.
// O `; true` impede o bash de dar exec no último comando e sumir da árvore.
let dir: string
let snapshot: string
let fakeChrome: string
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'proc-tree-'))
  mkdirSync(join(dir, 'shell-snapshots'))
  snapshot = join(dir, 'shell-snapshots', 'snapshot-bash-test.sh')
  // `chrome` de verdade no comm: num script #! o kernel usa o nome do arquivo.
  fakeChrome = join(dir, 'chrome')
  writeFileSync(fakeChrome, '#!/bin/sh\nsleep "$1"\ntrue\n')
  chmodSync(fakeChrome, 0o755)
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

afterEach(() => {
  for (const child of roots.splice(0)) {
    try {
      process.kill(-child.pid!, 'SIGKILL')
    } catch {
      // já saiu.
    }
  }
})

describe.skipIf(process.platform !== 'linux')('inspectProcTree (processos reais)', () => {
  it('raiz sem filhos é elegível', async () => {
    const root = spawnRoot(KEEP_ALIVE)
    const verdict = await until(
      () => inspectProcTree(root.pid!),
      (v) => v.ok,
    )
    expect(verdict).toEqual({ ok: true })
  })

  it('shell com a assinatura do Bash tool recusa', async () => {
    const root = spawnRoot(
      spawnKid('bash', ['-c', `source ${snapshot} 2>/dev/null; sleep 30; true`]) + KEEP_ALIVE,
    )
    const verdict = await until(
      () => inspectProcTree(root.pid!),
      (v) => !v.ok,
    )
    expect(verdict).toEqual({ ok: false, blocker: 'shell:bash' })
  })

  it('servidor MCP via npx (launcher → sh -c → node) não recusa', async () => {
    // Forma real: `npm exec @x/mcp` → `sh -c 'x-mcp'` → node, todos vivos.
    const server = spawnKid(process.execPath, ['-e', KEEP_ALIVE, 'playwright-mcp'])
    const launcher = spawnKid('sh', ['-c', `${process.execPath} -e "${KEEP_ALIVE}"; true`])
    const root = spawnRoot(
      spawnKid(process.execPath, ['-e', launcher + KEEP_ALIVE, '@playwright/mcp']) +
        server +
        KEEP_ALIVE,
    )
    // Prova que o sh -c nasceu: sem isto o ok viria de uma árvore ainda vazia.
    const tree = await until(
      () => descendants(root.pid!),
      // node renomeia o comm para MainThread; launcher, servidor e o node do sh.
      (d) => d.includes('sh S') && d.filter((p) => p !== 'sh S').length >= 3,
    )
    expect(tree).toContain('sh S')
    expect(inspectProcTree(root.pid!)).toEqual({ ok: true })
  })

  it('navegador de verdade dentro da subárvore de um MCP recusa', async () => {
    const mcp = spawnKid('sh', ['-c', `${fakeChrome} 30; true`]) + KEEP_ALIVE
    const root = spawnRoot(spawnKid(process.execPath, ['-e', mcp]) + KEEP_ALIVE)
    const verdict = await until(
      () => inspectProcTree(root.pid!),
      (v) => !v.ok,
    )
    expect(verdict).toEqual({ ok: false, blocker: 'browser:chrome' })
  })

  it('zumbi não recusa, mesmo com nome de navegador', async () => {
    // O `chrome 0` sai na hora e o `sleep 30` (exec do sh) nunca o colhe.
    const root = spawnRaw('sh', ['-c', `${fakeChrome} 0 & exec sleep 30`])
    const tree = await until(
      () => descendants(root.pid!),
      (d) => d.includes('chrome Z'),
    )
    expect(tree).toEqual(['chrome Z'])
    expect(inspectProcTree(root.pid!)).toEqual({ ok: true })
  })

  it('raiz que já saiu recusa (na dúvida, não hiberna)', async () => {
    const root = spawnRoot('process.exit(0)')
    await new Promise<void>((r) => root.on('exit', () => r()))
    expect(inspectProcTree(root.pid!)).toEqual({ ok: false, blocker: 'root-gone' })
  })

  it('/proc ilegível recusa', () => {
    expect(inspectProcTree(process.pid, '/nonexistent-proc')).toEqual({
      ok: false,
      blocker: 'no-procfs',
    })
  })
})

// O PRODUTOR REAL: os `claude` vivos desta máquina. Só lê /proc e
// ~/.claude/sessions; nenhum sinal é enviado.
const liveClaudes = process.platform === 'linux' ? pgrep(['-x', 'claude']) : []

function sessionStatus(pid: number): string | null {
  const path = join(homedir(), '.claude', 'sessions', `${pid}.json`)
  if (!existsSync(path)) return null
  try {
    return (JSON.parse(readFileSync(path, 'utf8')) as { status?: string }).status ?? null
  } catch {
    return null
  }
}

function hasBashToolChild(pid: number): boolean {
  return pgrep(['-P', String(pid)]).some((kid) => {
    try {
      return readFileSync(`/proc/${kid}/cmdline`, 'utf8').includes('/shell-snapshots/')
    } catch {
      return false
    }
  })
}

function ancestorClaude(): number | null {
  let pid = process.pid
  while (pid > 1) {
    if (liveClaudes.includes(pid)) return pid
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    pid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1])
  }
  return null
}

describe.skipIf(liveClaudes.length === 0)('inspectProcTree (claude vivos desta máquina)', () => {
  it('sessão ociosa sem Bash tool rodando passa', () => {
    const idle = liveClaudes.filter(
      (pid) => sessionStatus(pid) === 'idle' && !hasBashToolChild(pid),
    )
    if (idle.length === 0) {
      console.warn('[proc-tree] nenhum claude ocioso sem Bash tool agora; nada a provar')
      return
    }
    const verdicts = idle.map((pid) => ({ pid, verdict: inspectProcTree(pid) }))
    expect(verdicts.filter((v) => v.verdict.ok).length, JSON.stringify(verdicts)).toBeGreaterThan(0)
  })

  it('o claude que roda este teste (Bash tool vivo) recusa', () => {
    const self = ancestorClaude()
    if (self === null) return // vitest fora de um claude.
    expect(inspectProcTree(self)).toMatchObject({
      ok: false,
      blocker: expect.stringMatching(/^shell:/),
    })
  })
})
