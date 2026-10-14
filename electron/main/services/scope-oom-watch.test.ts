/** @vitest-environment node */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const files = new Map<string, string>()
const writeErrors = new Map<string, string>()
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const mod = {
    ...actual,
    readFileSync: (p: string) => {
      const v = files.get(p)
      if (v === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      return v
    },
    writeFileSync: (p: string, data: string) => {
      const code = writeErrors.get(p)
      if (code) throw Object.assign(new Error(code), { code })
      files.set(p, data)
    },
  }
  return { ...mod, default: mod }
})

import { raiseOomScoreAdj } from './scope-oom-watch'

beforeEach(() => {
  files.clear()
  writeErrors.clear()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'debug').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('raiseOomScoreAdj', () => {
  it('sobe o valor do filho', () => {
    files.set('/proc/10/oom_score_adj', '100\n')
    expect(raiseOomScoreAdj(10, 600)).toBe(true)
    expect(files.get('/proc/10/oom_score_adj')).toBe('600')
  })

  // Processo saindo (sem mm) ou não-dumpable (setuid, prctl): o kernel passa os
  // arquivos de /proc/<pid> para root e a escrita dá EACCES. Reproduzido em
  // 14/10 com um zumbi e com PR_SET_DUMPABLE=0; não é falha nossa.
  it('EACCES: não aplicável, debug em vez de warn e o pid não é tentado de novo', () => {
    files.set('/proc/11/oom_score_adj', '100\n')
    writeErrors.set('/proc/11/oom_score_adj', 'EACCES')
    expect(raiseOomScoreAdj(11, 600)).toBe(true)
    expect(console.warn).not.toHaveBeenCalled()
    expect(console.debug).toHaveBeenCalledTimes(1)
  })

  it('pid que já saiu: false, sem log', () => {
    expect(raiseOomScoreAdj(12, 600)).toBe(false)
    expect(console.warn).not.toHaveBeenCalled()
  })

  it('erro inesperado continua no warn', () => {
    files.set('/proc/13/oom_score_adj', '100\n')
    writeErrors.set('/proc/13/oom_score_adj', 'EIO')
    expect(raiseOomScoreAdj(13, 600)).toBe(false)
    expect(console.warn).toHaveBeenCalledTimes(1)
  })
})
