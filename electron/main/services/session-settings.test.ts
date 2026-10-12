/** @vitest-environment node */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildSessionSettings,
  removeSessionSettings,
  sessionSettingsPath,
  sweepSessionSettings,
  writeSessionSettings,
} from './session-settings'

const ID = '3f2504e0-4f89-11d3-9a0c-0305e82c3301'

function tmpDir(): string {
  return join(mkdtempSync(join(tmpdir(), 'cm-session-settings-')), 'session-settings')
}

describe('buildSessionSettings', () => {
  it('sem base e sem deny não entrega nada (sessão sem --settings)', () => {
    expect(buildSessionSettings(null, null)).toBeNull()
    expect(buildSessionSettings(null, [])).toBeNull()
  })

  it('só deny vira permissions.deny', () => {
    expect(buildSessionSettings(null, ['Bash(rm:*)'])).toEqual({
      permissions: { deny: ['Bash(rm:*)'] },
    })
  })

  it('mescla o deny com o da base sem duplicar e preserva allow/ask', () => {
    const out = buildSessionSettings(
      { crossSessionInbound: 'accept', permissions: { allow: ['Read'], ask: ['X'], deny: ['A'] } },
      ['A', 'B'],
    )
    expect(out).toEqual({
      crossSessionInbound: 'accept',
      permissions: { allow: ['Read'], ask: ['X'], deny: ['A', 'B'] },
    })
  })
})

describe('arquivo de settings por sessão', () => {
  it('grava atômico em <dir>/<id>.json com 0600, sem sobra de .tmp', () => {
    const dir = tmpDir()
    const path = writeSessionSettings(ID, { permissions: { deny: ['Bash(pkill:*)'] } }, dir)
    expect(path).toBe(sessionSettingsPath(ID, dir))
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(statSync(dir).mode & 0o777).toBe(0o700)
    expect(JSON.parse(readFileSync(path, 'utf8')).permissions.deny).toEqual(['Bash(pkill:*)'])
    expect(readdirSync(dir)).toEqual([`${ID}.json`])
  })

  it('aperta para 0700 um diretório que já existia com 0755', () => {
    const dir = tmpDir()
    mkdirSync(dir, { mode: 0o755 })
    expect(statSync(dir).mode & 0o777).toBe(0o755)
    writeSessionSettings(ID, {}, dir)
    expect(statSync(dir).mode & 0o777).toBe(0o700)
  })

  it('remove só a sessão dada e é no-op se já sumiu', () => {
    const dir = tmpDir()
    const path = writeSessionSettings(ID, {}, dir)
    removeSessionSettings(ID, dir)
    expect(existsSync(path)).toBe(false)
    expect(() => removeSessionSettings(ID, dir)).not.toThrow()
  })

  it('sweep do boot leva os órfãos (inclui .tmp interrompido)', () => {
    const dir = tmpDir()
    writeSessionSettings(ID, {}, dir)
    writeFileSync(join(dir, 'x.json.123.tmp'), '{')
    expect(sweepSessionSettings(dir)).toBe(2)
    expect(readdirSync(dir)).toEqual([])
    expect(sweepSessionSettings(join(dir, 'nao-existe'))).toBe(0)
  })
})
