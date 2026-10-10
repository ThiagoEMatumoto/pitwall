import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const getPref = vi.fn()
vi.mock('./prefs-store', () => ({
  getPref: (key: string, fallback: unknown) => getPref(key, fallback),
}))

type ExecCb = (err: (Error & { killed?: boolean }) | null, stdout: string, stderr: string) => void
const execFile = vi.fn()
vi.mock('node:child_process', () => {
  const mod = { execFile: (...args: unknown[]) => execFile(...args) }
  return { ...mod, default: mod }
})

import {
  SCOPE_RETRY_BACKOFF_MS,
  SYSTEMD_SCOPE_PREF,
  ensureScopeProbe,
  isPermanentScopeFailure,
  reportScopeFailure,
  resetScopeProbeForTests,
  scopeState,
  scopeUnitName,
  scopeWrapEnabled,
  sweepOrphanScopes,
  unitOwnerPid,
  wrapInScope,
} from './systemd-scope'

const originalPlatform = process.platform

function setPlatform(p: string): void {
  Object.defineProperty(process, 'platform', { value: p })
}

beforeEach(() => {
  resetScopeProbeForTests()
  getPref.mockReset().mockImplementation((_k: string, fallback: unknown) => fallback)
  execFile.mockReset()
  setPlatform('linux')
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'info').mockImplementation(() => {})
})

afterEach(() => {
  setPlatform(originalPlatform)
})

// Assíncrono como o execFile real: o callback nunca roda dentro da chamada.
function probeExits(err: (Error & { killed?: boolean }) | null, stderr = ''): void {
  execFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: ExecCb) =>
    setImmediate(() => cb(err, '', stderr)),
  )
}

describe('scopeUnitName', () => {
  it('carrega o pid do main, os 8 primeiros alfanuméricos do id e o timestamp', () => {
    const unit = scopeUnitName('3f2a9c1e-7b4d-4e8a', 1700, 4242)
    expect(unit).toBe('app-pitwall-session-4242-3f2a9c1e-1700')
    expect(unitOwnerPid(unit)).toBe(4242)
  })

  it('descarta caracteres inválidos em nome de unit', () => {
    expect(scopeUnitName('a/b c\\d', 1, 7)).toBe('app-pitwall-session-7-abcd-1')
    expect(scopeUnitName('---', 1, 7)).toBe('app-pitwall-session-7-session-1')
  })

  it('unit sem pid do dono não tem dono', () => {
    expect(unitOwnerPid('app-pitwall-session-abc')).toBeNull()
  })
})

describe('wrapInScope', () => {
  it('envolve o argv do shell de login, não o binário do claude', () => {
    const shellArgs = ['-l', '-i', '-c', 'exec claude --resume x']
    expect(wrapInScope('/usr/bin/zsh', shellArgs, 'app-pitwall-session-1-abc-1')).toEqual({
      command: 'systemd-run',
      args: [
        '--user',
        '--scope',
        '--quiet',
        '--collect',
        '--slice=app.slice',
        '--unit=app-pitwall-session-1-abc-1',
        '--',
        '/usr/bin/zsh',
        ...shellArgs,
      ],
    })
  })
})

describe('probe e estado', () => {
  it('liga o wrapper quando o probe sai com 0', async () => {
    probeExits(null)
    expect(await ensureScopeProbe()).toBe(true)
    expect(scopeWrapEnabled()).toBe(true)
    expect(scopeState()).toEqual({ kind: 'ok' })
    expect(execFile).toHaveBeenCalledWith(
      'systemd-run',
      ['--user', '--scope', '--quiet', '--collect', '--', 'true'],
      { timeout: 2_000 },
      expect.any(Function),
    )
  })

  it('probes concorrentes viram uma execução só', async () => {
    probeExits(null)
    await Promise.all([ensureScopeProbe(), ensureScopeProbe()])
    expect(execFile).toHaveBeenCalledTimes(1)
  })

  it('sem conexão com o user manager → indisponível até o app fechar', async () => {
    probeExits(
      new Error('Command failed'),
      'Failed to connect to user scope bus via local transport',
    )
    expect(await ensureScopeProbe()).toBe(false)
    expect(scopeState().kind).toBe('unavailable')
    expect(scopeWrapEnabled(Date.now() + 10 * SCOPE_RETRY_BACKOFF_MS)).toBe(false)
    expect(execFile).toHaveBeenCalledTimes(1)
  })

  it('binário ausente → indisponível', async () => {
    probeExits(Object.assign(new Error('spawn systemd-run ENOENT'), { code: 'ENOENT' }))
    await ensureScopeProbe()
    expect(scopeState().kind).toBe('unavailable')
  })

  it('timeout do probe → backoff de 60s e novo probe preguiçoso depois dele', async () => {
    probeExits(Object.assign(new Error('Command failed'), { killed: true }))
    const t0 = Date.now()
    expect(await ensureScopeProbe()).toBe(false)
    const st = scopeState()
    expect(st.kind).toBe('backoff')
    expect(st.kind === 'backoff' && st.retryAt).toBeGreaterThanOrEqual(t0 + SCOPE_RETRY_BACKOFF_MS)

    // Dentro do backoff: spawn direto, sem novo probe.
    expect(scopeWrapEnabled(t0 + 1_000)).toBe(false)
    expect(execFile).toHaveBeenCalledTimes(1)

    // Fim do backoff: este spawn ainda vai direto, mas o probe roda de novo.
    probeExits(null)
    expect(scopeWrapEnabled(t0 + SCOPE_RETRY_BACKOFF_MS + 1)).toBe(false)
    expect(execFile).toHaveBeenCalledTimes(2)
    await ensureScopeProbe()
    expect(scopeWrapEnabled()).toBe(true)
  })

  it('falha de runtime transitória (unit duplicada) só suspende; sem bus, desliga', () => {
    expect(
      isPermanentScopeFailure('Failed to start transient scope unit: Unit x.scope already exists.'),
    ).toBe(false)
    reportScopeFailure('Failed to start transient scope unit: Unit x.scope already exists.')
    expect(scopeState().kind).toBe('backoff')
    reportScopeFailure(
      'Failed to connect to user scope bus via local transport: No such file or directory',
    )
    expect(scopeState().kind).toBe('unavailable')
  })

  it('fora do Linux é sempre spawn direto', async () => {
    setPlatform('darwin')
    expect(await ensureScopeProbe()).toBe(false)
    expect(execFile).not.toHaveBeenCalled()
  })

  it('a pref desliga sem release, lida a cada spawn', async () => {
    probeExits(null)
    await ensureScopeProbe()
    getPref.mockImplementation((k: string, fallback: unknown) =>
      k === SYSTEMD_SCOPE_PREF ? false : fallback,
    )
    expect(scopeWrapEnabled()).toBe(false)
    getPref.mockImplementation((_k: string, fallback: unknown) => fallback)
    expect(scopeWrapEnabled()).toBe(true)
  })

  it('sem wrapper antes do probe terminar', () => {
    expect(scopeWrapEnabled()).toBe(false)
  })
})

describe('sweepOrphanScopes', () => {
  it('para só as units cujo main não existe mais', async () => {
    probeExits(null)
    await ensureScopeProbe()
    const deadPid = 2 ** 22 + 12345 // acima do pid_max padrão: nunca existe
    const listing = [
      `app-pitwall-session-${deadPid}-aaaa1111-1.scope loaded active running zsh`,
      `app-pitwall-session-${process.pid}-bbbb2222-2.scope loaded active running zsh`,
      'app-pitwall-session-legacy.scope loaded active running zsh',
      '',
    ].join('\n')
    execFile.mockImplementation((cmd: string, args: string[], opts: unknown, cb?: ExecCb) => {
      const done = (typeof opts === 'function' ? opts : cb) as ExecCb
      if (cmd === 'systemctl' && args.includes('list-units')) done(null, listing, '')
      else done(null, '', '')
    })
    const stopped = await sweepOrphanScopes()
    expect(stopped).toEqual([`app-pitwall-session-${deadPid}-aaaa1111-1`])
    expect(execFile).toHaveBeenCalledWith(
      'systemctl',
      ['--user', 'stop', '--no-block', `app-pitwall-session-${deadPid}-aaaa1111-1.scope`],
      expect.any(Function),
    )
  })

  it('não varre quando os scopes não estão em uso', async () => {
    expect(await sweepOrphanScopes()).toEqual([])
    expect(execFile).not.toHaveBeenCalled()
  })
})
