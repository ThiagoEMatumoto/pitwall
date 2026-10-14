import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { totalmem } from 'node:os'
import { getPref } from './prefs-store'
import { readOomKills } from './scope-oom-watch'

// O teto por scope não segura a máquina: em 14/10 nenhuma sessão chegou ao
// próprio MemoryMax, mas a soma delas (eslint, tsc, bun test em sessões
// diferentes) somada ao desktop esgotou a RAM, e quem matou foi o earlyoom, às
// cegas. Com todas as sessões num slice com teto, o kernel mata o maior processo
// DENTRO das sessões antes de o desktop passar fome.
export const SESSION_SLICE = 'pitwall-sessions.slice'
let sliceName = SESSION_SLICE

export const SESSION_MEMORY_RESERVE_PREF = 'sessions.memoryReserveGB'
// Sem pref gravada: 25% da RAM, no máximo 8 GB. Fixos, os 8 GB deixavam uma
// máquina de 8 GB com o teto no piso.
export const MAX_DEFAULT_SESSION_MEMORY_RESERVE_GB = 8
const DEFAULT_RESERVE_RAM_FRACTION = 0.25
const GIB = 1024 ** 3
const MIN_SLICE_GB = 2
const SYSTEMCTL_TIMEOUT_MS = 5_000
// Falha do set-property (sem bus do user manager, por exemplo) quase nunca se
// resolve sozinha entre um spawn e outro: espera antes de tentar de novo.
export const SLICE_SYNC_RETRY_MS = 5 * 60_000
const CGROUP_ROOT = '/sys/fs/cgroup'

export function sessionSliceName(): string {
  return sliceName
}

function defaultReserveGB(totalMemBytes: number): number {
  return Math.min(
    MAX_DEFAULT_SESSION_MEMORY_RESERVE_GB,
    Math.ceil((totalMemBytes / GIB) * DEFAULT_RESERVE_RAM_FRACTION),
  )
}

// Reserva ausente ou inválida cai no default (o teto nunca some por engano).
// 0 = sem reserva.
export function sliceCapGBFromReserve(reserveGB: unknown, totalMemBytes = totalmem()): number {
  const reserve =
    typeof reserveGB === 'number' && Number.isFinite(reserveGB) && reserveGB >= 0
      ? reserveGB
      : defaultReserveGB(totalMemBytes)
  return Math.max(MIN_SLICE_GB, Math.floor(totalMemBytes / GIB - reserve))
}

export function sessionSliceCapGB(totalMemBytes = totalmem()): number {
  let raw: unknown
  try {
    raw = getPref<unknown>(SESSION_MEMORY_RESERVE_PREF, undefined)
  } catch {
    // Sem DB (testes, boot muito cedo): o default protege.
  }
  return sliceCapGBFromReserve(raw, totalMemBytes)
}

let appliedGB: number | null = null
let inflight: { gb: number; done: Promise<boolean> } | null = null
let failedAt: number | null = null

export function appliedSliceCapGB(): number | null {
  return appliedGB
}

// --runtime: o drop-in vai para /run/user (some no reboot) e o app reaplica a
// cada boot; nenhum arquivo persistente na máquina. Funciona com o slice ainda
// inativo, antes do primeiro scope. Sem MemoryHigh (#326: o throttling fazia o
// systemd-oomd matar a sessão inteira) e sem swap, como nos scopes.
export function syncSessionSlice(capGB = sessionSliceCapGB()): Promise<boolean> {
  if (capGB === appliedGB) return Promise.resolve(true)
  if (inflight?.gb === capGB) return inflight.done
  if (failedAt !== null && Date.now() - failedAt < SLICE_SYNC_RETRY_MS) {
    return Promise.resolve(false)
  }
  const done = new Promise<boolean>((resolve) => {
    execFile(
      'systemctl',
      ['--user', 'set-property', '--runtime', sliceName, `MemoryMax=${capGB}G`, 'MemorySwapMax=0'],
      { timeout: SYSTEMCTL_TIMEOUT_MS },
      (err, _stdout, stderr) => {
        if (inflight?.done === done) inflight = null
        if (err) {
          failedAt = Date.now()
          console.warn(
            `[session-slice] teto do ${sliceName} não aplicado: ${`${err.message} ${stderr}`.trim()}`,
          )
          resolve(false)
          return
        }
        appliedGB = capGB
        failedAt = null
        console.info(`[session-slice] ${sliceName} MemoryMax=${capGB}G`)
        resolve(true)
      },
    )
  })
  inflight = { gb: capGB, done }
  return done
}

// Slices aninham pelos hífens: pitwall-sessions.slice mora em pitwall.slice.
function sliceRelPath(name: string): string {
  const parts = name.replace(/\.slice$/, '').split('-')
  return parts.map((_, i) => `${parts.slice(0, i + 1).join('-')}.slice`).join('/')
}

// O main roda sob o mesmo user manager (user@UID.service) que cria os scopes.
export function sliceCgroupDir(selfCgroup?: string): string | null {
  let content = selfCgroup
  if (content === undefined) {
    try {
      content = readFileSync('/proc/self/cgroup', 'utf8')
    } catch {
      return null
    }
  }
  const line = content.split('\n').find((l) => l.startsWith('0::'))
  const m = line ? /^0::(.*\/user@\d+\.service)(?:\/|$)/.exec(line) : null
  return m ? `${CGROUP_ROOT}${m[1]}/${sliceRelPath(sliceName)}` : null
}

function statField(stat: string, key: string): number | null {
  const m = new RegExp(`^${key} (\\d+)$`, 'm').exec(stat)
  return m ? Number(m[1]) : null
}

// Page cache reclamável (file − shmem) do slice; null = memory.stat ilegível.
// Sem swap no slice, o shmem não sai da RAM e conta como uso.
function reclaimableFile(dir: string, read: (path: string) => string): number | null {
  try {
    const stat = read(`${dir}/memory.stat`)
    const file = statField(stat, 'file')
    const shmem = statField(stat, 'shmem')
    return file === null || shmem === null ? null : Math.max(0, file - shmem)
  } catch {
    return null
  }
}

// Uso não-reclamável do slice em fração do teto; null = sem teto ou sem leitura.
// O memory.current inclui o page cache de builds, que o kernel devolve sob
// pressão: medido cru, o slice ficava acima de 85% para sempre e a fila de
// resume pós-OOM nunca andava.
export function sliceMemoryFraction(
  dir: string | null = sliceCgroupDir(),
  read: (path: string) => string = (p) => readFileSync(p, 'utf8'),
): number | null {
  if (!dir) return null
  try {
    const max = read(`${dir}/memory.max`).trim()
    if (max === 'max') return null
    const current = Number(read(`${dir}/memory.current`))
    const used = current - (reclaimableFile(dir, read) ?? 0)
    return Math.max(0, used) / Number(max)
  } catch {
    return null
  }
}

export const SLICE_OOM_POLL_MS = 15_000

// Sinal de teto pequeno demais: o kernel matando tooling legítimo o tempo todo.
// O contador do memory.events do slice vai para o log a cada kill novo, com o
// teto em vigor, e fica legível em sessions:scope-stats.
export class SliceOomLog {
  private last = 0
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(
    private readonly readKills: () => number | null = () => {
      const dir = sliceCgroupDir()
      return dir ? readOomKills(dir) : null
    },
    private readonly capGB: () => number | null = appliedSliceCapGB,
  ) {}

  check(): void {
    const kills = this.readKills()
    if (kills === null || kills <= this.last) return
    const cap = this.capGB()
    console.warn(
      `[session-slice] oom_kill=${kills} (+${kills - this.last}) no ${sliceName}, MemoryMax=${cap === null ? '?' : `${cap}G`}`,
    )
    this.last = kills
  }

  count(): number {
    return this.last
  }

  start(pollMs = SLICE_OOM_POLL_MS): void {
    if (this.timer) return
    this.check()
    this.timer = setInterval(() => this.check(), pollMs)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }
}

// Testes de integração criam scopes reais: num slice próprio, nunca no das
// sessões do usuário.
export function setSessionSliceForTests(name: string = SESSION_SLICE): void {
  if (!/^[a-z0-9-]+\.slice$/.test(name)) throw new Error(`slice inválido: ${name}`)
  sliceName = name
  appliedGB = null
  inflight = null
  failedAt = null
}

export function resetSessionSliceForTests(): void {
  setSessionSliceForTests()
}
