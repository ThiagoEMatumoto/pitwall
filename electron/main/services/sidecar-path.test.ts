import { describe, it, expect } from 'vitest'
import {
  resolveSidecarDir,
  resolveSidecarScript,
  resolveScriptsDir,
  resolveSetupScript,
} from './sidecar-path'

describe('resolveSidecarDir', () => {
  it('packaged: resolve a partir de resourcesPath (fora do asar)', () => {
    const dir = resolveSidecarDir({
      isPackaged: true,
      resourcesPath: '/opt/Pitwall/resources',
      moduleDir: '/opt/Pitwall/resources/app.asar/out/main',
    })
    expect(dir).toBe('/opt/Pitwall/resources/sidecar')
  })

  it('build/e2e: <repoRoot>/out/main → <repoRoot>/sidecar', () => {
    const dir = resolveSidecarDir({
      isPackaged: false,
      resourcesPath: '/ignored/in/dev',
      moduleDir: '/home/user/repo/out/main',
    })
    expect(dir).toBe('/home/user/repo/sidecar')
  })

  it('dev (electron-vite serve de out/main): mesma derivação', () => {
    const dir = resolveSidecarDir({
      isPackaged: false,
      resourcesPath: '/ignored',
      moduleDir: '/home/user/repo/out/main',
    })
    expect(dir).toBe('/home/user/repo/sidecar')
  })
})

describe('resolveSidecarScript', () => {
  it('anexa o nome do script ao diretório resolvido', () => {
    const script = resolveSidecarScript(
      {
        isPackaged: false,
        resourcesPath: '/ignored',
        moduleDir: '/home/user/repo/out/main',
      },
      'fake_sidecar.py',
    )
    expect(script).toBe('/home/user/repo/sidecar/fake_sidecar.py')
  })
})

describe('resolveSetupScript', () => {
  it('dev/build: <repoRoot>/out/main → <repoRoot>/scripts/setup-meeting-sidecar.sh', () => {
    const script = resolveSetupScript({
      isPackaged: false,
      resourcesPath: '/ignored',
      moduleDir: '/home/user/repo/out/main',
    })
    expect(script).toBe('/home/user/repo/scripts/setup-meeting-sidecar.sh')
  })

  it('packaged: resourcesPath/scripts/setup-meeting-sidecar.sh', () => {
    const script = resolveSetupScript({
      isPackaged: true,
      resourcesPath: '/opt/Pitwall/resources',
      moduleDir: '/opt/Pitwall/resources/app.asar/out/main',
    })
    expect(script).toBe('/opt/Pitwall/resources/scripts/setup-meeting-sidecar.sh')
  })

  it('resolveScriptsDir packaged vs dev', () => {
    expect(
      resolveScriptsDir({ isPackaged: true, resourcesPath: '/r', moduleDir: '/x/out/main' }),
    ).toBe('/r/scripts')
    expect(
      resolveScriptsDir({ isPackaged: false, resourcesPath: '/r', moduleDir: '/x/out/main' }),
    ).toBe('/x/scripts')
  })
})
