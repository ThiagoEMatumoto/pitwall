/** @vitest-environment node */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'

// A pref real da máquina (sessions.memoryMaxGB) não pode decidir o teto esperado.
vi.mock('./prefs-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./prefs-store')>()
  return {
    ...actual,
    getPref: (key: string, fallback: unknown) =>
      key === 'sessions.memoryMaxGB' ? 14 : actual.getPref(key, fallback),
  }
})

// Passthrough: o execFile real roda, mas o argv fica registrado para conferir o prefixo.
const execFileSpy = vi.hoisted(() => ({ fn: null as null | ReturnType<typeof vi.fn> }))
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  execFileSpy.fn = vi.fn((...args: unknown[]) =>
    (actual.execFile as (...a: unknown[]) => unknown)(...args),
  )
  const mod = { ...actual, execFile: execFileSpy.fn }
  return { ...mod, default: mod }
})
import { ptyManager, type PtyExitEvent } from './pty-manager'
import {
  ensureScopeProbe,
  resetScopeProbeForTests,
  scopeWrapEnabled,
  sweepOrphanScopes,
  scopeUnitName,
  wrapInScope,
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

// O kill é assíncrono: sem esperar o exit, o próximo spawn colide com a sessão viva.
async function killAndWait(): Promise<void> {
  ptyManager.kill(SESSION)
  await until(() => !ptyManager.isRunning(SESSION), 5_000)
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

  afterEach(async () => {
    restoreEnv()
    await killAndWait()
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
    // Prefixo próprio: o sweep nunca alcança as units app-pitwall-session-* reais.
    const prefix = `app-pitwall-test-${Math.random().toString(36).slice(2, 10)}-`
    const deadPid = 2 ** 22 + 4321 // acima do pid_max padrão: nunca existe
    const orphanUnit = `${prefix}${deadPid}-orphan00-${Date.now()}`
    const keepUnit = `${prefix}${process.pid}-keep0000-${Date.now()}`
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
      execFileSpy.fn!.mockClear()
      const stopped = await sweepOrphanScopes(prefix)
      expect(stopped).toContain(orphanUnit)
      expect(stopped).not.toContain(keepUnit)
      expect(stopped.every((u) => u.startsWith(prefix))).toBe(true)
      const systemctlArgs = execFileSpy
        .fn!.mock.calls.filter((c) => c[0] === 'systemctl')
        .map((c) => c[1] as string[])
      const list = systemctlArgs.find((a) => a.includes('list-units'))
      expect(list).toContain(`${prefix}*.scope`)
      expect(systemctlArgs.flat().some((a) => a.startsWith('app-pitwall-session-'))).toBe(false)
      await until(() => !unitActive(orphanUnit), 5_000)
      expect(unitActive(keepUnit)).toBe(true)
    } finally {
      // A órfã já pode ter sido coletada: stop de unit ausente sai com erro.
      spawnSync('systemctl', ['--user', 'stop', `${orphanUnit}.scope`, `${keepUnit}.scope`])
    }
  }, 20_000)
})

function unitProp(unit: string, prop: string): string {
  return execFileSync('systemctl', ['--user', 'show', '-p', prop, '--value', `${unit}.scope`], {
    encoding: 'utf8',
  }).trim()
}

describe.skipIf(!hasUserBus)('teto de memória do scope × systemd real', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'info').mockImplementation(() => {})
    resetScopeProbeForTests()
  })

  afterEach(async () => {
    await killAndWait()
  })

  it('o scope da sessão nasce com MemoryMax/High/SwapMax do default (14G/10G/2G)', async () => {
    expect(await ensureScopeProbe()).toBe(true)
    spawnLogin('sleep 300')
    const pid = ptyPid()
    await until(() => commOf(pid) === 'sleep', 5_000)
    const unit = ptyManager.scopeUnitFor(SESSION)!
    // Sob carga o systemctl show pode ler a unit antes de ela estar ativa.
    await until(() => unitActive(unit), 5_000)
    const gib = 1024 ** 3
    expect(unitProp(unit, 'MemoryMax')).toBe(String(14 * gib))
    expect(unitProp(unit, 'MemoryHigh')).toBe(String(10 * gib))
    expect(unitProp(unit, 'MemorySwapMax')).toBe(String(2 * gib))
  }, 15_000)

  it('quem passa do MemoryMax é morto pelo kernel dentro do scope; o pai sobrevive', () => {
    const unit = scopeUnitName('memcap-it', Date.now())
    // Aloca 512 MB tocando cada página, num scope de 64M sem swap.
    const hog =
      'const a=[];for(let i=0;i<64;i++){const b=Buffer.alloc(8*1024*1024,1);a.push(b)};console.log("SOBREVIVEU")'
    const { command, args } = wrapInScope(process.execPath, ['-e', hog], unit, {
      max: '64M',
      high: null,
      swapMax: '0',
    })
    const r = spawnSync(command, args, { encoding: 'utf8', timeout: 30_000 })
    expect(r.stdout).not.toContain('SOBREVIVEU')
    // OOM kill do cgroup: SIGKILL no processo, que o systemd-run (exec in-place) repassa.
    expect(r.signal === 'SIGKILL' || r.status === 137).toBe(true)
    expect(alive(process.pid)).toBe(true)
  }, 40_000)
})
