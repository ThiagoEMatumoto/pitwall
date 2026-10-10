import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { inspectProcTree } from './proc-tree'

// Árvore REAL em /proc: o processo-raiz faz o papel do claude e os filhos são
// processos de verdade, não fixture. Grupo próprio (detached) para matar tudo.
const roots: ChildProcess[] = []

function spawnRoot(script: string, args: string[] = []): ChildProcess {
  const child = spawn(process.execPath, ['-e', script, ...args], {
    detached: true,
    stdio: 'ignore',
  })
  roots.push(child)
  return child
}

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

function childComms(pid: number): string[] {
  try {
    return execFileSync('pgrep', ['-l', '-P', String(pid)], { encoding: 'utf8' })
      .trim()
      .split('\n')
      .map((l) => l.split(' ')[1] ?? '')
  } catch {
    return [] // pgrep sai 1 sem filhos.
  }
}

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

  it('filho que não é shell nem navegador não bloqueia', async () => {
    const root = spawnRoot(spawnKid('sleep', ['30']) + KEEP_ALIVE)
    // Prova que o sleep nasceu: sem isto o ok viria de uma árvore ainda vazia.
    const kids = await until(
      () => childComms(root.pid!),
      (c) => c.includes('sleep'),
    )
    expect(kids).toContain('sleep')
    expect(inspectProcTree(root.pid!)).toEqual({ ok: true })
  })

  it('shell filho recusa', async () => {
    const root = spawnRoot(spawnKid('sh', ['-c', 'sleep 30; true']) + KEEP_ALIVE)
    const verdict = await until(
      () => inspectProcTree(root.pid!),
      (v) => !v.ok,
    )
    expect(verdict).toEqual({ ok: false, blocker: 'shell:sh' })
  })

  it('shell NETO também recusa (descendentes, não só filhos)', async () => {
    const inner = spawnKid('sh', ['-c', 'sleep 30; true']) + KEEP_ALIVE
    const root = spawnRoot(spawnKid(process.execPath, ['-e', inner]) + KEEP_ALIVE)
    const verdict = await until(
      () => inspectProcTree(root.pid!),
      (v) => !v.ok,
    )
    expect(verdict).toEqual({ ok: false, blocker: 'shell:sh' })
  })

  it('processo com "Monitor" no cmdline recusa', async () => {
    const root = spawnRoot(
      spawnKid(process.execPath, ['-e', KEEP_ALIVE, 'Monitor', 'tail-logs']) + KEEP_ALIVE,
    )
    const verdict = await until(
      () => inspectProcTree(root.pid!),
      (v) => !v.ok,
    )
    expect(verdict.ok).toBe(false)
    expect(!verdict.ok && verdict.blocker).toMatch(/^monitor:/)
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
