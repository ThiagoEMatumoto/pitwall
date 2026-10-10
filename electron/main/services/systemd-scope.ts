import { execFile } from 'node:child_process'
import { getPref } from './prefs-store'

// Cada sessão roda no próprio scope transiente do systemd --user (Linux). Em
// 09/10 o systemd-oomd matou o scope inteiro do Pitwall (25G) e levou todas as
// sessões juntas; com um scope por sessão ele escolhe uma sessão. Não economiza
// RAM: só reduz o raio de perda.

export const SYSTEMD_SCOPE_PREF = 'sessions.systemdScope'
const PROBE_TIMEOUT_MS = 2_000

let probe: Promise<boolean> | null = null
let probeResult: boolean | null = null
let disabledReason: string | null = null

function runProbe(): Promise<boolean> {
  if (process.platform !== 'linux') return Promise.resolve(false)
  // Não basta o binário existir: com o user manager inalcançável (XDG_RUNTIME_DIR
  // errado, manager travado sob pressão) o systemd-run sai com 1 em ms e a PTY
  // morreria no restore. O DBUS_SESSION_BUS_ADDRESS não é pré-requisito: o
  // systemd-run --user fala com $XDG_RUNTIME_DIR/systemd/private.
  return new Promise((resolve) => {
    execFile(
      'systemd-run',
      ['--user', '--scope', '--quiet', '--collect', '--', 'true'],
      { timeout: PROBE_TIMEOUT_MS },
      (err) => {
        if (err) {
          disableScopes(`probe falhou: ${err.message.split('\n')[0]}`)
          resolve(false)
        } else resolve(true)
      },
    )
  })
}

// Roda uma vez por processo; o resultado vale até o app fechar.
export function ensureScopeProbe(): Promise<boolean> {
  if (!probe) {
    probe = runProbe().then((ok) => {
      probeResult = ok && disabledReason === null
      return probeResult
    })
  }
  return probe
}

export function disableScopes(reason: string): void {
  if (disabledReason) return
  disabledReason = reason
  probeResult = false
  console.warn(`[systemd-scope] scopes por sessão desligados: ${reason}`)
}

function prefEnabled(): boolean {
  try {
    return getPref<boolean>(SYSTEMD_SCOPE_PREF, true) !== false
  } catch {
    return true
  }
}

// Sync: antes do probe terminar (ou com ele falho) o spawn é direto.
export function scopeWrapEnabled(): boolean {
  return probeResult === true && prefEnabled()
}

export function scopeUnitName(sessionId: string, now = Date.now()): string {
  const id8 = sessionId.replace(/[^A-Za-z0-9]/g, '').slice(0, 8) || 'session'
  // O timestamp evita colisão com a unit de um resume do mesmo id ainda coletando.
  return `app-pitwall-session-${id8}-${now}`
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

export function resetScopeProbeForTests(): void {
  probe = null
  probeResult = null
  disabledReason = null
}
