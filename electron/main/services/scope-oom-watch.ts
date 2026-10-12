import { EventEmitter } from 'node:events'
import { readFileSync, watch, writeFileSync, type FSWatcher } from 'node:fs'
import type { ScopeOomEvent, ScopeStats } from '../../../shared/types/ipc'

// Com OOMPolicy=continue o scope sobrevive quando o kernel mata um processo por
// MemoryMax, e ninguém fica sabendo: o memory.events do cgroup é a única pista.
// inotify no arquivo (o kernel notifica a mudança) dá o aviso na hora; o polling
// cobre o caso de o watch não estar disponível.

export const OOM_POLL_MS = 15_000
// cgroup.procs não gera evento de inotify: os pids novos chegam por poll.
export const PROCS_POLL_MS = 1_000
// No OOM do memcg o kernel soma adj × teto / 1000 ao RSS de cada processo: com
// +500 sobre o claude, um filho só perde para ele se o claude tiver meio teto a
// mais de RSS. Aumentar o próprio valor não exige privilégio; diminuir exige.
export const CHILD_OOM_ADJ_DELTA = 500
const OOM_ADJ_MAX = 1000
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

function readOomScoreAdj(pid: number): number | null {
  try {
    return Number.parseInt(readFileSync(`/proc/${pid}/oom_score_adj`, 'utf8'), 10)
  } catch {
    return null
  }
}

export function readScopePids(cgroupDir: string): number[] {
  try {
    return readFileSync(`${cgroupDir}/cgroup.procs`, 'utf8').split('\n').filter(Boolean).map(Number)
  } catch {
    return []
  }
}

// Só sobe: um filho que já pediu para morrer primeiro (adj maior) fica como está.
// false = o pid já saiu ou recusou; true = o valor final é >= target.
export function raiseOomScoreAdj(pid: number, target: number): boolean {
  const current = readOomScoreAdj(pid)
  if (current === null) return false
  if (current >= target) return true
  try {
    writeFileSync(`/proc/${pid}/oom_score_adj`, String(target))
    return true
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'ENOENT' && code !== 'ESRCH') {
      console.warn(`[scope-oom-watch] oom_score_adj do pid ${pid} falhou: ${code}`)
    }
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
  scopedSessions?(): ScopeExecEvent[]
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
  // Filhos já marcados como vítimas preferenciais do OOM do scope.
  childAdj: number
  adjusted: Set<number>
  procsTimer: ReturnType<typeof setInterval>
}

const KILLS_CAP = 200

export class ScopeOomWatch extends EventEmitter {
  private tracked = new Map<string, Tracked>()
  // oom-kills por sessão, inclusive das que já saíram.
  private kills = new Map<string, number>()

  constructor(
    private readonly pollMs = OOM_POLL_MS,
    private readonly procsPollMs = PROCS_POLL_MS,
  ) {
    super()
  }

  attach(source: PtySource): void {
    source.on('scope-exec', (e) => this.track(e.sessionId, e.pid, e.maxGB))
    source.on('exit', (e) => this.onExit(e.sessionId, e.signal))
    // Sessões que fizeram exec antes de o watcher escutar seguiriam sem monitor.
    for (const e of source.scopedSessions?.() ?? []) this.track(e.sessionId, e.pid, e.maxGB)
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
    const procsTimer = setInterval(() => this.adjustChildren(sessionId), this.procsPollMs)
    procsTimer.unref?.()
    this.tracked.set(sessionId, {
      pid,
      dir,
      maxGB,
      baseline,
      reported: baseline,
      timer,
      watcher,
      settle: null,
      childAdj: Math.min(OOM_ADJ_MAX, (readOomScoreAdj(pid) ?? 0) + CHILD_OOM_ADJ_DELTA),
      adjusted: new Set(),
      procsTimer,
    })
    this.adjustChildren(sessionId)
    return true
  }

  // Ao bater o MemoryMax o kernel mata o maior processo do scope, e o claude
  // (o pid da PTY) costuma ser o maior: os filhos (vitest, tsc, MCPs) vão antes.
  adjustChildren(sessionId: string): void {
    const t = this.tracked.get(sessionId)
    if (!t) return
    const pids = readScopePids(t.dir)
    // Pid que saiu sai do conjunto: se for reusado, o processo novo é marcado.
    for (const p of t.adjusted) if (!pids.includes(p)) t.adjusted.delete(p)
    for (const p of pids) {
      if (p === t.pid || t.adjusted.has(p)) continue
      if (raiseOomScoreAdj(p, t.childAdj)) t.adjusted.add(p)
    }
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
    const next = Math.max(this.kills.get(sessionId) ?? 0, count - t.baseline)
    // LRU: a contagem de sessões que já saíram fica para os stats, sem crescer
    // para sempre num app que roda por semanas.
    this.kills.delete(sessionId)
    this.kills.set(sessionId, next)
    while (this.kills.size > KILLS_CAP) {
      const oldest = this.kills.keys().next().value
      if (oldest === undefined) break
      this.kills.delete(oldest)
    }
  }

  private untrack(sessionId: string): void {
    const t = this.tracked.get(sessionId)
    if (!t) return
    clearInterval(t.timer)
    clearInterval(t.procsTimer)
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
