import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))

import { CACHE_TTL_MS, MAX_FILES, createRepoFilesLister } from './repo-files'

const dirs: string[] = []
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'repo-files-'))
  dirs.push(d)
  return d
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('fs:list-repo-files', () => {
  it('num repo git lista rastreados + não rastreados, sem os ignorados', async () => {
    const cwd = tempDir()
    execFileSync('git', ['init', '-q'], { cwd })
    mkdirSync(join(cwd, 'src'))
    writeFileSync(join(cwd, 'src', 'x.ts'), '')
    writeFileSync(join(cwd, '.gitignore'), 'dist/\n')
    mkdirSync(join(cwd, 'dist'))
    writeFileSync(join(cwd, 'dist', 'bundle.js'), '')
    execFileSync('git', ['add', '.gitignore'], { cwd })
    const list = createRepoFilesLister()
    const res = await list(cwd)
    expect(res.source).toBe('git')
    expect(res.files.sort()).toEqual(['.gitignore', 'src/x.ts'])
    expect(res.truncated).toBe(false)
  })

  it('fora de repo cai no readdir raso', async () => {
    const cwd = tempDir()
    writeFileSync(join(cwd, 'a.txt'), '')
    mkdirSync(join(cwd, 'pasta'))
    const res = await createRepoFilesLister()(cwd)
    expect(res.source).toBe('readdir')
    expect(res.files.sort()).toEqual(['a.txt', 'pasta/'])
  })

  it(`corta em ${MAX_FILES} arquivos e avisa`, async () => {
    const many = Array.from({ length: MAX_FILES + 5 }, (_, i) => `f${i}.ts`)
    const list = createRepoFilesLister({ gitFiles: async () => many })
    const res = await list('/qualquer')
    expect(res.files).toHaveLength(MAX_FILES)
    expect(res.truncated).toBe(true)
  })

  it('cacheia por cwd e invalida depois de 30s', async () => {
    let now = 1_000
    const gitFiles = vi.fn(async () => ['a.ts'])
    const list = createRepoFilesLister({ gitFiles, now: () => now })
    await list('/r1')
    await list('/r1')
    expect(gitFiles).toHaveBeenCalledTimes(1)
    await list('/r2')
    expect(gitFiles).toHaveBeenCalledTimes(2)
    now += CACHE_TTL_MS + 1
    await list('/r1')
    expect(gitFiles).toHaveBeenCalledTimes(3)
    expect(CACHE_TTL_MS).toBe(30_000)
  })

  it('cwd que não existe devolve vazio', async () => {
    const res = await createRepoFilesLister()(join(tmpdir(), 'nao-existe-' + Date.now()))
    expect(res).toEqual({ files: [], truncated: false, source: 'none' })
  })
})
