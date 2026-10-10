import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
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

// Fora de /tmp, tmpdir() e ~/.claude: simula o scratch em ~/.cache/ct.
let scratchRoot: string
let scratchFile: string
const originalTmpdir = process.env.CLAUDE_CODE_TMPDIR

beforeAll(() => {
  scratchRoot = mkdtempSync(path.join(process.cwd(), '.fs-test-ct-'))
  const dir = path.join(scratchRoot, 'claude-1000', 'proj', 'session', 'scratchpad')
  mkdirSync(dir, { recursive: true })
  scratchFile = path.join(dir, 'notes.md')
  writeFileSync(scratchFile, 'oi', 'utf8')
  registerFsIpc()
})

afterAll(() => {
  rmSync(scratchRoot, { recursive: true, force: true })
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

  it('abre arquivo do scratch quando CLAUDE_CODE_TMPDIR aponta para a raiz dele', () => {
    process.env.CLAUDE_CODE_TMPDIR = scratchRoot
    expect(readFile(scratchFile)).toEqual({ path: scratchFile, content: 'oi' })
  })

  it('resolve CLAUDE_CODE_TMPDIR relativo/não normalizado', () => {
    process.env.CLAUDE_CODE_TMPDIR = path.relative(process.cwd(), scratchRoot) + '/./'
    expect(readFile(scratchFile)).toEqual({ path: scratchFile, content: 'oi' })
  })

  it('não libera irmãos da raiz configurada', () => {
    process.env.CLAUDE_CODE_TMPDIR = path.join(scratchRoot, 'claude-1000', 'proj', 'session')
    const sibling = path.join(scratchRoot, 'outside.txt')
    writeFileSync(sibling, 'x', 'utf8')
    expect(() => readFile(sibling)).toThrow('Path fora do permitido')
  })
})
