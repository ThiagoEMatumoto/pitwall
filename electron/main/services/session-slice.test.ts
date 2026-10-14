/** @vitest-environment node */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const getPref = vi.fn()
vi.mock('./prefs-store', () => ({
  getPref: (key: string, fallback: unknown) => getPref(key, fallback),
}))

type ExecCb = (err: Error | null, stdout: string, stderr: string) => void
const execFile = vi.fn()
vi.mock('node:child_process', () => {
  const mod = { execFile: (...args: unknown[]) => execFile(...args) }
  return { ...mod, default: mod }
})

import {
  DEFAULT_SESSION_MEMORY_RESERVE_GB,
  SESSION_MEMORY_RESERVE_PREF,
  SESSION_SLICE,
  SliceOomLog,
  resetSessionSliceForTests,
  sessionSliceCapGB,
  sessionSliceName,
  sliceCapGBFromReserve,
  sliceCgroupDir,
  sliceMemoryFraction,
  syncSessionSlice,
} from './session-slice'

const GIB = 1024 ** 3
const RAM30 = 30.27 * GIB

beforeEach(() => {
  resetSessionSliceForTests()
  getPref.mockReset().mockImplementation((_k: string, fallback: unknown) => fallback)
  execFile.mockReset()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'info').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('teto do slice das sessões', () => {
  it('RAM total menos a reserva do desktop (default 8 GB)', () => {
    expect(DEFAULT_SESSION_MEMORY_RESERVE_GB).toBe(8)
    expect(sliceCapGBFromReserve(8, RAM30)).toBe(22)
    expect(sliceCapGBFromReserve(4, RAM30)).toBe(26)
  })

  it('reserva inválida cai no default; o teto nunca fica abaixo de 2 GB', () => {
    for (const bad of [true, 'abc', null, undefined, Number.NaN, -3, Infinity]) {
      expect(sliceCapGBFromReserve(bad, RAM30)).toBe(22)
    }
    expect(sliceCapGBFromReserve(29, RAM30)).toBe(2)
    expect(sliceCapGBFromReserve(0, RAM30)).toBe(30)
  })

  it('a pref sessions.memoryReserveGB é lida a cada chamada', () => {
    getPref.mockImplementation((k: string, fallback: unknown) =>
      k === SESSION_MEMORY_RESERVE_PREF ? 10 : fallback,
    )
    expect(sessionSliceCapGB(RAM30)).toBe(20)
    getPref.mockImplementation(() => {
      throw new Error('sem DB')
    })
    expect(sessionSliceCapGB(RAM30)).toBe(22)
  })
})

describe('syncSessionSlice', () => {
  function systemctlOk(): void {
    execFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: ExecCb) =>
      setImmediate(() => cb(null, '', '')),
    )
  }

  it('configura o slice por set-property --runtime: MemoryMax, swap 0 e nenhum MemoryHigh', async () => {
    systemctlOk()
    await syncSessionSlice(22)
    expect(execFile).toHaveBeenCalledTimes(1)
    const [cmd, args] = execFile.mock.calls[0] as [string, string[]]
    expect(cmd).toBe('systemctl')
    expect(args).toEqual([
      '--user',
      'set-property',
      '--runtime',
      'pitwall-sessions.slice',
      'MemoryMax=22G',
      'MemorySwapMax=0',
    ])
    expect(args.some((a) => a.startsWith('MemoryHigh'))).toBe(false)
  })

  it('não repete o mesmo valor; muda quando a pref muda', async () => {
    systemctlOk()
    await syncSessionSlice(22)
    await syncSessionSlice(22)
    expect(execFile).toHaveBeenCalledTimes(1)
    await syncSessionSlice(20)
    expect(execFile).toHaveBeenCalledTimes(2)
    expect((execFile.mock.calls[1] as [string, string[]])[1]).toContain('MemoryMax=20G')
  })

  it('falha do systemctl não marca como aplicado: a próxima sessão tenta de novo', async () => {
    execFile.mockImplementationOnce((_c: string, _a: string[], _o: unknown, cb: ExecCb) =>
      setImmediate(() => cb(new Error('Failed to connect'), '', '')),
    )
    expect(await syncSessionSlice(22)).toBe(false)
    expect(console.warn).toHaveBeenCalled()
    systemctlOk()
    expect(await syncSessionSlice(22)).toBe(true)
    expect(execFile).toHaveBeenCalledTimes(2)
  })
})

describe('cgroup do slice', () => {
  const SELF =
    '0::/user.slice/user-1000.slice/user@1000.service/app.slice/app-gnome-pitwall-1.scope\n'

  it('fica sob o user manager, aninhado pelos hífens do nome', () => {
    expect(SESSION_SLICE).toBe('pitwall-sessions.slice')
    expect(sessionSliceName()).toBe(SESSION_SLICE)
    expect(sliceCgroupDir(SELF)).toBe(
      '/sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service/pitwall.slice/pitwall-sessions.slice',
    )
  })

  it('fora de um user manager não há caminho', () => {
    expect(sliceCgroupDir('0::/system.slice/foo.service\n')).toBeNull()
  })

  it('fração de uso = memory.current / memory.max; sem teto ou sem leitura → null', () => {
    const files: Record<string, string> = {
      '/s/memory.current': `${11 * GIB}\n`,
      '/s/memory.max': `${22 * GIB}\n`,
    }
    const read = (p: string) => {
      if (!(p in files)) throw new Error('ENOENT')
      return files[p]!
    }
    expect(sliceMemoryFraction('/s', read)).toBe(0.5)
    files['/s/memory.max'] = 'max\n'
    expect(sliceMemoryFraction('/s', read)).toBeNull()
    expect(sliceMemoryFraction('/nao-existe', read)).toBeNull()
    expect(sliceMemoryFraction(null, read)).toBeNull()
  })
})

describe('SliceOomLog', () => {
  it('a cada oom_kill novo no slice, loga o contador e o teto', () => {
    let kills: number | null = null
    const log = new SliceOomLog(
      () => kills,
      () => 22,
    )
    log.check()
    expect(console.warn).not.toHaveBeenCalled()
    kills = 0
    log.check()
    expect(console.warn).not.toHaveBeenCalled()
    kills = 2
    log.check()
    expect(console.warn).toHaveBeenCalledTimes(1)
    expect(String(vi.mocked(console.warn).mock.calls[0]![0])).toMatch(
      /oom_kill=2 \(\+2\).*MemoryMax=22G/,
    )
    log.check()
    expect(console.warn).toHaveBeenCalledTimes(1)
    kills = 3
    log.check()
    expect(String(vi.mocked(console.warn).mock.calls[1]![0])).toMatch(/oom_kill=3 \(\+1\)/)
    expect(log.count()).toBe(3)
  })
})
