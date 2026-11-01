/** @vitest-environment node */
// Pref real (app_prefs das migrations) + o mesmo handoffChildSettings do spawn.
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { migrations } from '../migrations/index'

let testDb: Database.Database
vi.mock('../db', () => ({ getDb: () => testDb }))

import { getChildLearnedAllow, learnChildRule } from './child-learned-rules'
import { setPref } from '../prefs-store'
import { CHILD_LEARNED_ALLOW_PREF, handoffChildSettings } from '../spawn-flags'

beforeEach(() => {
  testDb = new Database(':memory:')
  for (const m of migrations) {
    if (m.disableForeignKeys) testDb.pragma('foreign_keys = OFF')
    m.up(testDb)
    testDb.pragma('foreign_keys = ON')
  }
})

afterEach(() => testDb.close())

describe('learnChildRule', () => {
  it('grava a regra derivada uma vez e ela chega ao settings do spawn', () => {
    expect(learnChildRule('Bash', 'cd /r && jest --ci')).toEqual({
      ok: true,
      rule: 'Bash(jest *)',
      added: true,
    })
    expect(learnChildRule('Bash', 'jest -u')).toEqual({
      ok: true,
      rule: 'Bash(jest *)',
      added: false,
    })
    expect(getChildLearnedAllow()).toEqual(['Bash(jest *)'])
    expect(handoffChildSettings('acceptEdits', getChildLearnedAllow()).permissions.allow).toContain(
      'Bash(jest *)',
    )
  })

  it('recusa comando destrutivo sem tocar a pref', () => {
    const res = learnChildRule('Bash', 'rm -rf dist')
    expect(res.ok).toBe(false)
    expect(getChildLearnedAllow()).toEqual([])
  })

  it('pref adulterada: só as regras válidas são lidas', () => {
    setPref(CHILD_LEARNED_ALLOW_PREF, ['Bash(git *)', 'Bash(jest *)', 7])
    expect(getChildLearnedAllow()).toEqual(['Bash(jest *)'])
    setPref(CHILD_LEARNED_ALLOW_PREF, 'lixo')
    expect(getChildLearnedAllow()).toEqual([])
  })
})
