import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
// @ts-expect-error — script .mjs sem tipos, usado só pelo postinstall
import { checkElectronInstall, isAffectedNode, formatFailure } from './check-electron-install.mjs'

// Monta um fs fake a partir do conjunto de paths que "existem".
function fakeFs(paths: string[], sizes: Record<string, number> = {}) {
  const set = new Set(paths)
  return {
    existsSync: (p: string) => set.has(p),
    readFileSync: () => 'electron',
    statSync: (p: string) => ({ size: sizes[p] ?? 0 }),
  }
}

const root = '/repo'
const dir = join(root, 'node_modules', 'electron')
const dist = join(dir, 'dist')
const binary = join(dist, 'electron')

describe('checkElectronInstall', () => {
  it('instalação completa → sem falha', () => {
    const fs = fakeFs([dir, join(dir, 'path.txt'), binary, join(dist, 'version')], {
      [binary]: 190_000_000,
    })
    expect(checkElectronInstall(root, 'linux', fs)).toBeNull()
  })

  it('sem o pacote electron (install sem devDeps) → sem falha', () => {
    expect(checkElectronInstall(root, 'linux', fakeFs([]))).toBeNull()
  })

  it('binário ausente → falha', () => {
    const fs = fakeFs([dir, join(dir, 'path.txt')])
    expect(checkElectronInstall(root, 'linux', fs)).toContain('não foi extraído')
  })

  it('dist/version ausente (extração truncada) → falha', () => {
    const fs = fakeFs([dir, join(dir, 'path.txt'), binary], { [binary]: 190_000_000 })
    expect(checkElectronInstall(root, 'linux', fs)).toContain('dist/version')
  })

  it('binário truncado no linux → falha', () => {
    const fs = fakeFs([dir, join(dir, 'path.txt'), binary, join(dist, 'version')], {
      [binary]: 2_000_000,
    })
    expect(checkElectronInstall(root, 'linux', fs)).toContain('truncado')
  })

  // No macOS o executável do path.txt é pequeno por natureza — checar tamanho
  // ali reprovaria uma instalação boa e quebraria o build da release.
  it('binário pequeno no darwin → sem falha', () => {
    const fs = fakeFs([dir, join(dir, 'path.txt'), binary, join(dist, 'version')], {
      [binary]: 100_000,
    })
    expect(checkElectronInstall(root, 'darwin', fs)).toBeNull()
  })
})

describe('isAffectedNode', () => {
  it.each(['24.16.0', '24.17.0'])('%s está na janela da regressão', (v) => {
    expect(isAffectedNode(v)).toBe(true)
  })

  it.each(['22.23.2', '24.18.1', '24.20.0', '25.0.0'])('%s está fora', (v) => {
    expect(isAffectedNode(v)).toBe(false)
  })
})

describe('formatFailure', () => {
  it('em Node afetado, aponta o .nvmrc', () => {
    expect(formatFailure('x', '24.16.0')).toContain('.nvmrc')
  })

  it('fora da janela, sugere rodar o install.js', () => {
    expect(formatFailure('x', '24.20.0')).toContain('install.js')
  })
})
