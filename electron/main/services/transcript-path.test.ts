/** @vitest-environment node */
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

// HOME real (temporário): PROJECTS_ROOT é calculado no load do módulo, então o
// mock de node:os precisa existir antes do import de transcript-path.
const { HOME } = vi.hoisted(() => ({
  HOME: `${process.env.TMPDIR ?? '/tmp'}/cm-transcript-path-${process.pid}-${Date.now()}`,
}))

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os')
  return { ...actual, homedir: () => HOME }
})
// readdirSync real, só contado: cada chamada é uma varredura de ~/.claude/projects.
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
  return { ...actual, readdirSync: vi.fn(actual.readdirSync) }
})

import { PROJECTS_ROOT, findTranscriptPath } from './transcript-path'

const scans = (): number => vi.mocked(readdirSync).mock.calls.length

function writeTranscript(dir: string, ccSessionId: string): string {
  mkdirSync(join(PROJECTS_ROOT, dir), { recursive: true })
  const path = join(PROJECTS_ROOT, dir, `${ccSessionId}.jsonl`)
  writeFileSync(path, '{}\n')
  return path
}

describe('findTranscriptPath', () => {
  beforeEach(() => {
    rmSync(HOME, { recursive: true, force: true })
    mkdirSync(join(PROJECTS_ROOT, '-home-user-other'), { recursive: true })
    vi.mocked(readdirSync).mockClear()
  })

  afterAll(() => {
    rmSync(HOME, { recursive: true, force: true })
  })

  it('scans the projects root once for repeated lookups of the same session', () => {
    const path = writeTranscript('-home-user-repo', 'cc-repeated')

    expect(findTranscriptPath('cc-repeated')).toBe(path)
    expect(findTranscriptPath('cc-repeated')).toBe(path)

    expect(scans()).toBe(1)
  })

  it('drops a remembered path whose file is gone and scans again', () => {
    const path = writeTranscript('-home-user-repo', 'cc-removed')
    expect(findTranscriptPath('cc-removed')).toBe(path)

    rmSync(path)

    expect(findTranscriptPath('cc-removed')).toBeNull()
    expect(scans()).toBe(2)
  })

  it('finds a transcript that moved to another project dir', () => {
    const first = writeTranscript('-home-user-repo', 'cc-moved')
    expect(findTranscriptPath('cc-moved')).toBe(first)

    rmSync(first)
    const second = writeTranscript('-home-user-worktree', 'cc-moved')

    expect(findTranscriptPath('cc-moved')).toBe(second)
  })

  it('finds a transcript created after a miss on the very next lookup', () => {
    expect(findTranscriptPath('cc-newborn')).toBeNull()

    const path = writeTranscript('-home-user-repo', 'cc-newborn')

    expect(findTranscriptPath('cc-newborn')).toBe(path)
    expect(scans()).toBe(2)
  })

  it('keeps scanning on every lookup of a session with no transcript', () => {
    expect(findTranscriptPath('cc-absent')).toBeNull()
    expect(findTranscriptPath('cc-absent')).toBeNull()

    expect(scans()).toBe(2)
  })
})
