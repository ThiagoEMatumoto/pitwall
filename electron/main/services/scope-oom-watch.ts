import { EventEmitter } from 'node:events'
import { readFileSync, watch, type FSWatcher } from 'node:fs'
import type { ScopeOomEvent, ScopeStats } from '../../../shared/types/ipc'

// Com OOMPolicy=continue o scope sobrevive quando o kernel mata um processo por
// MemoryMax, e ninguém fica sabendo: o memory.events do cgroup é a única pista.
// inotify no arquivo (o kernel notifica a mudança) dá o aviso na hora; o polling
// cobre o caso de o watch não estar disponível.

export const OOM_POLL_MS = 15_000
const SIGKILL = 9
const CGROUP_ROOT = '/sys/fs/cgroup'

// cgroup v2: a única linha é "0::/user.slice/.../app-pitwall-session-....scope".
export function scopeCgroupDir(pid: number): string | null {
  try {
    const line = readFileSync(`/proc/${pid}/cgroup`, 'utf8')
      .split('\n')
      .find((l) => l.startsWith('0::'))
    return line ? `${CGROUP_ROOT}${line.slice(3)}` : null
  } catch {
    return null
  }
}

// null = cgroup já coletado (ou sem controlador de memória).
export function readOomKills(cgroupDir: string): number | null {
  try {
    const m = /^oom_kill (\d+)$/m.exec(readFileSync(`${cgroupDir}/memory.events`, 'utf8'))
    return m ? Number(m[1]) : null
  } catch {
    return null
  }
}

// O memory.events muda quando o kernel MANDA o SIGKILL, antes de a vítima
// morrer: sem esperar, o claude morto pelo OOM ainda pareceria vivo.
export const OOM_SETTLE_MS = 1_000
const SIGKILL_BIT = 1n << BigInt(SIGKILL - 1)

// Zumbi ou com SIGKILL pendente conta como morto: o claude já foi.
function survived(pid: number): boolean {
  try {
    const status = readFileSync(`/proc/${pid}/status`, 'utf8')
    if (/^State:\s+Z/m.test(status)) return false
    for (const m of status.matchAll(/^(?:SigPnd|ShdPnd):\s+([0-9a-f]+)$/gm)) {
      if (BigInt(`0x${m[1]}`) & SIGKILL_BIT) return false
    }
    return true
  } catch {
    return false
  }
}

export interface ScopeExecEvent {
  sessionId: string
  pid: number
  maxGB: number
}

interface PtySource {
  on(event: 'scope-exec', listener: (e: ScopeExecEvent) => void): unknown
  on(event: 'exit', listener: (e: { sessionId: string; signal: number | null }) => void): unknown
}

interface Tracked {
  pid: number
  dir: string
  maxGB: number
  baseline: number
  // oom_kill já avisado ao renderer: o exit só fala do que veio depois.
  reported: number
  timer: ReturnType<typeof setInterval>
  watcher: FSWatcher | null
  settle: ReturnType<typeof setTimeout> | null
}

export class ScopeOomWatch extends EventEmitter {
  private tracked = new Map<string, Tracked>()
  // oom-kills por sessão, inclusive das que já saíram.
  private kills = new Map<string, number>()

  constructor(private readonly pollMs = OOM_POLL_MS) {
    super()
  }

  attach(source: PtySource): void {
    source.on('scope-exec', (e) => this.track(e.sessionId, e.pid, e.maxGB))
    source.on('exit', (e) => this.onExit(e.sessionId, e.signal))
  }

  track(sessionId: string, pid: number, maxGB: number): boolean {
    this.untrack(sessionId)
    const dir = scopeCgroupDir(pid)
    const baseline = dir ? readOomKills(dir) : null
    if (!dir || baseline === null) return false
    const timer = setInterval(() => this.check(sessionId), this.pollMs)
    timer.unref?.()
    let watcher: FSWatcher | null = null
    try {
      watcher = watch(`${dir}/memory.events`, () => this.check(sessionId))
      // O cgroup some quando o scope é coletado: erro do watch não é falha.
      watcher.on('error', () => watcher?.close())
    } catch {
      watcher = null
    }
    this.tracked.set(sessionId, {
      pid,
      dir,
      maxGB,
      baseline,
      reported: baseline,
      timer,
      watcher,
      settle: null,
    })
    return true
  }

  check(sessionId: string): void {
    const t = this.tracked.get(sessionId)
    if (!t) return
    const now = readOomKills(t.dir)
    if (now === null || now <= t.reported) return
    this.record(sessionId, t, now)
    if (t.settle) return
    t.settle = setTimeout(() => this.settle(sessionId), OOM_SETTLE_MS)
    t.settle.unref?.()
  }

  private settle(sessionId: string): void {
    const t = this.tracked.get(sessionId)
    if (!t) return
    t.settle = null
    // Claude morto: quem avisa é o exit, com claudeAlive false.
    if (!survived(t.pid)) return
    t.reported = Math.max(t.reported, readOomKills(t.dir) ?? this.lastSeen(sessionId, t))
    this.emit('oom', { sessionId, maxGB: t.maxGB, claudeAlive: true } satisfies ScopeOomEvent)
  }

  private onExit(sessionId: string, signal: number | null): void {
    const t = this.tracked.get(sessionId)
    if (!t) return
    // Com outros processos no scope ele ainda existe; vazio, já pode ter sido
    // coletado, e vale a última leitura.
    const final = readOomKills(t.dir) ?? this.lastSeen(sessionId, t)
    this.record(sessionId, t, final)
    this.untrack(sessionId)
    if (signal === SIGKILL && final > t.reported) {
      this.emit('oom', { sessionId, maxGB: t.maxGB, claudeAlive: false } satisfies ScopeOomEvent)
    }
  }

  private lastSeen(sessionId: string, t: Tracked): number {
    return t.baseline + (this.kills.get(sessionId) ?? 0)
  }

  private record(sessionId: string, t: Tracked, count: number): void {
    this.kills.set(sessionId, Math.max(this.kills.get(sessionId) ?? 0, count - t.baseline))
  }

  private untrack(sessionId: string): void {
    const t = this.tracked.get(sessionId)
    if (!t) return
    clearInterval(t.timer)
    if (t.settle) clearTimeout(t.settle)
    t.watcher?.close()
    this.tracked.delete(sessionId)
  }

  stats(): ScopeStats {
    const bySession = Object.fromEntries(this.kills)
    const total = Object.values(bySession).reduce((a, b) => a + b, 0)
    return { total, bySession, watching: this.tracked.size }
  }

  stopAll(): void {
    for (const id of [...this.tracked.keys()]) this.untrack(id)
  }
}

export const scopeOomWatch = new ScopeOomWatch()
