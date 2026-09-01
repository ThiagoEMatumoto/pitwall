import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

// getDb mockado: devolve o valor configurado pra app_prefs.vault_root.
let vaultRootPref: string | undefined
vi.mock('./db', () => ({
  getDb: () => ({
    prepare: () => ({
      get: () => (vaultRootPref === undefined ? undefined : { value: vaultRootPref }),
    }),
  }),
}))

import { getVaultRoot, resolveAgainstRoot, resolveRepoPath } from './repo-path'

describe('resolveAgainstRoot (pura)', () => {
  it('path relativo + root → absoluto', () => {
    expect(resolveAgainstRoot('projetos/p1/core', '/home/u/vault')).toBe(
      '/home/u/vault/projetos/p1/core',
    )
  })

  it('path absoluto → intacto (root ignorado)', () => {
    expect(resolveAgainstRoot('/opt/elsewhere/repo', '/home/u/vault')).toBe('/opt/elsewhere/repo')
  })
})

describe('resolveRepoPath (contra vault_root do DB)', () => {
  it('row legado RELATIVO (bug do importer) resolve contra o vault_root configurado', () => {
    vaultRootPref = '/home/u/projetos'
    expect(resolveRepoPath('diligencia/api')).toBe('/home/u/projetos/diligencia/api')
  })

  it('path absoluto passa intacto sem consultar nada', () => {
    vaultRootPref = '/home/u/projetos'
    expect(resolveRepoPath('/home/u/projetos/diligencia/api')).toBe(
      '/home/u/projetos/diligencia/api',
    )
  })

  it('sem pref explícita cai no default ~/ClaudeManager (mesma semântica de vault:get-root)', () => {
    vaultRootPref = undefined
    const home = process.env.HOME as string
    expect(getVaultRoot()).toBe(join(home, 'ClaudeManager'))
    expect(resolveRepoPath('x/y')).toBe(join(home, 'ClaudeManager', 'x', 'y'))
  })
})
