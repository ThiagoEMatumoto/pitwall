/** @vitest-environment node */
import { afterEach, describe, expect, it } from 'vitest'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import type { ScopeOomEvent } from '../../../shared/types/ipc'
import { ScopeOomWatch, readOomKills, scopeCgroupDir } from './scope-oom-watch'
import {
  scopeUnitName,
  wrapInScope,
  ensureScopeProbe,
  resetScopeProbeForTests,
} from './systemd-scope'
import { ptyManager } from './pty-manager'
import { tmpdir } from 'node:os'

// Contra o systemd --user real: só roda onde o próprio probe passa.
const hasUserBus =
  process.platform === 'linux' &&
  spawnSync('systemd-run', ['--user', '--scope', '--quiet', '--collect', '--', 'true'], {
    timeout: 2_000,
  }).status === 0

// 512 MB tocando cada página, num scope de 64M sem swap: o kernel mata. Espera
// 1s antes de alocar, para o detector registrar o pid (e o baseline) antes.
const HOG =
  'setTimeout(()=>{const a=[];for(let i=0;i<64;i++){a.push(Buffer.alloc(8*1024*1024,1))};setInterval(()=>{},1e6)},1000)'
const LIMITS = { max: '64M', high: null, swapMax: '0' }
const MAX_GB = 64 / 1024

function commOf(pid: number): string | null {
  try {
    return readFileSync(`/proc/${pid}/comm`, 'utf8').trim()
  } catch {
    return null
  }
}

async function until(cond: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout ${timeoutMs}ms`)
    await new Promise((r) => setTimeout(r, 50))
  }
}

interface Launched {
  child: ChildProcess
  unit: string
  stdout: () => string
  exited: () => boolean
}

const launched: Launched[] = []

function launch(argv: { command: string; args: string[] }, unit: string): Launched {
  const child = spawn(argv.command, argv.args, {
    env: { ...process.env, NODE_BIN: process.execPath, HOG },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let out = ''
  let done = false
  child.stdout!.on('data', (d) => (out += String(d)))
  child.on('exit', () => (done = true))
  const l = { child, unit, stdout: () => out, exited: () => done }
  launched.push(l)
  return l
}

// O "claude" é um sh que lança um node guloso e segue vivo depois dele.
function claudeWithHungryChild(unit: string, oomPolicyContinue: boolean) {
  const argv = wrapInScope(
    'sh',
    ['-c', '"$NODE_BIN" -e "$HOG"; echo "CHILD_EXIT:$?"; sleep 120'],
    unit,
    LIMITS,
  )
  if (oomPolicyContinue) return argv
  const i = argv.args.indexOf('OOMPolicy=continue')
  return { ...argv, args: [...argv.args.slice(0, i - 1), ...argv.args.slice(i + 1)] }
}

function nextOom(watch: ScopeOomWatch, timeoutMs: number): Promise<ScopeOomEvent> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('sem evento oom')), timeoutMs)
    watch.once('oom', (e: ScopeOomEvent) => {
      clearTimeout(t)
      resolve(e)
    })
  })
}

describe.skipIf(!hasUserBus)('OOM dentro do scope da sessão × systemd real', () => {
  afterEach(() => {
    for (const l of launched.splice(0)) {
      if (!l.exited()) l.child.kill('SIGKILL')
      spawnSync('systemctl', ['--user', 'stop', `${l.unit}.scope`])
    }
  })

  it('OOMPolicy=continue: o filho morre, o processo principal segue e o detector avisa', async () => {
    const unit = scopeUnitName('oom-continue', Date.now())
    const l = launch(claudeWithHungryChild(unit, true), unit)
    const pid = l.child.pid!
    await until(() => scopeCgroupDir(pid)?.includes(unit) === true, 5_000)
    const dir = scopeCgroupDir(pid)!
    expect(dir).toContain(unit)

    // Poll longo: quem tem de avisar a tempo é o inotify do memory.events.
    const watch = new ScopeOomWatch(60_000)
    const source = new EventEmitter()
    watch.attach(source)
    const oom = nextOom(watch, 20_000)
    source.emit('scope-exec', { sessionId: 's-oom', pid, maxGB: MAX_GB })

    expect(await oom).toEqual({ sessionId: 's-oom', maxGB: MAX_GB, claudeAlive: true })
    await until(() => l.stdout().includes('CHILD_EXIT:'), 5_000)
    expect(l.stdout()).toContain('CHILD_EXIT:137')
    expect(readOomKills(dir)).toBeGreaterThanOrEqual(1)
    // Dá tempo de um stop do systemd chegar: o principal tem de seguir vivo.
    await new Promise((r) => setTimeout(r, 1_000))
    expect(l.exited()).toBe(false)
    expect(commOf(pid)).toBe('sh')
    expect(watch.stats()).toEqual({ total: 1, bySession: { 's-oom': 1 }, watching: 1 })
    watch.stopAll()
  }, 40_000)

  it('sem OOMPolicy=continue (o padrão stop), o principal morria junto', async () => {
    const unit = scopeUnitName('oom-stop', Date.now())
    const l = launch(claudeWithHungryChild(unit, false), unit)
    // O sh dormiria 120s: sair já, por sinal, é o systemd parando o scope.
    await until(() => l.exited(), 20_000)
    expect(l.child.signalCode).not.toBeNull()
    expect(l.exited()).toBe(true)
  }, 40_000)

  it('o próprio claude morto pelo kernel: no exit, avisa com claudeAlive false', async () => {
    const unit = scopeUnitName('oom-claude', Date.now())
    // Um processo de fundo (o MCP) fica no scope; o principal vira o node guloso.
    const argv = wrapInScope('sh', ['-c', 'sleep 120 & exec "$NODE_BIN" -e "$HOG"'], unit, LIMITS)
    const l = launch(argv, unit)
    const pid = l.child.pid!
    await until(() => scopeCgroupDir(pid)?.includes(unit) === true, 5_000)

    const watch = new ScopeOomWatch(60_000)
    const source = new EventEmitter()
    watch.attach(source)
    const events: ScopeOomEvent[] = []
    watch.on('oom', (e: ScopeOomEvent) => events.push(e))
    source.emit('scope-exec', { sessionId: 's-dead', pid, maxGB: MAX_GB })

    await until(() => l.exited(), 20_000)
    expect(l.child.signalCode).toBe('SIGKILL')
    source.emit('exit', { sessionId: 's-dead', signal: 9 })
    expect(events).toEqual([{ sessionId: 's-dead', maxGB: MAX_GB, claudeAlive: false }])
    expect(watch.stats().bySession['s-dead']).toBeGreaterThanOrEqual(1)
  }, 40_000)
})

// O caminho real: ptyManager.spawn num scope com teto emite scope-exec depois do
// exec, e um watcher ligado DEPOIS (restore, watcher recriado) readota a sessão.
describe.skipIf(!hasUserBus)('scope-exec do ptyManager × readoção', () => {
  const SESSION = 'oomw-readopt'
  afterEach(() => {
    ptyManager.kill(SESSION)
  })

  it('emite scope-exec com o pid final e o watcher posterior readota a sessão', async () => {
    resetScopeProbeForTests()
    expect(await ensureScopeProbe()).toBe(true)
    const early = new ScopeOomWatch(60_000)
    early.attach(ptyManager)
    const seen: string[] = []
    ptyManager.on('scope-exec', (e) => seen.push(`${e.sessionId}:${e.pid}`))
    ptyManager.spawn({
      sessionId: SESSION,
      command: '/bin/sh',
      args: ['-c', 'exec sleep 300'],
      cwd: tmpdir(),
    })
    await until(() => seen.length > 0, 5_000)
    const pid = (ptyManager as unknown as { ptys: Map<string, { pid: number }> }).ptys.get(
      SESSION,
    )!.pid
    expect(seen).toEqual([`${SESSION}:${pid}`])
    expect(early.stats().watching).toBe(1)

    const late = new ScopeOomWatch(60_000)
    late.attach(ptyManager)
    expect(late.stats().watching).toBe(1)
    early.stopAll()
    late.stopAll()
  }, 15_000)
})

describe('ScopeOomWatch — contagem limitada', () => {
  it('guarda no máximo 200 sessões na contagem de kills (LRU)', () => {
    const w = new ScopeOomWatch(60_000)
    const record = (
      w as unknown as { record: (id: string, t: { baseline: number }, n: number) => void }
    ).record.bind(w)
    for (let i = 0; i < 250; i++) record(`s${i}`, { baseline: 0 }, 1)
    const by = w.stats().bySession
    expect(Object.keys(by)).toHaveLength(200)
    expect(by.s0).toBeUndefined()
    expect(by.s249).toBe(1)
  })
})
