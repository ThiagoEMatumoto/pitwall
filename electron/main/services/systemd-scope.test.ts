import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const getPref = vi.fn()
vi.mock('./prefs-store', () => ({
  getPref: (key: string, fallback: unknown) => getPref(key, fallback),
}))

const execFile = vi.fn()
vi.mock('node:child_process', () => {
  const mod = { execFile: (...args: unknown[]) => execFile(...args) }
  return { ...mod, default: mod }
})

import {
  SYSTEMD_SCOPE_PREF,
  ensureScopeProbe,
  resetScopeProbeForTests,
  scopeUnitName,
  scopeWrapEnabled,
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
})

afterEach(() => {
  setPlatform(originalPlatform)
})

function probeExits(err: Error | null): void {
  execFile.mockImplementation(
    (_cmd: string, _args: string[], _opts: unknown, cb: (e: Error | null) => void) => cb(err),
  )
}

describe('scopeUnitName', () => {
  it('usa os 8 primeiros alfanuméricos do id e o timestamp', () => {
    expect(scopeUnitName('3f2a9c1e-7b4d-4e8a', 1700)).toBe('app-pitwall-session-3f2a9c1e-1700')
  })

  it('descarta caracteres inválidos em nome de unit', () => {
    expect(scopeUnitName('a/b c\\d', 1)).toBe('app-pitwall-session-abcd-1')
    expect(scopeUnitName('---', 1)).toBe('app-pitwall-session-session-1')
  })
})

describe('wrapInScope', () => {
  it('envolve o argv do shell de login, não o binário do claude', () => {
    const shellArgs = ['-l', '-i', '-c', 'exec claude --resume x']
    expect(wrapInScope('/usr/bin/zsh', shellArgs, 'app-pitwall-session-abc-1')).toEqual({
      command: 'systemd-run',
      args: [
        '--user',
        '--scope',
        '--quiet',
        '--collect',
        '--slice=app.slice',
        '--unit=app-pitwall-session-abc-1',
        '--',
        '/usr/bin/zsh',
        ...shellArgs,
      ],
    })
  })
})

describe('ensureScopeProbe', () => {
  it('liga o wrapper quando o probe sai com 0', async () => {
    probeExits(null)
    expect(await ensureScopeProbe()).toBe(true)
    expect(scopeWrapEnabled()).toBe(true)
    expect(execFile).toHaveBeenCalledWith(
      'systemd-run',
      ['--user', '--scope', '--quiet', '--collect', '--', 'true'],
      { timeout: 2_000 },
      expect.any(Function),
    )
  })

  it('roda uma vez só e cacheia', async () => {
    probeExits(null)
    await ensureScopeProbe()
    await ensureScopeProbe()
    expect(execFile).toHaveBeenCalledTimes(1)
  })

  it('desliga quando o probe falha (bus fora, timeout)', async () => {
    probeExits(new Error('Failed to connect to bus'))
    expect(await ensureScopeProbe()).toBe(false)
    expect(scopeWrapEnabled()).toBe(false)
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
