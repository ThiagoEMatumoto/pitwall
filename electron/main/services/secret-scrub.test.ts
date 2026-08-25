import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => false,
    getSelectedStorageBackend: () => 'basic_text',
    encryptString: () => Buffer.from(''),
    decryptString: () => '',
  },
}))

const listCustomEnvEntries = vi.fn()
const writeCustomEnv = vi.fn()
vi.mock('./custom-env', () => ({
  listCustomEnvEntries: () => listCustomEnvEntries(),
  writeCustomEnv: (values: Record<string, string>) => writeCustomEnv(values),
}))

import {
  DISPOSABLE_SECRET_PLACEHOLDER,
  isInsideDir,
  scrubProfileSecrets,
  shouldScrubProfile,
} from './secret-scrub'

describe('isInsideDir', () => {
  it('reconhece descendente e o próprio dir', () => {
    expect(isInsideDir('/tmp', '/tmp/cm-drive-userdata-abc')).toBe(true)
    expect(isInsideDir('/tmp', '/tmp')).toBe(true)
  })

  it('prefixo textual não basta — precisa ser componente de caminho', () => {
    expect(isInsideDir('/tmp', '/tmpfoo/bar')).toBe(false)
    expect(isInsideDir('/tmp', '/home/dev/.config/app')).toBe(false)
  })
})

describe('shouldScrubProfile', () => {
  it('flag + userData dentro do tmpdir → limpa', () => {
    expect(shouldScrubProfile({ CM_SCRUB_SECRETS: '1' }, '/tmp/cm-drive-x', '/tmp')).toBe(true)
  })

  it('flag sem userData descartável NÃO limpa (protege o perfil real)', () => {
    expect(
      shouldScrubProfile({ CM_SCRUB_SECRETS: '1' }, '/home/dev/.config/pitwall', '/tmp'),
    ).toBe(false)
  })

  it('userData descartável sem a flag não limpa', () => {
    expect(shouldScrubProfile({}, '/tmp/cm-drive-x', '/tmp')).toBe(false)
    expect(shouldScrubProfile({ CM_SCRUB_SECRETS: '0' }, '/tmp/cm-drive-x', '/tmp')).toBe(false)
  })
})

describe('scrubProfileSecrets', () => {
  beforeEach(() => {
    listCustomEnvEntries.mockReset()
    writeCustomEnv.mockReset()
  })

  it('preserva os nomes das chaves e troca todos os valores pelo placeholder', () => {
    listCustomEnvEntries.mockReturnValue([
      { key: 'SOME_TOKEN', hasValue: true, encrypted: true, unreadable: false },
      { key: 'OTHER_TOKEN', hasValue: false, encrypted: true, unreadable: false },
    ])
    expect(scrubProfileSecrets()).toBe(2)
    expect(writeCustomEnv).toHaveBeenCalledWith({
      SOME_TOKEN: DISPOSABLE_SECRET_PLACEHOLDER,
      OTHER_TOKEN: DISPOSABLE_SECRET_PLACEHOLDER,
    })
  })

  it('placeholder é não-vazio — os gates de integração continuam ligados', () => {
    expect(DISPOSABLE_SECRET_PLACEHOLDER.length).toBeGreaterThan(0)
  })

  it('sem vars, não grava nada', () => {
    listCustomEnvEntries.mockReturnValue([])
    expect(scrubProfileSecrets()).toBe(0)
    expect(writeCustomEnv).not.toHaveBeenCalled()
  })
})
