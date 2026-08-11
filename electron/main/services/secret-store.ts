import { safeStorage } from 'electron'

// Cofre de segredos em repouso. Os valores de `custom_env_vars` (chaves de API do
// usuário) eram gravados em texto claro no SQLite: qualquer cópia do userData
// levava o segredo junto — o harness de e2e copia o dir inteiro pra /tmp a cada
// run, e um transcrito de agente que leia o banco carrega a chave. Agora o que
// fica no banco é o ciphertext do safeStorage do Electron (atado ao cofre de
// credenciais do SO); o texto claro só existe em memória no main, no instante do
// uso.

export const SECRET_MAP_VERSION = 2

export type StoredSecret = { enc: true; data: string } | { enc: false; value: string }

export interface StoredSecretMap {
  version: number
  vars: Record<string, StoredSecret>
}

// 'basic_text' é o fallback do Chromium no Linux sem keyring: cifra com uma chave
// fixa e pública, o que é ofuscação, não proteção. Distinguido de 'os_keyring'
// justamente para a UI poder dizer isso ao usuário em vez de fingir segurança.
export type EncryptionBackend = 'unavailable' | 'basic_text' | 'os_keyring'

export interface SecretCrypto {
  backend(): EncryptionBackend
  encrypt(plain: string): string
  decrypt(data: string): string
}

// safeStorage só responde de forma confiável depois do app ready; antes disso (e
// em qualquer ambiente sem o binding nativo) o try/catch degrada pra
// 'unavailable', que é o caminho conservador: grava em claro e avisa.
export const electronCrypto: SecretCrypto = {
  backend(): EncryptionBackend {
    try {
      if (!safeStorage.isEncryptionAvailable()) return 'unavailable'
      if (process.platform !== 'linux') return 'os_keyring'
      return safeStorage.getSelectedStorageBackend() === 'basic_text' ? 'basic_text' : 'os_keyring'
    } catch {
      return 'unavailable'
    }
  },
  encrypt: (plain) => safeStorage.encryptString(plain).toString('base64'),
  decrypt: (data) => safeStorage.decryptString(Buffer.from(data, 'base64')),
}

export interface DecodedSecrets {
  values: Record<string, string>
  // Chaves cujo ciphertext não decifrou (cofre do SO trocado, banco copiado pra
  // outra máquina/usuário). O valor é INACESSÍVEL, não perdido: continua gravado.
  unreadable: string[]
  // Envelope ORIGINAL das chaves ilegíveis. É o que faz "inacessível, não
  // perdido" ser verdade numa reescrita: quem regrava o mapa devolve estes
  // envelopes verbatim, já que não tem como recriá-los a partir de `values`.
  preserved: Record<string, StoredSecret>
  // Chaves ainda em claro no banco — formato legado ou gravadas com a cifragem
  // indisponível. Alimenta o aviso da UI.
  plaintext: string[]
  // Pref ainda no formato v1 (mapa plano `chave -> valor em claro`).
  legacy: boolean
}

const EMPTY: DecodedSecrets = {
  values: {},
  unreadable: [],
  preserved: {},
  plaintext: [],
  legacy: false,
}

function isStoredMap(raw: unknown): raw is StoredSecretMap {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false
  const candidate = raw as Partial<StoredSecretMap>
  return typeof candidate.version === 'number' && typeof candidate.vars === 'object'
}

// Formato v1: mapa plano string→string, tudo em claro. Ainda é lido (usuários que
// não passaram pela migração) e nunca é reescrito aqui — quem migra é
// migrateSecretsAtRest.
function decodeLegacy(raw: unknown): DecodedSecrets {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return EMPTY
  const values: Record<string, string> = {}
  const plaintext: string[] = []
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const k = key.trim()
    if (!k || typeof value !== 'string') continue
    values[k] = value
    if (value) plaintext.push(k)
  }
  return { values, unreadable: [], preserved: {}, plaintext, legacy: true }
}

export function decodeSecrets(raw: unknown, crypto: SecretCrypto): DecodedSecrets {
  if (!isStoredMap(raw)) return decodeLegacy(raw)
  const values: Record<string, string> = {}
  const unreadable: string[] = []
  const preserved: Record<string, StoredSecret> = {}
  const plaintext: string[] = []
  for (const [key, entry] of Object.entries(raw.vars)) {
    const k = key.trim()
    if (!k || !entry || typeof entry !== 'object') continue
    if ((entry as { enc?: unknown }).enc === true) {
      // O envelope volta ao banco verbatim — inclusive o malformado. Consertar o
      // que não se sabe ler não é papel de quem só está regravando o mapa.
      const data = (entry as { data?: unknown }).data
      if (typeof data !== 'string') {
        unreadable.push(k)
        preserved[k] = entry as StoredSecret
        continue
      }
      try {
        values[k] = crypto.decrypt(data)
      } catch {
        // Nunca propaga: uma chave ilegível não pode derrubar o spawn de sessão
        // nem a tela de configurações.
        unreadable.push(k)
        preserved[k] = { enc: true, data }
      }
      continue
    }
    const value = (entry as { value?: unknown }).value
    if (typeof value !== 'string') continue
    values[k] = value
    if (value) plaintext.push(k)
  }
  return { values, unreadable, preserved, plaintext, legacy: false }
}

export interface EncodedSecrets {
  stored: StoredSecretMap
  // Chaves que acabaram em claro nesta gravação (cifragem indisponível). Vazio =
  // tudo cifrado.
  plaintext: string[]
}

// Valores vazios não são segredo — ficam em claro para não gastar uma chamada ao
// cofre e para o roundtrip de teste continuar trivial.
//
// `preserved` são os envelopes ilegíveis vindos do decode: entram no mapa antes
// dos valores (quem tem valor legível vence a colisão) porque não há como
// reconstruí-los — omití-los aqui é apagar a chave do usuário.
export function encodeSecrets(
  values: Record<string, string>,
  crypto: SecretCrypto,
  preserved: Record<string, StoredSecret> = {},
): EncodedSecrets {
  const available = crypto.backend() !== 'unavailable'
  const vars: Record<string, StoredSecret> = {}
  const plaintext: string[] = []
  for (const [key, entry] of Object.entries(preserved)) {
    const k = key.trim()
    if (k) vars[k] = entry
  }
  for (const [key, value] of Object.entries(values)) {
    const k = key.trim()
    if (!k || typeof value !== 'string') continue
    if (!value || !available) {
      vars[k] = { enc: false, value }
      if (value) plaintext.push(k)
      continue
    }
    try {
      vars[k] = { enc: true, data: crypto.encrypt(value) }
    } catch {
      // Cofre disse que estava disponível e falhou mesmo assim: preserva o valor
      // do usuário em claro e reporta, em vez de perder o dado silenciosamente.
      vars[k] = { enc: false, value }
      plaintext.push(k)
    }
  }
  return { stored: { version: SECRET_MAP_VERSION, vars }, plaintext }
}

// A migração só reescreve quando há ganho real: pref legada, ou algum valor
// não-vazio ainda em claro num banco onde a cifragem está disponível.
export function needsMigration(decoded: DecodedSecrets, crypto: SecretCrypto): boolean {
  if (crypto.backend() === 'unavailable') return false
  if (decoded.legacy) return Object.keys(decoded.values).length > 0
  return decoded.plaintext.length > 0
}

// Guarda de roundtrip da migração: os dois lados têm que bater em TUDO que o
// usuário tem gravado — valores legíveis E envelopes ilegíveis.
//
// Comparar só `values` tem um ponto cego exatamente onde o dado se perde: uma
// chave ilegível fica de fora dos dois lados, os conjuntos batem, e a chave some
// do banco sem ninguém notar.
export function sameSecrets(before: DecodedSecrets, after: DecodedSecrets): boolean {
  const sameMap = <T>(a: Record<string, T>, b: Record<string, T>, eq: (x: T, y: T) => boolean) => {
    const ka = Object.keys(a).sort()
    const kb = Object.keys(b).sort()
    return ka.length === kb.length && ka.every((k, i) => k === kb[i] && eq(a[k], b[k]))
  }
  return (
    sameMap(before.values, after.values, (x, y) => x === y) &&
    sameMap(before.preserved, after.preserved, (x, y) => JSON.stringify(x) === JSON.stringify(y))
  )
}

// Máscara de exibição: bullets de tamanho FIXO. Usar o comprimento real do
// segredo já vazaria informação sobre ele.
export const SECRET_MASK = '••••••••'
