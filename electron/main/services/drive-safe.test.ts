import { afterEach, describe, expect, it, vi } from 'vitest'
import { _resetDriveSafeForTests, driveSafeBlocks, isDriveSafe } from './drive-safe'

afterEach(() => {
  _resetDriveSafeForTests()
  vi.restoreAllMocks()
})

describe('isDriveSafe', () => {
  it('só liga com CM_DRIVE_SAFE=1 exato', () => {
    expect(isDriveSafe({ CM_DRIVE_SAFE: '1' })).toBe(true)
    expect(isDriveSafe({ CM_DRIVE_SAFE: '0' })).toBe(false)
    expect(isDriveSafe({ CM_DRIVE_SAFE: 'true' })).toBe(false)
    expect(isDriveSafe({})).toBe(false)
  })
})

describe('driveSafeBlocks', () => {
  it('bloqueia e loga uma única vez por job', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const env = { CM_DRIVE_SAFE: '1' }
    expect(driveSafeBlocks('repo auto-pull', env)).toBe(true)
    expect(driveSafeBlocks('repo auto-pull', env)).toBe(true)
    expect(driveSafeBlocks('meeting detector', env)).toBe(true)
    expect(log.mock.calls.map((c) => c[0])).toEqual([
      '[drive-safe] repo auto-pull disabled',
      '[drive-safe] meeting detector disabled',
    ])
  })

  it('fora do modo seguro não bloqueia nem loga', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    expect(driveSafeBlocks('repo auto-pull', { CM_DRIVE_SAFE: '0' })).toBe(false)
    expect(log).not.toHaveBeenCalled()
  })
})
