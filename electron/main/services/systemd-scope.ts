import { execFile } from 'node:child_process'
import { getPref } from './prefs-store'

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
  return `${UNIT_PREFIX}${ownerPid}-${id8}-${now}`
}

export function unitOwnerPid(unit: string): number | null {
  const m = new RegExp(`^${UNIT_PREFIX}(\\d+)-`).exec(unit)
  return m ? Number(m[1]) : null
}

// --scope faz exec in-place: o pid da PTY continua sendo o do processo final.
export function wrapInScope(
  command: string,
  args: string[],
  unit: string,
): { command: string; args: string[] } {
  return {
    command: 'systemd-run',
    args: [
      '--user',
      '--scope',
      '--quiet',
      '--collect',
      '--slice=app.slice',
      `--unit=${unit}`,
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
export function sweepOrphanScopes(): Promise<string[]> {
  if (state.kind !== 'ok') return Promise.resolve([])
  return new Promise((resolve) => {
    execFile(
      'systemctl',
      ['--user', 'list-units', '--plain', '--no-legend', `${UNIT_PREFIX}*.scope`],
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
          if (!unit) continue
          const owner = unitOwnerPid(unit)
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

export function resetScopeProbeForTests(): void {
  probe = null
  state = { kind: 'unknown' }
  consecutiveBackoffs = 0
  sweep = 'unarmed'
}
