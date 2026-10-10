import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

const handlers = new Map<string, (e: unknown, payload: unknown) => unknown>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (e: unknown, payload: unknown) => unknown) => {
      handlers.set(channel, fn)
    },
  },
}))

// Sem repos/vaults: só as raízes estáticas valem.
vi.mock('../services/db', () => ({
  getDb: () => {
    throw new Error('db indisponível')
  },
}))

import { registerFsIpc } from './fs'

const UID_DIR = `claude-${process.getuid?.() ?? 0}`
// Fora de /tmp, tmpdir(), ~/.claude e do repo: simula o scratch em ~/.cache/ct.
let base: string
let scratchFile: string
let outsideUidDir: string
const originalTmpdir = process.env.CLAUDE_CODE_TMPDIR

beforeAll(() => {
  const cache = path.join(homedir(), '.cache')
  mkdirSync(cache, { recursive: true })
  base = mkdtempSync(path.join(cache, 'pitwall-fs-test-'))
  const dir = path.join(base, UID_DIR, 'proj', 'session', 'scratchpad')
  mkdirSync(dir, { recursive: true })
  scratchFile = path.join(dir, 'notes.md')
  writeFileSync(scratchFile, 'oi', 'utf8')
  outsideUidDir = path.join(base, 'outside.txt')
  writeFileSync(outsideUidDir, 'x', 'utf8')
  registerFsIpc()
})

afterAll(() => {
  rmSync(base, { recursive: true, force: true })
})

afterEach(() => {
  if (originalTmpdir === undefined) delete process.env.CLAUDE_CODE_TMPDIR
  else process.env.CLAUDE_CODE_TMPDIR = originalTmpdir
})

function readFile(p: string): unknown {
  return handlers.get('fs:read-file')!(null, { path: p })
}

describe('fs IPC × CLAUDE_CODE_TMPDIR', () => {
  it('recusa o scratch fora de /tmp quando CLAUDE_CODE_TMPDIR não está definido', () => {
    delete process.env.CLAUDE_CODE_TMPDIR
    expect(() => readFile(scratchFile)).toThrow('Path fora do permitido')
  })

  it('abre arquivo do scratch sob <CLAUDE_CODE_TMPDIR>/claude-<uid>', () => {
    process.env.CLAUDE_CODE_TMPDIR = base
    expect(readFile(scratchFile)).toEqual({ path: scratchFile, content: 'oi' })
  })

  it('recusa CLAUDE_CODE_TMPDIR relativo', () => {
    process.env.CLAUDE_CODE_TMPDIR = path.relative(process.cwd(), base)
    expect(() => readFile(scratchFile)).toThrow('Path fora do permitido')
  })

  it('libera só o diretório per-uid, não a base inteira', () => {
    process.env.CLAUDE_CODE_TMPDIR = base
    expect(() => readFile(outsideUidDir)).toThrow('Path fora do permitido')
  })

  it('base sem claude-<uid> não vira raiz (e não vaza ENOENT)', () => {
    const empty = mkdtempSync(path.join(base, 'empty-'))
    process.env.CLAUDE_CODE_TMPDIR = empty
    expect(() => readFile(scratchFile)).toThrow('Path fora do permitido')
  })

  it('recusa raiz que resolve para o home (ou ancestral dele)', () => {
    const evil = mkdtempSync(path.join(base, 'evil-'))
    symlinkSync(homedir(), path.join(evil, UID_DIR))
    process.env.CLAUDE_CODE_TMPDIR = evil
    expect(() => readFile(outsideUidDir)).toThrow('Path fora do permitido')
  })
})
