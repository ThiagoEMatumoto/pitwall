import { describe, expect, it, vi } from 'vitest'
import { normalizePath, selectUntracked, type DirEntryLike } from './untracked-folders'

// getDb mockado: devolve o valor configurado pra app_prefs.vault_root.
let vaultRootPref: string | undefined
vi.mock('../services/db', () => ({
  getDb: () => ({
    prepare: () => ({
      get: () => (vaultRootPref === undefined ? undefined : { value: vaultRootPref }),
    }),
  }),
}))

import { resolveRepoPath } from '../services/repo-path'

function dir(name: string): DirEntryLike {
  return { name, isDirectory: () => true }
}
function file(name: string): DirEntryLike {
  return { name, isDirectory: () => false }
}

describe('normalizePath', () => {
  it('remove barra final', () => {
    expect(normalizePath('/a/b/')).toBe('/a/b')
  })
  it('resolve . e ..', () => {
    expect(normalizePath('/a/b/../c')).toBe('/a/c')
  })
})

describe('selectUntracked', () => {
  const vault = '/vault'

  it('retorna só diretórios não-registrados', () => {
    const entries = [dir('arara'), dir('claude-manager'), file('README.md')]
    const registered = ['/vault/claude-manager']
    expect(selectUntracked(vault, entries, registered)).toEqual([
      { name: 'arara', path: '/vault/arara' },
    ])
  })

  it('exclui dotfiles e arquivos', () => {
    const entries = [dir('.git'), file('notes.txt'), dir('app')]
    expect(selectUntracked(vault, entries, [])).toEqual([{ name: 'app', path: '/vault/app' }])
  })

  it('ignora barra final divergente nos paths registrados', () => {
    const entries = [dir('arara')]
    expect(selectUntracked(vault, entries, ['/vault/arara/'])).toEqual([])
  })

  it('ordena por nome', () => {
    const entries = [dir('zeta'), dir('alpha')]
    expect(selectUntracked(vault, entries, []).map((f) => f.name)).toEqual(['alpha', 'zeta'])
  })

  it('vault vazio retorna lista vazia', () => {
    expect(selectUntracked(vault, [], [])).toEqual([])
  })
})

// Reproduz a composição do handler vault:list-untracked: tanto o vault do projeto
// quanto os repos registrados passam por resolveRepoPath antes da comparação.
function listUntracked(vaultPath: string, entries: DirEntryLike[], registered: string[]) {
  return selectUntracked(resolveRepoPath(vaultPath), entries, registered.map(resolveRepoPath))
}

describe('vault:list-untracked (resolução de paths do DB)', () => {
  const root = '/home/u/projetos'

  it('registered RELATIVO casa com entries do vault relativo já resolvido', () => {
    vaultRootPref = root
    const entries = [dir('api'), dir('web')]
    expect(listUntracked('diligencia', entries, ['diligencia/api'])).toEqual([
      { name: 'web', path: '/home/u/projetos/diligencia/web' },
    ])
  })

  it('mistura registered relativo + absoluto casa nos dois formatos', () => {
    vaultRootPref = root
    const entries = [dir('api'), dir('web'), dir('infra')]
    const registered = ['diligencia/api', '/home/u/projetos/diligencia/web']
    expect(listUntracked('diligencia', entries, registered)).toEqual([
      { name: 'infra', path: '/home/u/projetos/diligencia/infra' },
    ])
  })

  it('vault absoluto + registered relativo (caso do banco meio-migrado)', () => {
    vaultRootPref = root
    const entries = [dir('api'), dir('web')]
    expect(listUntracked('/home/u/projetos/diligencia', entries, ['diligencia/api'])).toEqual([
      { name: 'web', path: '/home/u/projetos/diligencia/web' },
    ])
  })

  it('sem resolver, o mesmo cenário não casaria (regressão que gerou o bug)', () => {
    vaultRootPref = root
    const entries = [dir('api')]
    expect(selectUntracked('/home/u/projetos/diligencia', entries, ['diligencia/api'])).toEqual([
      { name: 'api', path: '/home/u/projetos/diligencia/api' },
    ])
  })
})
