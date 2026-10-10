/** @vitest-environment node */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { ptyManager, type PtyExitEvent } from './pty-manager'
import {
  ensureScopeProbe,
  resetScopeProbeForTests,
  scopeWrapEnabled,
  sweepOrphanScopes,
} from './systemd-scope'

// Contra o systemd --user real: só roda onde o próprio probe passa.
const hasUserBus =
  process.platform === 'linux' &&
  spawnSync('systemd-run', ['--user', '--scope', '--quiet', '--collect', '--', 'true'], {
    timeout: 2_000,
  }).status === 0
const SESSION = 'sc0pe-it-session'
const SHELL = process.env.SHELL || '/bin/sh'
const originalBus = process.env.DBUS_SESSION_BUS_ADDRESS
const originalRuntime = process.env.XDG_RUNTIME_DIR

// Manager inalcançável: o systemd-run --user sai com 1 antes do exec.
function breakUserManager(): void {
  process.env.DBUS_SESSION_BUS_ADDRESS = 'unix:path=/nonexistent/bus'
  process.env.XDG_RUNTIME_DIR = '/nonexistent'
}

function restoreEnv(): void {
  process.env.DBUS_SESSION_BUS_ADDRESS = originalBus
  process.env.XDG_RUNTIME_DIR = originalRuntime
}

function cgroupOf(pid: number): string {
  return readFileSync(`/proc/${pid}/cgroup`, 'utf8').trim()
}

function commOf(pid: number): string | null {
  try {
    return readFileSync(`/proc/${pid}/comm`, 'utf8').trim()
  } catch {
    return null
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function unitActive(unit: string): boolean {
  try {
    execFileSync('systemctl', ['--user', 'is-active', '--quiet', `${unit}.scope`])
    return true
  } catch {
    return false
  }
}

async function until(cond: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout ${timeoutMs}ms`)
    await new Promise((r) => setTimeout(r, 50))
  }
}

// Igual ao loginShellSpawn (sessions.ts): o wrapper envolve o shell de login.
function spawnLogin(innerCmd: string): void {
  ptyManager.spawn({
    sessionId: SESSION,
    command: SHELL,
    args: ['-l', '-i', '-c', `exec ${innerCmd}`],
    cwd: tmpdir(),
  })
}

function ptyPid(): number {
  // node-pty não expõe o mapa; o pid vem do processo cujo cgroup/comm testamos.
  const pid = (ptyManager as unknown as { ptys: Map<string, { pid: number }> }).ptys.get(
    SESSION,
  )?.pid
  if (!pid) throw new Error('pty não encontrada')
  return pid
}

function nextExit(): Promise<PtyExitEvent> {
  return new Promise((resolve) => {
    const onExit = (e: PtyExitEvent): void => {
      if (e.sessionId !== SESSION) return
      ptyManager.off('exit', onExit)
      resolve(e)
    }
    ptyManager.on('exit', onExit)
  })
}

describe.skipIf(!hasUserBus)('scope systemd por sessão × ptyManager.spawn real', () => {
  beforeEach(async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'info').mockImplementation(() => {})
    resetScopeProbeForTests()
    restoreEnv()
  })

  afterEach(() => {
    restoreEnv()
    ptyManager.kill(SESSION)
  })

  it('pty.pid é o processo final, dentro do scope da sessão em app.slice', async () => {
    expect(await ensureScopeProbe()).toBe(true)
    spawnLogin('sleep 300')
    const pid = ptyPid()
    await until(() => commOf(pid) === 'sleep', 5_000)
    const unit = ptyManager.scopeUnitFor(SESSION)!
    expect(unit).toMatch(new RegExp(`^app-pitwall-session-${process.pid}-sc0peits-\\d+$`))
    expect(cgroupOf(pid)).toContain(`/app.slice/${unit}.scope`)
  }, 15_000)

  it('kill encerra o processo e, depois do grace, a árvore que sobrou no scope', async () => {
    await ensureScopeProbe()
    // Órfão em outra sessão (setsid): escapa do SIGHUP da PTY e só o stop do scope o mata.
    spawnLogin(
      `sh -c 'setsid sleep 301 </dev/null >/dev/null 2>&1 & echo ORPHAN=$!; exec sleep 300'`,
    )
    const pid = ptyPid()
    let out = ''
    const onData = (e: { sessionId: string; data: string }): void => {
      if (e.sessionId === SESSION) out += e.data
    }
    ptyManager.on('data', onData)
    await until(() => /ORPHAN=(\d+)/.test(out), 5_000)
    ptyManager.off('data', onData)
    const orphan = Number(/ORPHAN=(\d+)/.exec(out)![1])
    const unit = ptyManager.scopeUnitFor(SESSION)!
    expect(cgroupOf(orphan)).toContain(`${unit}.scope`)

    const exited = nextExit()
    ptyManager.kill(SESSION)
    await exited
    expect(alive(pid)).toBe(false)
    // Sem o stop, o órfão sobreviveria: vivo logo após o exit, morto depois do grace.
    expect(alive(orphan)).toBe(true)
    expect(unitActive(unit)).toBe(true)
    await until(() => !alive(orphan) && !unitActive(unit), 8_000)
  }, 20_000)

  it('^C na PTY interrompe o comando em primeiro plano', async () => {
    await ensureScopeProbe()
    spawnLogin(`sh -c 'sleep 300; echo NAO-INTERROMPEU'`)
    const pid = ptyPid()
    await until(() => ptyManager.getBacklog(SESSION).length > 0 || commOf(pid) === 'sh', 5_000)
    await new Promise((r) => setTimeout(r, 300))
    const exited = nextExit()
    ptyManager.write(SESSION, '\x03')
    const e = await Promise.race([
      exited,
      new Promise<null>((r) => setTimeout(() => r(null), 3_000)),
    ])
    expect(e).not.toBeNull()
    expect(ptyManager.getBacklog(SESSION)).not.toContain('NAO-INTERROMPEU')
  }, 15_000)

  it('fallback do probe: user manager inalcançável → spawn direto, fora do scope de sessão', async () => {
    breakUserManager()
    expect(await ensureScopeProbe()).toBe(false)
    spawnLogin('sleep 300')
    const pid = ptyPid()
    await until(() => commOf(pid) === 'sleep', 5_000)
    expect(ptyManager.scopeUnitFor(SESSION)).toBeNull()
    // Spawn direto herda o cgroup do processo de teste — que pode já ser o scope de
    // uma sessão do Pitwall quando o vitest roda dentro dela.
    expect(cgroupOf(pid)).toBe(cgroupOf(process.pid))
  }, 15_000)

  it('fallback de runtime: systemd-run morre antes do exec → respawn direto uma vez', async () => {
    expect(await ensureScopeProbe()).toBe(true)
    // O manager fica inalcançável depois do probe: o systemd-run sai com erro em ms.
    breakUserManager()
    let exitEmitted = false
    let seen = ''
    const onExit = (e: PtyExitEvent): void => {
      if (e.sessionId === SESSION) exitEmitted = true
    }
    const onData = (e: { sessionId: string; data: string }): void => {
      if (e.sessionId === SESSION) seen += e.data
    }
    ptyManager.on('data', onData)
    ptyManager.on('exit', onExit)
    spawnLogin('sleep 300')
    await until(() => {
      const p = (ptyManager as unknown as { ptys: Map<string, { pid: number }> }).ptys.get(
        SESSION,
      )?.pid
      return !!p && commOf(p) === 'sleep'
    }, 8_000)
    ptyManager.off('exit', onExit)
    const pid = ptyPid()
    ptyManager.off('data', onData)
    expect(exitEmitted).toBe(false)
    // O erro do systemd-run não vira o "primeiro data" (que arma o comando inicial).
    expect(seen).not.toContain('Failed to')
    expect(ptyManager.getBacklog(SESSION)).not.toContain('Failed to')
    expect(ptyManager.scopeUnitFor(SESSION)).toBeNull()
    expect(cgroupOf(pid)).toBe(cgroupOf(process.pid))
    expect(scopeWrapEnabled()).toBe(false)
  }, 15_000)

  it('varredura do boot para o scope de uma instância morta e poupa o desta', async () => {
    expect(await ensureScopeProbe()).toBe(true)
    const deadPid = 2 ** 22 + 4321 // acima do pid_max padrão: nunca existe
    const orphanUnit = `app-pitwall-session-${deadPid}-orphan00-${Date.now()}`
    const keepUnit = `app-pitwall-session-${process.pid}-keep0000-${Date.now()}`
    const start = (unit: string): void => {
      spawn(
        'systemd-run',
        ['--user', '--scope', '--quiet', '--collect', `--unit=${unit}`, '--', 'sleep', '300'],
        { detached: true, stdio: 'ignore' },
      ).unref()
    }
    start(orphanUnit)
    start(keepUnit)
    try {
      await until(() => unitActive(orphanUnit) && unitActive(keepUnit), 5_000)
      const stopped = await sweepOrphanScopes()
      expect(stopped).toContain(orphanUnit)
      expect(stopped).not.toContain(keepUnit)
      await until(() => !unitActive(orphanUnit), 5_000)
      expect(unitActive(keepUnit)).toBe(true)
    } finally {
      // A órfã já pode ter sido coletada: stop de unit ausente sai com erro.
      spawnSync('systemctl', ['--user', 'stop', `${orphanUnit}.scope`, `${keepUnit}.scope`])
    }
  }, 20_000)
})
