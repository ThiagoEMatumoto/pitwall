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
  sameSecrets,
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
    expect(stored.vars.SOME_TOKEN).toEqual({
      enc: true,
      data: expect.any(String),
    })
    expect(JSON.stringify(stored)).not.toContain('fake-secret-value')
    expect(plaintext).toEqual([])
  })

  it('cofre indisponível → grava em claro e REPORTA as chaves afetadas', () => {
    const { stored, plaintext } = encodeSecrets(
      { SOME_TOKEN: 'fake-secret-value' },
      fakeCrypto('unavailable'),
    )
    expect(stored.vars.SOME_TOKEN).toEqual({
      enc: false,
      value: 'fake-secret-value',
    })
    expect(plaintext).toEqual(['SOME_TOKEN'])
  })

  it('falha na cifragem preserva o valor em claro em vez de perdê-lo', () => {
    const { stored, plaintext } = encodeSecrets(
      { SOME_TOKEN: 'fake-secret-value' },
      fakeCrypto('os_keyring', { encrypt: true }),
    )
    expect(stored.vars.SOME_TOKEN).toEqual({
      enc: false,
      value: 'fake-secret-value',
    })
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

  it('o envelope da chave ilegível é devolvido intacto para poder ser regravado', () => {
    const { stored } = encodeSecrets({ A: 'fake-a' }, fakeCrypto())
    const decoded = decodeSecrets(stored, fakeCrypto('os_keyring', { decrypt: true }))
    expect(decoded.preserved).toEqual({ A: stored.vars.A })
  })

  it('null / array / string → vazio', () => {
    const crypto = fakeCrypto()
    expect(decodeSecrets(null, crypto).values).toEqual({})
    expect(decodeSecrets(['A'], crypto).values).toEqual({})
    expect(decodeSecrets('A=1', crypto).values).toEqual({})
  })

  it('entrada cifrada sem data é reportada como ilegível, não descartada em silêncio', () => {
    const decoded = decodeSecrets({ version: 2, vars: { A: { enc: true } } }, fakeCrypto())
    expect(decoded.unreadable).toEqual(['A'])
  })
})

describe('encodeSecrets + envelopes ilegíveis', () => {
  it('regravar o mapa não apaga a chave ilegível — o envelope volta intacto', () => {
    const crypto = fakeCrypto()
    const alienBlob = Buffer.from('outro-cofre:opaco', 'utf8').toString('base64')
    const misto = {
      version: SECRET_MAP_VERSION,
      vars: {
        LOST: { enc: true as const, data: alienBlob },
        PLAIN: { enc: false as const, value: 'fake-plain' },
      },
    }
    const decoded = decodeSecrets(misto, crypto)
    expect(decoded.unreadable).toEqual(['LOST'])

    const { stored } = encodeSecrets(decoded.values, crypto, decoded.preserved)

    expect(Object.keys(stored.vars).sort()).toEqual(['LOST', 'PLAIN'])
    expect(stored.vars.LOST).toEqual({ enc: true, data: alienBlob })
  })

  it('valor legível vence a colisão com um envelope preservado de mesmo nome', () => {
    const crypto = fakeCrypto()
    const { stored } = encodeSecrets({ A: 'fake-a' }, crypto, {
      A: { enc: true, data: 'blob-antigo' },
    })
    expect(decodeSecrets(stored, crypto).values).toEqual({ A: 'fake-a' })
  })

  it('envelope cifrado malformado também volta verbatim (não é papel do encode consertar)', () => {
    const crypto = fakeCrypto()
    const decoded = decodeSecrets(
      { version: SECRET_MAP_VERSION, vars: { A: { enc: true } } },
      crypto,
    )
    const { stored } = encodeSecrets(decoded.values, crypto, decoded.preserved)
    expect(stored.vars.A).toEqual({ enc: true })
  })
})

describe('sameSecrets', () => {
  const crypto = fakeCrypto()

  it('mapa misto onde a chave ilegível sumiu é reprovado (o ponto cego do guard antigo)', () => {
    const alienBlob = Buffer.from('outro-cofre:opaco', 'utf8').toString('base64')
    const before = decodeSecrets(
      {
        version: SECRET_MAP_VERSION,
        vars: {
          LOST: { enc: true as const, data: alienBlob },
          PLAIN: { enc: false as const, value: 'fake-plain' },
        },
      },
      crypto,
    )
    const semLost = decodeSecrets(encodeSecrets(before.values, crypto).stored, crypto)

    // Os valores legíveis batem dos dois lados — era exatamente isso que deixava
    // a perda passar.
    expect(semLost.values).toEqual(before.values)
    expect(sameSecrets(before, semLost)).toBe(false)
  })

  it('mapa misto com o envelope preservado é aprovado', () => {
    const alienBlob = Buffer.from('outro-cofre:opaco', 'utf8').toString('base64')
    const before = decodeSecrets(
      {
        version: SECRET_MAP_VERSION,
        vars: {
          LOST: { enc: true as const, data: alienBlob },
          PLAIN: { enc: false as const, value: 'fake-plain' },
        },
      },
      crypto,
    )
    const after = decodeSecrets(
      encodeSecrets(before.values, crypto, before.preserved).stored,
      crypto,
    )
    expect(sameSecrets(before, after)).toBe(true)
  })

  it('valor alterado reprova', () => {
    const before = decodeSecrets({ A: 'fake-a' }, crypto)
    const after = decodeSecrets({ A: 'fake-outro' }, crypto)
    expect(sameSecrets(before, after)).toBe(false)
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
    const stored = {
      version: 2,
      vars: { A: { enc: false as const, value: 'fake-a' } },
    }
    expect(needsMigration(decodeSecrets(stored, crypto), crypto)).toBe(true)
  })

  it('cofre indisponível → nunca tenta migrar', () => {
    const crypto = fakeCrypto('unavailable')
    expect(needsMigration(decodeSecrets({ A: 'fake-a' }, crypto), crypto)).toBe(false)
  })
})
