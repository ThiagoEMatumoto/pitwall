import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => false,
    getSelectedStorageBackend: () => 'basic_text',
    encryptString: () => Buffer.from(''),
    decryptString: () => '',
  },
}))

import {
  decodeSecrets,
  encodeSecrets,
  needsMigration,
  SECRET_MAP_VERSION,
  type EncryptionBackend,
  type SecretCrypto,
} from './secret-store'

// Cifra de mentira, reversível e determinística. Todos os valores usados nos
// testes são fictícios.
function fakeCrypto(
  backend: EncryptionBackend = 'os_keyring',
  fail: { encrypt?: boolean; decrypt?: boolean } = {},
): SecretCrypto {
  return {
    backend: () => backend,
    encrypt: (plain) => {
      if (fail.encrypt) throw new Error('vault refused')
      return Buffer.from(`v:${plain}`, 'utf8').toString('base64')
    },
    decrypt: (data) => {
      if (fail.decrypt) throw new Error('vault refused')
      const raw = Buffer.from(data, 'base64').toString('utf8')
      if (!raw.startsWith('v:')) throw new Error('not mine')
      return raw.slice(2)
    },
  }
}

describe('encodeSecrets', () => {
  it('cifra valores não-vazios e não deixa o texto claro no envelope', () => {
    const crypto = fakeCrypto()
    const { stored, plaintext } = encodeSecrets({ SOME_TOKEN: 'fake-secret-value' }, crypto)

    expect(stored.version).toBe(SECRET_MAP_VERSION)
    expect(stored.vars.SOME_TOKEN).toEqual({ enc: true, data: expect.any(String) })
    expect(JSON.stringify(stored)).not.toContain('fake-secret-value')
    expect(plaintext).toEqual([])
  })

  it('cofre indisponível → grava em claro e REPORTA as chaves afetadas', () => {
    const { stored, plaintext } = encodeSecrets(
      { SOME_TOKEN: 'fake-secret-value' },
      fakeCrypto('unavailable'),
    )
    expect(stored.vars.SOME_TOKEN).toEqual({ enc: false, value: 'fake-secret-value' })
    expect(plaintext).toEqual(['SOME_TOKEN'])
  })

  it('falha na cifragem preserva o valor em claro em vez de perdê-lo', () => {
    const { stored, plaintext } = encodeSecrets(
      { SOME_TOKEN: 'fake-secret-value' },
      fakeCrypto('os_keyring', { encrypt: true }),
    )
    expect(stored.vars.SOME_TOKEN).toEqual({ enc: false, value: 'fake-secret-value' })
    expect(plaintext).toEqual(['SOME_TOKEN'])
  })

  it('valor vazio não é segredo — fica em claro e fora do relatório', () => {
    const { stored, plaintext } = encodeSecrets({ EMPTY: '' }, fakeCrypto())
    expect(stored.vars.EMPTY).toEqual({ enc: false, value: '' })
    expect(plaintext).toEqual([])
  })

  it('ignora chaves vazias e faz trim', () => {
    const { stored } = encodeSecrets({ '  PADDED  ': 'x', '': 'y' }, fakeCrypto())
    expect(Object.keys(stored.vars)).toEqual(['PADDED'])
  })
})

describe('decodeSecrets', () => {
  it('roundtrip devolve exatamente os valores originais', () => {
    const crypto = fakeCrypto()
    const values = { A: 'fake-a', B: 'fake-b', EMPTY: '' }
    const { stored } = encodeSecrets(values, crypto)
    const decoded = decodeSecrets(stored, crypto)

    expect(decoded.values).toEqual(values)
    expect(decoded.legacy).toBe(false)
    expect(decoded.plaintext).toEqual([])
    expect(decoded.unreadable).toEqual([])
  })

  it('formato v1 (mapa plano em claro) continua legível e é marcado como legado', () => {
    const decoded = decodeSecrets({ A: 'fake-a', B: '' }, fakeCrypto())
    expect(decoded.values).toEqual({ A: 'fake-a', B: '' })
    expect(decoded.legacy).toBe(true)
    expect(decoded.plaintext).toEqual(['A'])
  })

  it('ciphertext que não decifra vira "unreadable" em vez de exceção', () => {
    const { stored } = encodeSecrets({ A: 'fake-a' }, fakeCrypto())
    const decoded = decodeSecrets(stored, fakeCrypto('os_keyring', { decrypt: true }))
    expect(decoded.unreadable).toEqual(['A'])
    expect(decoded.values).toEqual({})
  })

  it('null / array / string → vazio', () => {
    const crypto = fakeCrypto()
    expect(decodeSecrets(null, crypto).values).toEqual({})
    expect(decodeSecrets(['A'], crypto).values).toEqual({})
    expect(decodeSecrets('A=1', crypto).values).toEqual({})
  })

  it('entrada cifrada sem data é reportada como ilegível, não descartada em silêncio', () => {
    const decoded = decodeSecrets(
      { version: 2, vars: { A: { enc: true } } },
      fakeCrypto(),
    )
    expect(decoded.unreadable).toEqual(['A'])
  })
})

describe('needsMigration', () => {
  it('pref legada com valores → migra', () => {
    const crypto = fakeCrypto()
    expect(needsMigration(decodeSecrets({ A: 'fake-a' }, crypto), crypto)).toBe(true)
  })

  it('pref legada vazia → nada a fazer', () => {
    const crypto = fakeCrypto()
    expect(needsMigration(decodeSecrets({}, crypto), crypto)).toBe(false)
  })

  it('já cifrado → nada a fazer', () => {
    const crypto = fakeCrypto()
    const { stored } = encodeSecrets({ A: 'fake-a' }, crypto)
    expect(needsMigration(decodeSecrets(stored, crypto), crypto)).toBe(false)
  })

  it('valor em claro num envelope v2 → migra', () => {
    const crypto = fakeCrypto()
    const stored = { version: 2, vars: { A: { enc: false as const, value: 'fake-a' } } }
    expect(needsMigration(decodeSecrets(stored, crypto), crypto)).toBe(true)
  })

  it('cofre indisponível → nunca tenta migrar', () => {
    const crypto = fakeCrypto('unavailable')
    expect(needsMigration(decodeSecrets({ A: 'fake-a' }, crypto), crypto)).toBe(false)
  })
})
