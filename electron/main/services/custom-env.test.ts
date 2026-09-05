import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// safeStorage falso mas REVERSÍVEL: exercita o caminho real de cifragem
// (electronCrypto) sem depender do cofre do SO. Todos os valores dos testes são
// fictícios.
vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptString: (plain: string) => Buffer.from(`v:${plain}`, 'utf8'),
    decryptString: (buf: Buffer) => {
      const raw = buf.toString('utf8')
      if (!raw.startsWith('v:')) throw new Error('não é deste cofre')
      return raw.slice(2)
    },
  },
}))

import {
  sanitizeCustomEnv,
  mergeCustomEnv,
  getEnvVar,
  withAutoCompactDisabled,
  sessionSpawnEnv,
  spawnEnv,
  readCustomEnv,
  writeCustomEnv,
  listCustomEnvEntries,
  revealCustomEnvVar,
  setCustomEnvVar,
  deleteCustomEnvVar,
  renameCustomEnvVar,
  migrateSecretsAtRest,
  customEnvStatus,
  createSecretRedactor,
  DISABLE_AUTOCOMPACT_KEY,
  CUSTOM_ENV_VARS_KEY,
} from './custom-env'
import { getPref, setPref } from './prefs-store'

vi.mock('./prefs-store', () => ({ getPref: vi.fn(), setPref: vi.fn() }))

const getPrefMock = vi.mocked(getPref)
const setPrefMock = vi.mocked(setPref)

describe('sanitizeCustomEnv', () => {
  it('mapa válido passa intacto', () => {
    expect(sanitizeCustomEnv({ FOO: 'bar', TOKEN: 'sk-123' })).toEqual({
      FOO: 'bar',
      TOKEN: 'sk-123',
    })
  })

  it('null/array/string → {}', () => {
    expect(sanitizeCustomEnv(null)).toEqual({})
    expect(sanitizeCustomEnv(['FOO'])).toEqual({})
    expect(sanitizeCustomEnv('FOO=bar')).toEqual({})
  })

  it('ignora chaves vazias e valores não-string', () => {
    expect(sanitizeCustomEnv({ '': 'x', '  ': 'y', NUM: 1, OBJ: {}, OK: 'v' })).toEqual({ OK: 'v' })
  })

  it('trim na chave', () => {
    expect(sanitizeCustomEnv({ '  FOO  ': 'bar' })).toEqual({ FOO: 'bar' })
  })
})

describe('mergeCustomEnv', () => {
  it('custom tem precedência sobre a base (override do usuário)', () => {
    const merged = mergeCustomEnv({ PATH: '/usr/bin', FOO: 'base' }, { FOO: 'override' })
    expect(merged.FOO).toBe('override')
    expect(merged.PATH).toBe('/usr/bin')
  })

  it('base intacta quando custom vazio', () => {
    const base = { PATH: '/usr/bin' }
    expect(mergeCustomEnv(base, {})).toEqual(base)
  })

  it('retorna objeto novo (não muta a base)', () => {
    const base = { FOO: 'base' }
    const merged = mergeCustomEnv(base, { BAR: 'x' })
    expect(merged).not.toBe(base)
    expect(base).toEqual({ FOO: 'base' })
  })
})

describe('getEnvVar', () => {
  beforeEach(() => {
    getPrefMock.mockReset()
    delete process.env.CM_TEST_KEY
  })

  afterEach(() => {
    delete process.env.CM_TEST_KEY
  })

  it('pref tem precedência sobre process.env', () => {
    getPrefMock.mockReturnValue({ CM_TEST_KEY: 'from-pref' })
    process.env.CM_TEST_KEY = 'from-env'
    expect(getEnvVar('CM_TEST_KEY')).toBe('from-pref')
  })

  it('cai para process.env quando a pref não tem a chave', () => {
    getPrefMock.mockReturnValue({})
    process.env.CM_TEST_KEY = 'from-env'
    expect(getEnvVar('CM_TEST_KEY')).toBe('from-env')
  })

  it('valor vazio na pref não mascara o process.env', () => {
    getPrefMock.mockReturnValue({ CM_TEST_KEY: '' })
    process.env.CM_TEST_KEY = 'from-env'
    expect(getEnvVar('CM_TEST_KEY')).toBe('from-env')
  })

  it('ausente nos dois → undefined', () => {
    getPrefMock.mockReturnValue(null)
    expect(getEnvVar('CM_TEST_KEY')).toBeUndefined()
  })
})

describe('withAutoCompactDisabled', () => {
  it('disabled → DISABLE_AUTOCOMPACT=1', () => {
    expect(withAutoCompactDisabled({ PATH: '/usr/bin' }, true)).toEqual({
      PATH: '/usr/bin',
      DISABLE_AUTOCOMPACT: '1',
    })
  })

  it('não-disabled → chave ausente (nunca 0)', () => {
    const env = withAutoCompactDisabled({ PATH: '/usr/bin' }, false)
    expect('DISABLE_AUTOCOMPACT' in env).toBe(false)
  })

  it('retorna objeto novo (não muta a base)', () => {
    const base = { PATH: '/usr/bin' }
    const env = withAutoCompactDisabled(base, true)
    expect(env).not.toBe(base)
    expect(base).toEqual({ PATH: '/usr/bin' })
  })
})

describe('sessionSpawnEnv', () => {
  function mockPrefs(prefs: { disableAutoCompact?: boolean; custom?: unknown }) {
    getPrefMock.mockImplementation((key: string, fallback: unknown) => {
      if (key === DISABLE_AUTOCOMPACT_KEY) return prefs.disableAutoCompact ?? fallback
      if (key === CUSTOM_ENV_VARS_KEY) return prefs.custom ?? fallback
      return fallback
    })
  }

  beforeEach(() => {
    getPrefMock.mockReset()
  })

  it('pref ligada → DISABLE_AUTOCOMPACT=1', () => {
    mockPrefs({ disableAutoCompact: true })
    expect(sessionSpawnEnv({ PATH: '/usr/bin' }).DISABLE_AUTOCOMPACT).toBe('1')
  })

  it('pref desligada → chave ausente', () => {
    mockPrefs({ disableAutoCompact: false })
    expect('DISABLE_AUTOCOMPACT' in sessionSpawnEnv({ PATH: '/usr/bin' })).toBe(false)
  })

  it('pref ausente → chave ausente', () => {
    mockPrefs({})
    expect('DISABLE_AUTOCOMPACT' in sessionSpawnEnv({ PATH: '/usr/bin' })).toBe(false)
  })

  it('remove os markers de sessão filha herdados do ambiente do app', () => {
    mockPrefs({})
    const env = sessionSpawnEnv({
      PATH: '/usr/bin',
      CLAUDE_CODE_CHILD_SESSION: '1',
      CLAUDE_CODE_SKIP_PROMPT_HISTORY: '1',
    })
    expect('CLAUDE_CODE_CHILD_SESSION' in env).toBe(false)
    expect('CLAUDE_CODE_SKIP_PROMPT_HISTORY' in env).toBe(false)
    expect(env.PATH).toBe('/usr/bin')
  })

  it('não muta o base recebido', () => {
    mockPrefs({})
    const base = { PATH: '/usr/bin', CLAUDE_CODE_CHILD_SESSION: '1' }
    sessionSpawnEnv(base)
    expect(base.CLAUDE_CODE_CHILD_SESSION).toBe('1')
  })

  it('custom env do usuário ainda pode remarcar a sessão como filha', () => {
    mockPrefs({ custom: { CLAUDE_CODE_CHILD_SESSION: '1' } })
    expect(sessionSpawnEnv({ PATH: '/usr/bin' }).CLAUDE_CODE_CHILD_SESSION).toBe('1')
  })

  it('custom env do usuário sobrescreve a var', () => {
    mockPrefs({
      disableAutoCompact: true,
      custom: { DISABLE_AUTOCOMPACT: '0', FOO: 'bar' },
    })
    const env = sessionSpawnEnv({ PATH: '/usr/bin' })
    expect(env.DISABLE_AUTOCOMPACT).toBe('0')
    expect(env.FOO).toBe('bar')
  })

  it('não muta a base', () => {
    mockPrefs({ disableAutoCompact: true })
    const base = { PATH: '/usr/bin' }
    const env = sessionSpawnEnv(base)
    expect(env).not.toBe(base)
    expect(base).toEqual({ PATH: '/usr/bin' })
  })
})

// Store de prefs em memória com o MESMO roundtrip de serialização do SQLite
// (JSON.stringify/parse), para o envelope cifrado ser exercitado como é gravado.
describe('segredos em repouso', () => {
  const store = new Map<string, unknown>()

  function storedRaw(): unknown {
    return store.get(CUSTOM_ENV_VARS_KEY)
  }

  beforeEach(() => {
    store.clear()
    getPrefMock.mockReset()
    setPrefMock.mockReset()
    getPrefMock.mockImplementation((key: string, fallback: unknown) =>
      store.has(key) ? store.get(key) : fallback,
    )
    setPrefMock.mockImplementation((key: string, value: unknown) => {
      store.set(key, JSON.parse(JSON.stringify(value)))
    })
  })

  it('o que vai pro banco é ciphertext — o texto claro não aparece', () => {
    writeCustomEnv({ SOME_TOKEN: 'fake-secret-value' })
    expect(JSON.stringify(storedRaw())).not.toContain('fake-secret-value')
    expect(readCustomEnv()).toEqual({ SOME_TOKEN: 'fake-secret-value' })
  })

  it('o valor decifrado chega ao env do spawn', () => {
    writeCustomEnv({ SOME_TOKEN: 'fake-secret-value' })
    expect(spawnEnv({ PATH: '/usr/bin' }).SOME_TOKEN).toBe('fake-secret-value')
  })

  it('migra a pref legada em claro sem perder valor nenhum', () => {
    store.set(CUSTOM_ENV_VARS_KEY, {
      SOME_TOKEN: 'fake-secret-value',
      FLAG: '1',
    })

    const result = migrateSecretsAtRest()

    expect(result.migrated).toBe(2)
    expect(result.skipped).toBeNull()
    expect(JSON.stringify(storedRaw())).not.toContain('fake-secret-value')
    expect(readCustomEnv()).toEqual({
      SOME_TOKEN: 'fake-secret-value',
      FLAG: '1',
    })
  })

  it('migração é idempotente — a segunda passada não reescreve', () => {
    store.set(CUSTOM_ENV_VARS_KEY, { SOME_TOKEN: 'fake-secret-value' })
    migrateSecretsAtRest()
    setPrefMock.mockClear()

    const second = migrateSecretsAtRest()

    expect(second.skipped).toBe('not-needed')
    expect(setPrefMock).not.toHaveBeenCalled()
  })

  it('pref ausente → nada a migrar', () => {
    expect(migrateSecretsAtRest().skipped).toBe('not-needed')
  })

  // Regressão: no mapa misto (um ciphertext ILEGÍVEL ao lado de um valor em
  // claro), a migração reescrevia só o que decifrava e a chave ilegível
  // desaparecia do banco. O guard não pegava porque comparava só os valores
  // legíveis — e o ilegível está fora dos dois lados.
  it('mapa misto: a chave ilegível sobrevive à migração com o ciphertext intacto', () => {
    const alienBlob = Buffer.from('outro-cofre:opaco', 'utf8').toString('base64')
    store.set(CUSTOM_ENV_VARS_KEY, {
      version: 2,
      vars: {
        LOST: { enc: true, data: alienBlob },
        PLAIN: { enc: false, value: 'fake-plain-value' },
      },
    })

    const result = migrateSecretsAtRest()

    expect(result.migrated).toBe(1)
    const stored = storedRaw() as { vars: Record<string, unknown> }
    expect(Object.keys(stored.vars).sort()).toEqual(['LOST', 'PLAIN'])
    expect(stored.vars.LOST).toEqual({ enc: true, data: alienBlob })
    expect(JSON.stringify(stored)).not.toContain('fake-plain-value')
  })

  it('mapa misto: a UI continua vendo a chave ilegível depois da migração', () => {
    store.set(CUSTOM_ENV_VARS_KEY, {
      version: 2,
      vars: {
        LOST: {
          enc: true,
          data: Buffer.from('outro-cofre:opaco', 'utf8').toString('base64'),
        },
        PLAIN: { enc: false, value: 'fake-plain-value' },
      },
    })

    migrateSecretsAtRest()

    expect(listCustomEnvEntries()).toEqual([
      { key: 'LOST', hasValue: true, encrypted: true, unreadable: true },
      { key: 'PLAIN', hasValue: true, encrypted: true, unreadable: false },
    ])
  })

  it('mexer numa chave não apaga a ilegível ao lado', () => {
    const alienBlob = Buffer.from('outro-cofre:opaco', 'utf8').toString('base64')
    store.set(CUSTOM_ENV_VARS_KEY, {
      version: 2,
      vars: {
        LOST: { enc: true, data: alienBlob },
        KEEP: { enc: false, value: 'fake-keep' },
      },
    })

    setCustomEnvVar('NOVA', 'fake-nova')
    deleteCustomEnvVar('KEEP')
    renameCustomEnvVar('NOVA', 'RENOMEADA')

    const stored = storedRaw() as { vars: Record<string, unknown> }
    expect(stored.vars.LOST).toEqual({ enc: true, data: alienBlob })
    expect(readCustomEnv()).toEqual({ RENOMEADA: 'fake-nova' })
  })

  it('apagar a chave ilegível é explícito e funciona', () => {
    store.set(CUSTOM_ENV_VARS_KEY, {
      version: 2,
      vars: {
        LOST: {
          enc: true,
          data: Buffer.from('outro-cofre:x', 'utf8').toString('base64'),
        },
      },
    })

    deleteCustomEnvVar('LOST')

    expect(listCustomEnvEntries()).toEqual([])
  })

  it('sobrescrever a chave ilegível troca o envelope pelo valor novo', () => {
    store.set(CUSTOM_ENV_VARS_KEY, {
      version: 2,
      vars: {
        LOST: {
          enc: true,
          data: Buffer.from('outro-cofre:x', 'utf8').toString('base64'),
        },
      },
    })

    setCustomEnvVar('LOST', 'fake-novo-valor')

    expect(revealCustomEnvVar('LOST')).toBe('fake-novo-valor')
    expect(customEnvStatus().unreadableKeys).toEqual([])
  })

  it('os ganchos de manutenção cercam a gravação, e só quando há migração', () => {
    const calls: string[] = []
    const hooks = {
      beforeWrite: () => calls.push('backup'),
      afterWrite: () => calls.push('vacuum'),
    }
    store.set(CUSTOM_ENV_VARS_KEY, { SOME_TOKEN: 'fake-secret-value' })

    migrateSecretsAtRest(undefined, hooks)
    expect(calls).toEqual(['backup', 'vacuum'])

    migrateSecretsAtRest(undefined, hooks)
    expect(calls).toEqual(['backup', 'vacuum'])
  })

  it('falha no backup aborta a migração — o banco fica como estava', () => {
    store.set(CUSTOM_ENV_VARS_KEY, { SOME_TOKEN: 'fake-secret-value' })

    expect(() =>
      migrateSecretsAtRest(undefined, {
        beforeWrite: () => {
          throw new Error('disco cheio')
        },
      }),
    ).toThrow('disco cheio')
    expect(storedRaw()).toEqual({ SOME_TOKEN: 'fake-secret-value' })
  })

  it('a listagem para a UI não carrega valor nenhum', () => {
    writeCustomEnv({ SOME_TOKEN: 'fake-secret-value' })
    const entries = listCustomEnvEntries()
    expect(entries).toEqual([
      { key: 'SOME_TOKEN', hasValue: true, encrypted: true, unreadable: false },
    ])
    expect(JSON.stringify(entries)).not.toContain('fake-secret-value')
  })

  it('revelar devolve o valor de UMA chave; chave inexistente → null', () => {
    writeCustomEnv({ SOME_TOKEN: 'fake-secret-value' })
    expect(revealCustomEnvVar('SOME_TOKEN')).toBe('fake-secret-value')
    expect(revealCustomEnvVar('NOPE')).toBeNull()
  })

  it('set preserva as outras chaves', () => {
    writeCustomEnv({ A: 'fake-a', B: 'fake-b' })
    setCustomEnvVar('B', 'fake-b2')
    expect(readCustomEnv()).toEqual({ A: 'fake-a', B: 'fake-b2' })
  })

  it('delete remove só a chave pedida', () => {
    writeCustomEnv({ A: 'fake-a', B: 'fake-b' })
    deleteCustomEnvVar('A')
    expect(readCustomEnv()).toEqual({ B: 'fake-b' })
  })

  it('renomear preserva o valor sem ele passar pela UI', () => {
    writeCustomEnv({ OLD_NAME: 'fake-secret-value' })
    renameCustomEnvVar('OLD_NAME', 'NEW_NAME')
    expect(readCustomEnv()).toEqual({ NEW_NAME: 'fake-secret-value' })
  })

  it('renomear para chave inexistente/vazia é no-op', () => {
    writeCustomEnv({ A: 'fake-a' })
    renameCustomEnvVar('NOPE', 'B')
    expect(readCustomEnv()).toEqual({ A: 'fake-a' })
  })

  it('status reporta o backend e nenhuma chave em claro quando tudo cifrou', () => {
    writeCustomEnv({ SOME_TOKEN: 'fake-secret-value' })
    expect(customEnvStatus()).toEqual({
      backend: 'os_keyring',
      plaintextKeys: [],
      unreadableKeys: [],
    })
  })

  it('status denuncia a pref legada ainda em claro', () => {
    store.set(CUSTOM_ENV_VARS_KEY, { SOME_TOKEN: 'fake-secret-value' })
    expect(customEnvStatus().plaintextKeys).toEqual(['SOME_TOKEN'])
  })
})

describe('createSecretRedactor', () => {
  it('remove o valor do segredo da linha de log', () => {
    const redact = createSecretRedactor({ SOME_TOKEN: 'fake-secret-value' })
    const line = redact('Traceback: auth falhou com fake-secret-value no header')
    expect(line).not.toContain('fake-secret-value')
    expect(line).toContain('[REDACTED]')
  })

  it('valores curtos (flags) não são redigidos — não picota o log', () => {
    const redact = createSecretRedactor({ DEBUG: '1', LEVEL: 'info' })
    expect(redact('info 1 info')).toBe('info 1 info')
  })

  it('sem segredos, é identidade', () => {
    expect(createSecretRedactor({})('linha qualquer')).toBe('linha qualquer')
  })
})
