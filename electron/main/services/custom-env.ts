import { getPref, setPref } from './prefs-store'
import {
  decodeSecrets,
  encodeSecrets,
  electronCrypto,
  needsMigration,
  sameSecrets,
  type DecodedSecrets,
  type EncryptionBackend,
  type SecretCrypto,
  type StoredSecret,
} from './secret-store'

// Variáveis de ambiente customizadas do usuário (Configurações → Variáveis de
// ambiente). Mescladas nos spawns que rodam processos externos (claude -p,
// render de vídeo) para que tokens/hosts/flags do usuário cheguem aos
// subprocessos sem precisar exportá-los no shell que abriu o app GUI.
//
// Os VALORES são segredos (chaves de API) e ficam CIFRADOS no banco — ver
// secret-store.ts. As CHAVES ficam em claro: são nomes de env var, não segredo, e
// a UI precisa delas para listar sem decifrar nada.

export const CUSTOM_ENV_VARS_KEY = 'custom_env_vars'

export type CustomEnvVars = Record<string, string>

// Sanitiza o valor lido da pref para um mapa string→string. Tolera JSON
// inválido/shape errado (a pref é editada pela UI, mas defensivo na fronteira):
// ignora chaves vazias e valores não-string.
export function sanitizeCustomEnv(raw: unknown): CustomEnvVars {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: CustomEnvVars = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const k = key.trim()
    if (!k || typeof value !== 'string') continue
    out[k] = value
  }
  return out
}

// Lê + decifra a pref no momento do uso (a pref pode mudar entre spawns; não
// cacheamos, e nada aqui persiste o texto claro).
export function decodeCustomEnv(crypto: SecretCrypto = electronCrypto): DecodedSecrets {
  return decodeSecrets(getPref<unknown>(CUSTOM_ENV_VARS_KEY, null), crypto)
}

export function readCustomEnv(): CustomEnvVars {
  return sanitizeCustomEnv(decodeCustomEnv().values)
}

// Grava o mapa inteiro já cifrado. Retorna as chaves que acabaram em claro
// (cifragem indisponível) para quem chamou poder avisar o usuário.
//
// `preserved` carrega os envelopes das chaves ilegíveis: como elas não aparecem
// em `values` (não decifraram), toda reescrita que não os repassar APAGA essas
// chaves. Quem quer de fato removê-las omite a chave daqui — é sempre explícito.
export function writeCustomEnv(
  values: CustomEnvVars,
  crypto: SecretCrypto = electronCrypto,
  preserved: Record<string, StoredSecret> = {},
): { plaintext: string[] } {
  const { stored, plaintext } = encodeSecrets(sanitizeCustomEnv(values), crypto, preserved)
  setPref(CUSTOM_ENV_VARS_KEY, stored)
  return { plaintext }
}

// Envelopes ilegíveis menos as chaves que a operação está tocando (sobrescrever
// ou apagar uma chave ilegível é intencional: o usuário mandou).
function preservedWithout(
  preserved: Record<string, StoredSecret>,
  ...keys: string[]
): Record<string, StoredSecret> {
  const next = { ...preserved }
  for (const key of keys) delete next[key]
  return next
}

export interface SecretsStatus {
  backend: EncryptionBackend
  // Chaves ainda gravadas em claro no banco.
  plaintextKeys: string[]
  // Chaves cujo ciphertext não decifra mais neste cofre.
  unreadableKeys: string[]
}

export function customEnvStatus(crypto: SecretCrypto = electronCrypto): SecretsStatus {
  const decoded = decodeCustomEnv(crypto)
  return {
    backend: crypto.backend(),
    plaintextKeys: decoded.plaintext,
    unreadableKeys: decoded.unreadable,
  }
}

export interface CustomEnvEntry {
  key: string
  hasValue: boolean
  // false ⇒ o valor está em claro no banco (a UI marca a linha).
  encrypted: boolean
  // true ⇒ existe ciphertext mas ele não decifra neste cofre.
  unreadable: boolean
}

// Lista para a UI: nomes das vars + se têm valor. NUNCA devolve o texto claro —
// a tela de configurações pede o valor de UMA chave por vez, sob ação explícita
// do usuário (revealCustomEnvVar).
export function listCustomEnvEntries(crypto: SecretCrypto = electronCrypto): CustomEnvEntry[] {
  const decoded = decodeCustomEnv(crypto)
  const plaintext = new Set(decoded.plaintext)
  const keys = [...Object.keys(decoded.values), ...decoded.unreadable].sort((a, b) =>
    a.localeCompare(b),
  )
  return keys.map((key) => ({
    key,
    hasValue: decoded.unreadable.includes(key) || Boolean(decoded.values[key]),
    encrypted: !plaintext.has(key),
    unreadable: decoded.unreadable.includes(key),
  }))
}

export function revealCustomEnvVar(
  key: string,
  crypto: SecretCrypto = electronCrypto,
): string | null {
  const value = decodeCustomEnv(crypto).values[key.trim()]
  return typeof value === 'string' ? value : null
}

export function setCustomEnvVar(
  key: string,
  value: string,
  crypto: SecretCrypto = electronCrypto,
): { plaintext: string[] } {
  const k = key.trim()
  if (!k) return { plaintext: [] }
  const decoded = decodeCustomEnv(crypto)
  return writeCustomEnv(
    { ...decoded.values, [k]: value },
    crypto,
    preservedWithout(decoded.preserved, k),
  )
}

export function deleteCustomEnvVar(
  key: string,
  crypto: SecretCrypto = electronCrypto,
): { plaintext: string[] } {
  const k = key.trim()
  const decoded = decodeCustomEnv(crypto)
  const next = { ...decoded.values }
  delete next[k]
  return writeCustomEnv(next, crypto, preservedWithout(decoded.preserved, k))
}

// Renomear preserva o valor sem que ele passe pelo renderer: o main lê, remove a
// chave antiga e regrava sob a nova. Chave nova vazia ou já existente é no-op.
export function renameCustomEnvVar(
  from: string,
  to: string,
  crypto: SecretCrypto = electronCrypto,
): { plaintext: string[] } {
  const oldKey = from.trim()
  const newKey = to.trim()
  const decoded = decodeCustomEnv(crypto)
  const current = decoded.values
  if (!newKey || newKey === oldKey || !(oldKey in current)) return { plaintext: [] }
  const next = { ...current, [newKey]: current[oldKey] }
  delete next[oldKey]
  return writeCustomEnv(next, crypto, preservedWithout(decoded.preserved, newKey))
}

export interface MigrationResult {
  migrated: number
  skipped: 'not-needed' | 'unavailable' | null
  // Chaves que continuaram em claro após a tentativa.
  plaintext: string[]
}

// Ganchos de manutenção do arquivo do banco, injetados pelo main: `beforeWrite`
// tira o backup e `afterWrite` recupera as páginas livres (o texto claro antigo
// sobrevive nelas até o VACUUM). Ficam como callback para este módulo continuar
// dependendo só de prefs — quem sabe de arquivo é db-maintenance.
export interface MigrationHooks {
  beforeWrite?: () => void
  afterWrite?: () => void
}

// Cifra na primeira execução o que estiver em claro (pref legada v1 ou valores
// gravados quando o cofre estava indisponível). Precisa rodar DEPOIS do app
// ready: antes disso safeStorage.isEncryptionAvailable() não é confiável no Linux.
//
// Garantia de não-perda: a gravação é um único INSERT OR REPLACE e é conferida
// por releitura — se o mapa relido não bater exatamente com o original (valores
// legíveis E envelopes ilegíveis), o valor bruto anterior é restaurado e nada é
// perdido.
export function migrateSecretsAtRest(
  crypto: SecretCrypto = electronCrypto,
  hooks: MigrationHooks = {},
): MigrationResult {
  const rawBefore = getPref<unknown>(CUSTOM_ENV_VARS_KEY, null)
  const decoded = decodeSecrets(rawBefore, crypto)
  if (crypto.backend() === 'unavailable') {
    return { migrated: 0, skipped: 'unavailable', plaintext: decoded.plaintext }
  }
  if (!needsMigration(decoded, crypto)) {
    return { migrated: 0, skipped: 'not-needed', plaintext: decoded.plaintext }
  }

  hooks.beforeWrite?.()

  const before = decoded.values
  const { stored, plaintext } = encodeSecrets(before, crypto, decoded.preserved)
  setPref(CUSTOM_ENV_VARS_KEY, stored)

  const after = decodeSecrets(getPref<unknown>(CUSTOM_ENV_VARS_KEY, null), crypto)
  if (!sameSecrets(decoded, after)) {
    setPref(CUSTOM_ENV_VARS_KEY, rawBefore)
    throw new Error('secret migration roundtrip failed; original value restored')
  }

  const migrated = Object.keys(before).filter((k) => before[k] && !plaintext.includes(k)).length
  hooks.afterWrite?.()
  return { migrated, skipped: null, plaintext }
}

// Redator para superfícies de log que ecoam saída de subprocesso (stderr de
// processo filho). Recebe um snapshot dos valores no momento do spawn: assim o custo de
// decifrar é pago uma vez, e não por linha de log.
export function createSecretRedactor(values: CustomEnvVars = readCustomEnv()): (
  text: string,
) => string {
  // Valores curtos ('1', 'true') são flags, não segredo — redigi-los picotaria
  // qualquer log com ruído.
  const secrets = Object.values(values)
    .filter((v) => v.length >= 8)
    .sort((a, b) => b.length - a.length)
  if (secrets.length === 0) return (text) => text
  return (text) => {
    let out = text
    for (const secret of secrets) out = out.split(secret).join('[REDACTED]')
    return out
  }
}

// Mescla as vars customizadas DEPOIS da base (process.env): o override do
// usuário tem precedência intencional. Retorna um objeto novo (imutável).
export function mergeCustomEnv(
  base: NodeJS.ProcessEnv,
  custom: CustomEnvVars,
): NodeJS.ProcessEnv {
  return { ...base, ...custom }
}

// Leitura pontual de UMA var por código que roda dentro do main (não spawna
// processo): a pref do usuário tem precedência, com fallback pro ambiente do
// processo. Valor vazio conta como ausente.
export function getEnvVar(key: string): string | undefined {
  return readCustomEnv()[key] || process.env[key] || undefined
}

// Atalho usado nos spawns: base process.env + pref custom (lida agora).
export function spawnEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return mergeCustomEnv(base, readCustomEnv())
}

export const DISABLE_AUTOCOMPACT_KEY = 'session.disableAutoCompact'

// A CLI só olha a presença da var: setar '0' desabilitaria o auto-compact do
// mesmo jeito, então quando a pref está desligada a chave é omitida.
export function withAutoCompactDisabled(
  base: NodeJS.ProcessEnv,
  disabled: boolean,
): NodeJS.ProcessEnv {
  return disabled ? { ...base, DISABLE_AUTOCOMPACT: '1' } : { ...base }
}

// Markers que a CLI usa para se reconhecer como sessão FILHA: com qualquer um
// deles setado ela desliga o transcript. O Pitwall nunca os define — mas herda
// process.env de quem abriu o app, e abrir o Pitwall de dentro de uma sessão
// Claude Code contaminava toda sessão nova em silêncio (sem transcript não há
// Chat View, `--resume` nem handoff). O ambiente do app não é o da sessão.
const CHILD_SESSION_MARKERS = ['CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SKIP_PROMPT_HISTORY']

export function stripChildSessionMarkers(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out = { ...base }
  for (const key of CHILD_SESSION_MARKERS) delete out[key]
  return out
}

// Env dos spawns de sessão (PTY do `claude`). O custom env do usuário entra por
// último e pode sobrescrever a var — inclusive remarcar a sessão como filha, se
// for isso que ele quer.
export function sessionSpawnEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const clean = stripChildSessionMarkers(base)
  const withFlag = withAutoCompactDisabled(clean, getPref<boolean>(DISABLE_AUTOCOMPACT_KEY, false))
  return mergeCustomEnv(withFlag, readCustomEnv())
}
