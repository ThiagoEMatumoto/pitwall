/** @vitest-environment node */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { ptyManager, type PtyExitEvent } from './pty-manager'
import { ensureScopeProbe, resetScopeProbeForTests, scopeWrapEnabled } from './systemd-scope'

// Contra o systemd --user real: só roda no Linux com o user manager alcançável.
const hasUserBus = process.platform === 'linux' && !!process.env.XDG_RUNTIME_DIR
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
    expect(unit).toMatch(/^app-pitwall-session-sc0peits-\d+$/)
    expect(cgroupOf(pid)).toContain(`/app.slice/${unit}.scope`)
  }, 15_000)

  it('kill encerra o processo e, depois do grace, a árvore que sobrou no scope', async () => {
    await ensureScopeProbe()
    // Um órfão em background segura o scope vivo depois do SIGHUP no pid da PTY.
    spawnLogin(`sh -c 'sleep 301 & echo ORPHAN=$!; exec sleep 300'`)
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
    expect(cgroupOf(pid)).not.toContain('app-pitwall-session-')
  }, 15_000)

  it('fallback de runtime: systemd-run morre antes do exec → respawn direto uma vez', async () => {
    expect(await ensureScopeProbe()).toBe(true)
    // O manager fica inalcançável depois do probe: o systemd-run sai com erro em ms.
    breakUserManager()
    let exitEmitted = false
    const onExit = (e: PtyExitEvent): void => {
      if (e.sessionId === SESSION) exitEmitted = true
    }
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
    expect(exitEmitted).toBe(false)
    expect(ptyManager.scopeUnitFor(SESSION)).toBeNull()
    expect(cgroupOf(pid)).not.toContain('app-pitwall-session-')
    expect(scopeWrapEnabled()).toBe(false)
  }, 15_000)
})
