import { execFile } from 'node:child_process'
import { totalmem } from 'node:os'
import { getPref } from './prefs-store'
import { sessionSliceCapGB, sessionSliceName } from './session-slice'

// Cada sessão roda no próprio scope transiente do systemd --user (Linux). Em
// 09/10 o systemd-oomd matou o scope inteiro do Pitwall (25G) e levou todas as
// sessões juntas; com um scope por sessão ele escolhe uma sessão. Não economiza
// RAM: só reduz o raio de perda.

export const SYSTEMD_SCOPE_PREF = 'sessions.systemdScope'
const PROBE_TIMEOUT_MS = 2_000
// Falha transitória (timeout sob pressão, unit duplicada): só aquele spawn vai
// direto, e o probe é refeito depois disto.
export const SCOPE_RETRY_BACKOFF_MS = 60_000
const UNIT_PREFIX = 'app-pitwall-session-'
// Testes de integração criam units reais: com prefixo próprio, nada que vigie as
// app-pitwall-session-* da máquina (guarda, sweep de outra instância) as alcança.
let unitPrefix = UNIT_PREFIX

// ok = wrapper em uso; unavailable = não existe nesta máquina/sessão (vale até o
// app fechar); backoff = falhou agora, tenta de novo depois de retryAt.
export type ScopeState =
  | { kind: 'unknown' }
  | { kind: 'ok' }
  | { kind: 'unavailable'; reason: string }
  | { kind: 'backoff'; reason: string; retryAt: number }

let state: ScopeState = { kind: 'unknown' }
let probe: Promise<boolean> | null = null

export function scopeState(): ScopeState {
  return state
}

function setState(next: ScopeState): void {
  state = next
  if (next.kind === 'unavailable') {
    console.warn(`[systemd-scope] scopes por sessão indisponíveis: ${next.reason}`)
  } else if (next.kind === 'backoff') {
    console.warn(
      `[systemd-scope] scopes por sessão suspensos por ${SCOPE_RETRY_BACKOFF_MS / 1000}s: ${next.reason}`,
    )
  } else if (next.kind === 'ok') {
    console.info('[systemd-scope] scopes por sessão ativos')
  }
}

// Só a ausência do binário é definitiva. "Failed to connect" acontece com o
// manager travado sob a mesma pressão de memória que motivou os scopes, e passa.
export function isPermanentScopeFailure(message: string): boolean {
  return /ENOENT/.test(message)
}

// Backoffs seguidos sem nenhum sucesso: o manager não volta, para de tentar.
const MAX_CONSECUTIVE_BACKOFFS = 5
let consecutiveBackoffs = 0

export function reportScopeFailure(reason: string): void {
  // Argumento que o systemd-run não aceitou (ex.: propriedade de memória): é bug
  // nosso, não do user manager — não entra no backoff nem desliga os scopes.
  if (/Failed to parse/i.test(reason)) {
    console.warn(`[systemd-scope] systemd-run recusou um argumento, spawn direto: ${reason}`)
    return
  }
  if (isPermanentScopeFailure(reason)) {
    setState({ kind: 'unavailable', reason })
    return
  }
  consecutiveBackoffs += 1
  if (consecutiveBackoffs >= MAX_CONSECUTIVE_BACKOFFS) {
    setState({ kind: 'unavailable', reason: `${consecutiveBackoffs} falhas seguidas: ${reason}` })
    return
  }
  setState({ kind: 'backoff', reason, retryAt: Date.now() + SCOPE_RETRY_BACKOFF_MS })
}

// Varredura de órfãos: no máximo uma por processo, e só depois de um boot que
// não veio de quit normal (crash, kill, oomd no Electron). Depois de um quit
// limpo, o que ficou rodando num scope foi deixado de propósito pelo usuário.
let sweep: 'unarmed' | 'armed' | 'done' = 'unarmed'

export function armOrphanSweep(previousShutdownWasClean: boolean): void {
  if (sweep === 'unarmed' && !previousShutdownWasClean) sweep = 'armed'
}

function sweepOnceIfArmed(): void {
  if (sweep !== 'armed') return
  sweep = 'done'
  void sweepOrphanScopes()
}

function runProbe(): Promise<boolean> {
  if (process.platform !== 'linux') {
    state = { kind: 'unavailable', reason: process.platform }
    return Promise.resolve(false)
  }
  if (!process.env.XDG_RUNTIME_DIR) {
    setState({ kind: 'unavailable', reason: 'XDG_RUNTIME_DIR ausente' })
    return Promise.resolve(false)
  }
  // Não basta o binário existir: com o user manager inalcançável (XDG_RUNTIME_DIR
  // errado, manager travado sob pressão) o systemd-run sai com 1 em ms e a PTY
  // morreria no restore. O DBUS_SESSION_BUS_ADDRESS não é pré-requisito: o
  // systemd-run --user fala com $XDG_RUNTIME_DIR/systemd/private.
  return new Promise((resolve) => {
    execFile(
      'systemd-run',
      ['--user', '--scope', '--quiet', '--collect', '--', 'true'],
      { timeout: PROBE_TIMEOUT_MS },
      (err, _stdout, stderr) => {
        if (err) {
          const killed = (err as { killed?: boolean }).killed
          reportScopeFailure(
            killed ? `probe passou de ${PROBE_TIMEOUT_MS}ms` : `${err.message} ${stderr}`.trim(),
          )
          resolve(false)
        } else {
          consecutiveBackoffs = 0
          setState({ kind: 'ok' })
          // Vale para o probe do boot e para a volta de um backoff.
          sweepOnceIfArmed()
          resolve(true)
        }
      },
    )
  })
}

// Uma vez no boot; depois só é refeito preguiçosamente ao fim de um backoff.
export function ensureScopeProbe(): Promise<boolean> {
  if (!probe) {
    probe = runProbe().finally(() => {
      probe = null
    })
  }
  return probe
}

function prefEnabled(): boolean {
  try {
    return getPref<boolean>(SYSTEMD_SCOPE_PREF, true) !== false
  } catch {
    return true
  }
}

// Sync: antes do probe terminar, com ele falho ou em backoff, o spawn é direto.
export function scopeWrapEnabled(now = Date.now()): boolean {
  if (state.kind === 'backoff' && now >= state.retryAt) void ensureScopeProbe()
  return state.kind === 'ok' && prefEnabled()
}

// O pid do main separa as units de cada instância (prod e dev rodando juntas):
// a varredura do boot só para as de instâncias mortas.
export function scopeUnitName(sessionId: string, now = Date.now(), ownerPid = process.pid): string {
  const id8 = sessionId.replace(/[^A-Za-z0-9]/g, '').slice(0, 8) || 'session'
  // O timestamp evita colisão com a unit de um resume do mesmo id ainda coletando.
  return `${unitPrefix}${ownerPid}-${id8}-${now}`
}

export function unitOwnerPid(unit: string, prefix = unitPrefix): number | null {
  if (!unit.startsWith(prefix)) return null
  const m = /^(\d+)-/.exec(unit.slice(prefix.length))
  return m ? Number(m[1]) : null
}

// O prefixo vira glob do list-units: só [a-z0-9-] e terminando em '-', para que
// um prefixo de teste nunca alcance as units app-pitwall-session-* reais.
function assertUnitPrefix(prefix: string): void {
  if (!/^[a-z0-9-]+-$/.test(prefix)) throw new Error(`prefixo de unit inválido: ${prefix}`)
}

// Teto de memória por sessão. Em 10/10 uma sessão (suítes de teste em paralelo)
// chegou a 27,9 GB e derrubou a sessão gráfica inteira: com MemoryMax o kernel
// mata dentro do scope da sessão, e o desktop e as outras sessões ficam de pé.
export const SESSION_MEMORY_MAX_PREF = 'sessions.memoryMaxGB'
export const DEFAULT_SESSION_MEMORY_MAX_GB = 18
// Sem MemoryHigh e sem swap no scope: o MemoryHigh estrangulava a sessão perto
// do teto (PSI full avg10 ~98% medido) e o systemd-oomd matava o scope inteiro
// antes de o MemoryMax agir; swap dentro do scope também gera pressão. Com só o
// MemoryMax, o kernel mata o maior processo da sessão na hora (PSI ~0) e o
// OOMPolicy=continue mantém o resto vivo.
const SWAP_MAX = '0'

export interface ScopeMemoryLimits {
  // Valores aceitos pelo systemd (ex.: '14G', '64M').
  max: string
  swapMax: string
}

const GIB = 1024 ** 3
const MIN_MAX_GB = 2

// Só 0 explícito desliga. Valor não numérico, negativo ou NaN cai no default (o
// teto nunca some por engano); o resto vira inteiro entre 2 GB e 90% da RAM, para
// nada fora de faixa chegar ao systemd-run. Nunca acima do teto do slice das
// sessões: o do scope segura uma sessão desgovernada, o do slice segura a máquina.
export function memoryLimitsFromGB(
  maxGB: unknown,
  totalMemBytes = totalmem(),
  sliceCapGB = Infinity,
): ScopeMemoryLimits | null {
  if (maxGB === 0) return null
  const wanted =
    typeof maxGB === 'number' && Number.isFinite(maxGB) && maxGB > 0
      ? maxGB
      : DEFAULT_SESSION_MEMORY_MAX_GB
  const ceiling = Math.max(
    MIN_MAX_GB,
    Math.min(sliceCapGB, Math.floor((totalMemBytes * 0.9) / GIB)),
  )
  const max = Math.min(ceiling, Math.max(MIN_MAX_GB, Math.round(wanted)))
  return { max: `${max}G`, swapMax: SWAP_MAX }
}

// Lida a cada spawn: mudar a pref vale só para sessões novas.
export function sessionMemoryLimits(): ScopeMemoryLimits | null {
  let raw: unknown = DEFAULT_SESSION_MEMORY_MAX_GB
  try {
    raw = getPref<unknown>(SESSION_MEMORY_MAX_PREF, DEFAULT_SESSION_MEMORY_MAX_GB)
  } catch {
    // Sem DB (testes, boot muito cedo): o default protege.
  }
  return memoryLimitsFromGB(raw, totalmem(), sessionSliceCapGB())
}

// --scope faz exec in-place: o pid da PTY continua sendo o do processo final.
export function wrapInScope(
  command: string,
  args: string[],
  unit: string,
  memory: ScopeMemoryLimits | null = null,
): { command: string; args: string[] } {
  const props = [
    ...(memory ? ['-p', `MemoryMax=${memory.max}`, '-p', `MemorySwapMax=${memory.swapMax}`] : []),
    // O padrão (stop) para o scope inteiro quando o kernel mata UM processo por
    // memória: um teste que estoura levaria o claude junto e o turno. Vale mesmo
    // sem teto no scope: o OOM do slice das sessões também mata aqui dentro.
    '-p',
    'OOMPolicy=continue',
  ]
  return {
    command: 'systemd-run',
    args: [
      '--user',
      '--scope',
      '--quiet',
      '--collect',
      `--slice=${sessionSliceName()}`,
      `--unit=${unit}`,
      ...props,
      '--',
      command,
      ...args,
    ],
  }
}

// Encerra a árvore inteira da sessão (MCPs, dev servers em background), não só o
// pid da PTY. Unit já coletada → erro ignorado.
export function stopScopeUnit(unit: string): void {
  execFile('systemctl', ['--user', 'stop', '--no-block', `${unit}.scope`], () => {})
}

// Dona viva = o pid existe. Comparar o programa mataria as sessões de uma
// instância dev (electron) a partir da prod (pitwall); o custo do pid reciclado é
// só deixar de varrer um órfão.
function ownerAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

// Se o main morreu (oomd no Electron, kill -9), o claude sai pelo SIGHUP da PTY,
// mas o que ele deixou em background fica preso no scope para sempre. No boot,
// para as units de instâncias que não existem mais.
export function sweepOrphanScopes(prefix = unitPrefix): Promise<string[]> {
  assertUnitPrefix(prefix)
  if (state.kind !== 'ok') return Promise.resolve([])
  return new Promise((resolve) => {
    execFile(
      'systemctl',
      ['--user', 'list-units', '--plain', '--no-legend', `${prefix}*.scope`],
      { timeout: PROBE_TIMEOUT_MS },
      (err, stdout) => {
        if (err) {
          console.warn('[systemd-scope] varredura de órfãos falhou:', err.message)
          resolve([])
          return
        }
        const stopped: string[] = []
        for (const line of stdout.split('\n')) {
          const unit = line
            .trim()
            .split(/\s+/)[0]
            ?.replace(/\.scope$/, '')
          // Defesa em profundidade: nunca para unit fora do prefixo pedido.
          if (!unit?.startsWith(prefix)) continue
          const owner = unitOwnerPid(unit, prefix)
          if (owner === null || ownerAlive(owner)) continue
          stopScopeUnit(unit)
          stopped.push(unit)
        }
        if (stopped.length)
          console.info(`[systemd-scope] ${stopped.length} scope(s) órfão(s) parado(s)`)
        resolve(stopped)
      },
    )
  })
}

// Sem argumento, volta ao prefixo de produção.
export function setScopeUnitPrefixForTests(prefix: string = UNIT_PREFIX): void {
  assertUnitPrefix(prefix)
  unitPrefix = prefix
}

export function resetScopeProbeForTests(): void {
  probe = null
  state = { kind: 'unknown' }
  consecutiveBackoffs = 0
  sweep = 'unarmed'
}
