import { describe, expect, it, vi } from 'vitest'

// env-import importa custom-env/secret-store, cuja cadeia carrega 'electron' —
// mock mínimo pro vitest (node) coletar o módulo, padrão de voice-config.test.
vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptString: (plain: string) => Buffer.from(`v:${plain}`, 'utf8'),
    decryptString: (buf: Buffer) => buf.toString('utf8').slice(2),
  },
}))

import {
  applyImport,
  MAX_ENV_FILE_BYTES,
  scanEnvSources,
  secretFingerprint,
  type EnvImportDeps,
} from './env-import'

const HOME = '/home/u'
const ROOT = `${HOME}/projetos`

// "Disco" fake: dirs (path → entradas), files (path → conteúdo), symlinks e
// tamanhos forçados (pra testar o cap sem alocar 1MB de string).
interface FakeFs {
  dirs?: Record<string, string[]>
  files?: Record<string, string>
  symlinks?: string[]
  sizes?: Record<string, number>
}

function deps(fs: FakeFs, over: Partial<EnvImportDeps> = {}): Partial<EnvImportDeps> {
  const dirs = fs.dirs ?? {}
  const files = fs.files ?? {}
  const symlinks = new Set(fs.symlinks ?? [])
  const sizes = fs.sizes ?? {}
  const stat = (dir: boolean, file: boolean, link: boolean, size = 0) => ({
    isDirectory: () => dir,
    isFile: () => file,
    isSymbolicLink: () => link,
    size,
  })
  return {
    home: HOME,
    listDir: (p) => {
      if (!(p in dirs)) throw new Error(`ENOENT: ${p}`)
      return dirs[p]
    },
    lstat: (p) => {
      if (symlinks.has(p)) return stat(false, false, true)
      if (p in dirs) return stat(true, false, false)
      if (p in files) return stat(false, true, false, sizes[p] ?? files[p].length)
      return null
    },
    readFile: (p) => {
      if (!(p in files)) throw new Error(`ENOENT: ${p}`)
      return files[p]
    },
    readCustomEnv: () => ({}),
    setEnvVar: vi.fn(() => ({ plaintext: [] })),
    ...over,
  }
}

describe('secretFingerprint', () => {
  it('máscara + últimos 4 + tamanho, nunca o valor inteiro', () => {
    const fp = secretFingerprint('sk-abcdef123456')
    expect(fp).toBe('••••••••3456 (15)')
    expect(fp).not.toContain('sk-abcdef123456')
  })

  it('valor curto (<12): só máscara + tamanho, nenhum char em claro', () => {
    const fp = secretFingerprint('hunter2')
    expect(fp).toBe('•••••••• (7)')
    for (const ch of 'hunter2') expect(fp).not.toContain(ch)
  })
})

describe('scanEnvSources', () => {
  it('acha .env em ~/projetos e devolve candidato new com fingerprint', async () => {
    const out = await scanEnvSources(
      deps({
        dirs: { [ROOT]: ['app'], [`${ROOT}/app`]: ['.env'] },
        files: {
          [`${ROOT}/app/.env`]: 'TAVILY_API_KEY=tvly-secret-12345678\n',
        },
      }),
    )
    expect(out).toEqual([
      {
        key: 'TAVILY_API_KEY',
        canonical: 'TAVILY_API_KEY',
        serviceId: 'tavily',
        sources: [{ path: `${ROOT}/app/.env`, fingerprint: '••••••••5678 (20)' }],
        status: 'new',
      },
    ])
    expect(JSON.stringify(out)).not.toContain('tvly-secret-12345678')
  })

  it('nunca segue symlink (dir nem arquivo)', async () => {
    const out = await scanEnvSources(
      deps({
        dirs: {
          [ROOT]: ['link-dir', 'app'],
          [`${ROOT}/link-dir`]: ['.env'],
          [`${ROOT}/app`]: ['.env.link'],
        },
        files: {
          [`${ROOT}/link-dir/.env`]: 'A=1\n',
          [`${ROOT}/app/.env.link`]: 'B=2\n',
        },
        symlinks: [`${ROOT}/link-dir`, `${ROOT}/app/.env.link`],
      }),
    )
    expect(out).toEqual([])
  })

  it('pula node_modules/.git/.worktrees/.claude/.venv/dist e .env.example/.template', async () => {
    const skipped = ['node_modules', '.git', '.worktrees', '.claude', '.venv', 'dist']
    const out = await scanEnvSources(
      deps({
        dirs: {
          [ROOT]: [...skipped, 'app'],
          ...Object.fromEntries(skipped.map((s) => [`${ROOT}/${s}`, ['.env']])),
          [`${ROOT}/app`]: ['.env.example', '.env.template', '.env.staging', 'notes.txt'],
        },
        files: {
          ...Object.fromEntries(skipped.map((s) => [`${ROOT}/${s}/.env`, 'SKIPPED=1\n'])),
          [`${ROOT}/app/.env.example`]: 'EXAMPLE=1\n',
          [`${ROOT}/app/.env.template`]: 'TEMPLATE=1\n',
          [`${ROOT}/app/.env.staging`]: 'STAGING_KEY=abcd1234efgh\n',
          [`${ROOT}/app/notes.txt`]: 'NOT_ENV=1\n',
        },
      }),
    )
    expect(out.map((c) => c.key)).toEqual(['STAGING_KEY'])
  })

  it('pula arquivo acima do cap de tamanho', async () => {
    const out = await scanEnvSources(
      deps({
        dirs: { [ROOT]: ['app'], [`${ROOT}/app`]: ['.env', '.env.big'] },
        files: {
          [`${ROOT}/app/.env`]: 'SMALL_KEY=abcd1234efgh\n',
          [`${ROOT}/app/.env.big`]: 'BIG_KEY=xyz\n',
        },
        sizes: { [`${ROOT}/app/.env.big`]: MAX_ENV_FILE_BYTES + 1 },
      }),
    )
    expect(out.map((c) => c.key)).toEqual(['SMALL_KEY'])
  })

  it('respeita profundidade máxima 5', async () => {
    const d5 = `${ROOT}/a/b/c/d/e`
    const d6 = `${d5}/f`
    const out = await scanEnvSources(
      deps({
        dirs: {
          [ROOT]: ['a'],
          [`${ROOT}/a`]: ['b'],
          [`${ROOT}/a/b`]: ['c'],
          [`${ROOT}/a/b/c`]: ['d'],
          [`${ROOT}/a/b/c/d`]: ['e'],
          [d5]: ['.env', 'f'],
          [d6]: ['.env'],
        },
        files: {
          [`${d5}/.env`]: 'DEPTH5=ok-value-123\n',
          [`${d6}/.env`]: 'DEPTH6=lost\n',
        },
      }),
    )
    expect(out.map((c) => c.key)).toEqual(['DEPTH5'])
  })

  it('dedupe: mesma chave em dois arquivos vira um candidato com duas fontes', async () => {
    const out = await scanEnvSources(
      deps({
        dirs: {
          [ROOT]: ['a', 'b'],
          [`${ROOT}/a`]: ['.env'],
          [`${ROOT}/b`]: ['.env'],
        },
        files: {
          [`${ROOT}/a/.env`]: 'GEMINI_API_KEY=same-value-123\n',
          [`${ROOT}/b/.env`]: 'GEMINI_API_KEY=same-value-123\n',
        },
      }),
    )
    expect(out).toHaveLength(1)
    expect(out[0].sources.map((s) => s.path)).toEqual([`${ROOT}/a/.env`, `${ROOT}/b/.env`])
    expect(out[0].status).toBe('new')
  })

  it('fontes divergentes sem cofre = conflict', async () => {
    const out = await scanEnvSources(
      deps({
        dirs: {
          [ROOT]: ['a', 'b'],
          [`${ROOT}/a`]: ['.env'],
          [`${ROOT}/b`]: ['.env'],
        },
        files: {
          [`${ROOT}/a/.env`]: 'K=valor-um-1234\n',
          [`${ROOT}/b/.env`]: 'K=valor-dois-5678\n',
        },
      }),
    )
    expect(out[0].status).toBe('conflict')
  })

  it('contra o cofre: valor igual = same, diferente = conflict', async () => {
    const fs: FakeFs = {
      dirs: { [ROOT]: ['a'], [`${ROOT}/a`]: ['.env'] },
      files: { [`${ROOT}/a/.env`]: 'K=vault-value-99\nJ=other-value-11\n' },
    }
    const out = await scanEnvSources(
      deps(fs, {
        readCustomEnv: () => ({ K: 'vault-value-99', J: 'vault-value-99' }),
      }),
    )
    expect(out.find((c) => c.key === 'K')?.status).toBe('same')
    expect(out.find((c) => c.key === 'J')?.status).toBe('conflict')
  })

  it('match por alias do registry: VOZ_TTS_KEY → elevenlabs/ELEVENLABS_API_KEY', async () => {
    const voz = `${HOME}/.config/voz/voz.env`
    const out = await scanEnvSources(
      deps({
        dirs: { [ROOT]: [] },
        files: { [voz]: 'VOZ_TTS_KEY=eleven-key-4321\n' },
      }),
    )
    expect(out).toEqual([
      {
        key: 'VOZ_TTS_KEY',
        canonical: 'ELEVENLABS_API_KEY',
        serviceId: 'elevenlabs',
        sources: [{ path: voz, fingerprint: expect.stringContaining('4321') }],
        status: 'new',
      },
    ])
  })

  it('alias com a canônica já no cofre = shadowed (não new cego)', async () => {
    const voz = `${HOME}/.config/voz/voz.env`
    const out = await scanEnvSources(
      deps(
        {
          dirs: { [ROOT]: [] },
          files: { [voz]: 'VOZ_TTS_KEY=eleven-key-4321\n' },
        },
        { readCustomEnv: () => ({ ELEVENLABS_API_KEY: 'other-value-999' }) },
      ),
    )
    expect(out[0].status).toBe('shadowed')
  })

  it('chave fora do registry sai sem serviceId/canonical', async () => {
    const out = await scanEnvSources(
      deps({
        dirs: { [ROOT]: ['a'], [`${ROOT}/a`]: ['.env'] },
        files: { [`${ROOT}/a/.env`]: 'MY_RANDOM_VAR=whatever-123\n' },
      }),
    )
    expect(out[0].serviceId).toBeUndefined()
    expect(out[0].canonical).toBeUndefined()
  })
})

describe('CM_ENV_IMPORT_ROOT', () => {
  it('redireciona a raiz do scan quando setada (gate de e2e; sem ela vale o home)', async () => {
    vi.stubEnv('CM_ENV_IMPORT_ROOT', '/fixture')
    try {
      const { home: _home, ...rest } = deps({
        dirs: { '/fixture/projetos': ['a'], '/fixture/projetos/a': ['.env'] },
        files: {
          '/fixture/projetos/a/.env': 'TAVILY_API_KEY=test-key-1234\n',
        },
      })
      const out = await scanEnvSources(rest)
      expect(out.map((c) => c.key)).toEqual(['TAVILY_API_KEY'])
    } finally {
      vi.unstubAllEnvs()
    }
  })
})

describe('applyImport', () => {
  it('relê o arquivo na hora e grava via setEnvVar; valor não aparece no retorno', () => {
    const setEnvVar = vi.fn(() => ({ plaintext: [] }))
    const result = applyImport(
      [{ key: 'K', sourcePath: `${ROOT}/a/.env` }],
      deps(
        {
          dirs: { [ROOT]: ['a'], [`${ROOT}/a`]: ['.env'] },
          files: { [`${ROOT}/a/.env`]: 'K=secret-value-777\n' },
        },
        { setEnvVar },
      ),
    )
    expect(setEnvVar).toHaveBeenCalledWith('K', 'secret-value-777')
    expect(result).toEqual({
      applied: ['K'],
      missing: [],
      rejected: [],
      plaintext: [],
    })
    expect(JSON.stringify(result)).not.toContain('secret-value-777')
  })

  it('chave ausente do arquivo vira missing; arquivo inexistente vira rejected', () => {
    const setEnvVar = vi.fn(() => ({ plaintext: [] }))
    const result = applyImport(
      [
        { key: 'GONE', sourcePath: `${ROOT}/a/.env` },
        { key: 'NOFILE', sourcePath: `${ROOT}/sumiu/.env` },
      ],
      deps(
        {
          dirs: { [ROOT]: ['a'], [`${ROOT}/a`]: ['.env'] },
          files: { [`${ROOT}/a/.env`]: 'K=abc\n' },
        },
        { setEnvVar },
      ),
    )
    expect(setEnvVar).not.toHaveBeenCalled()
    expect(result.missing).toEqual(['GONE'])
    expect(result.rejected).toEqual(['NOFILE'])
  })

  it('propaga aviso de plaintext do cofre', () => {
    const result = applyImport(
      [{ key: 'K', sourcePath: `${ROOT}/a/.env` }],
      deps(
        {
          dirs: { [ROOT]: ['a'], [`${ROOT}/a`]: ['.env'] },
          files: { [`${ROOT}/a/.env`]: 'K=abc-plain-123\n' },
        },
        { setEnvVar: () => ({ plaintext: ['K'] }) },
      ),
    )
    expect(result.plaintext).toEqual(['K'])
  })

  // As defesas do apply são as MESMAS do scan: sem elas, (key, sourcePath)
  // vindo do renderer seria uma read-primitive de qualquer CHAVE=valor.
  it('rejeita path fora das raízes permitidas (ex.: ~/.aws/credentials)', () => {
    const setEnvVar = vi.fn(() => ({ plaintext: [] }))
    const aws = `${HOME}/.aws/credentials`
    const result = applyImport(
      [
        { key: 'aws_secret_access_key', sourcePath: aws },
        { key: 'X', sourcePath: `${ROOT}/../.aws/credentials` },
        { key: 'Y', sourcePath: `${ROOT}/app/notes.txt` },
        { key: 'Z', sourcePath: `${ROOT}/app/.env.example` },
      ],
      deps(
        {
          dirs: { [ROOT]: ['app'], [`${ROOT}/app`]: [] },
          files: {
            [aws]: 'aws_secret_access_key=AKIA-secret\n',
            [`${ROOT}/app/notes.txt`]: 'Y=1\n',
            [`${ROOT}/app/.env.example`]: 'Z=1\n',
          },
        },
        { setEnvVar },
      ),
    )
    expect(setEnvVar).not.toHaveBeenCalled()
    expect(result.applied).toEqual([])
    expect(result.rejected).toEqual(['aws_secret_access_key', 'X', 'Y', 'Z'])
  })

  it('rejeita symlink no arquivo e no diretório intermediário', () => {
    const setEnvVar = vi.fn(() => ({ plaintext: [] }))
    const result = applyImport(
      [
        { key: 'A', sourcePath: `${ROOT}/link/.env` },
        { key: 'B', sourcePath: `${ROOT}/app/.env` },
      ],
      deps(
        {
          dirs: {
            [ROOT]: ['link', 'app'],
            [`${ROOT}/link`]: ['.env'],
            [`${ROOT}/app`]: ['.env'],
          },
          files: {
            [`${ROOT}/link/.env`]: 'A=1\n',
            [`${ROOT}/app/.env`]: 'B=1\n',
          },
          symlinks: [`${ROOT}/link`, `${ROOT}/app/.env`],
        },
        { setEnvVar },
      ),
    )
    expect(setEnvVar).not.toHaveBeenCalled()
    expect(result.rejected).toEqual(['A', 'B'])
  })

  it('aceita o voz.env fixo, mas não outro arquivo em ~/.config', () => {
    const setEnvVar = vi.fn(() => ({ plaintext: [] }))
    const voz = `${HOME}/.config/voz/voz.env`
    const other = `${HOME}/.config/gh/hosts.yml`
    const result = applyImport(
      [
        { key: 'VOZ_TTS_KEY', sourcePath: voz },
        { key: 'oauth_token', sourcePath: other },
      ],
      deps(
        {
          files: {
            [voz]: 'VOZ_TTS_KEY=eleven-key-4321\n',
            [other]: 'oauth_token=gho_secret\n',
          },
        },
        { setEnvVar },
      ),
    )
    expect(setEnvVar).toHaveBeenCalledWith('VOZ_TTS_KEY', 'eleven-key-4321')
    expect(result.applied).toEqual(['VOZ_TTS_KEY'])
    expect(result.rejected).toEqual(['oauth_token'])
  })
})
