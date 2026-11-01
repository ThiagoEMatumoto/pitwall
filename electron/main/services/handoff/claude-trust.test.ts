import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { preTrustClaudeDirs } from './claude-trust'

let home: string
const file = () => join(home, '.claude.json')
const read = () => JSON.parse(readFileSync(file(), 'utf8'))

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'claude-trust-'))
})
afterEach(() => rmSync(home, { recursive: true, force: true }))

describe('preTrustClaudeDirs', () => {
  it('grava hasTrustDialogAccepted preservando o resto do JSON e do projeto', () => {
    writeFileSync(
      file(),
      JSON.stringify({
        numStartups: 7,
        mcpServers: { x: { command: 'y' } },
        projects: {
          '/r': { allowedTools: ['Bash'], hasTrustDialogAccepted: false },
          '/o': { a: 1 },
        },
      }),
      { mode: 0o600 },
    )
    expect(preTrustClaudeDirs(['/r', '/r/.worktrees/child-a'], home)).toBe(true)
    expect(read()).toEqual({
      numStartups: 7,
      mcpServers: { x: { command: 'y' } },
      projects: {
        '/r': { allowedTools: ['Bash'], hasTrustDialogAccepted: true },
        '/r/.worktrees/child-a': { hasTrustDialogAccepted: true },
        '/o': { a: 1 },
      },
    })
    expect(statSync(file()).mode & 0o777).toBe(0o600)
    expect(readdirSync(home)).toEqual(['.claude.json'])
  })

  it('cria projects quando ausente', () => {
    writeFileSync(file(), '{"numStartups":1}')
    expect(preTrustClaudeDirs(['/r'], home)).toBe(true)
    expect(read()).toEqual({ numStartups: 1, projects: { '/r': { hasTrustDialogAccepted: true } } })
  })

  it('já confiável: não reescreve o arquivo', () => {
    const raw = '{"projects":{"/r":{"hasTrustDialogAccepted":true}},"z":1}'
    writeFileSync(file(), raw)
    expect(preTrustClaudeDirs(['/r'], home)).toBe(true)
    expect(readFileSync(file(), 'utf8')).toBe(raw)
  })

  it('JSON inválido ou projects malformado: não escreve e devolve false', () => {
    writeFileSync(file(), '{"projects": {')
    expect(preTrustClaudeDirs(['/r'], home)).toBe(false)
    expect(readFileSync(file(), 'utf8')).toBe('{"projects": {')
    writeFileSync(file(), '{"projects": []}')
    expect(preTrustClaudeDirs(['/r'], home)).toBe(false)
    expect(readFileSync(file(), 'utf8')).toBe('{"projects": []}')
  })

  it('arquivo ausente: devolve false sem criar', () => {
    expect(preTrustClaudeDirs(['/r'], home)).toBe(false)
    expect(readdirSync(home)).toEqual([])
  })
})
