import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { createSecretRedactor } from './custom-env'

// Configuração do modo voz, lida de ~/.config/voz/voz.env (mesmo arquivo do app
// Voz da Lexter). O arquivo é LIDO, nunca sourceado — um .env executado por
// shell é vetor de execução de código. O parser é porte fiel de
// vozapp/config.py, incluindo os três defeitos medidos lá:
//
// 1. Comentário na mesma linha (`CHAVE=220  # explicação`) é cortado.
// 2. Valor entre aspas é preservado inteiro, inclusive `#`.
// 3. Nomes antigos continuam aceitos (ALIASES) — o STT_PROMPT já se perdeu numa
//    renomeação e "Claude Code" virou "Cloud Code" por dias.

export interface VoiceConfig {
  sttUrl: string
  sttModel: string
  sttLanguage: string
  sttPrompt: string
  sttMinSeconds: number
  ttsVoice: string
  ttsSpeed: number
  ttsModel: string
  sttKey: string
  sttKeyCmd: string
  ttsKey: string
  ttsKeyCmd: string
}

export type VoiceConfigResult = { ok: true; cfg: VoiceConfig } | { ok: false; error: string }

export type SecretResult = { ok: true; value: string } | { ok: false; error: string }

// Dependências injetáveis (teste sem tocar fs/processos reais).
export interface VoiceDeps {
  env: NodeJS.ProcessEnv
  home: string
  exists: (p: string) => boolean
  readFile: (p: string) => string
  exec: (cmd: string, env: NodeJS.ProcessEnv) => Promise<{ stdout: string; stderr: string }>
}

const execFileAsync = promisify(execFile)

function withDefaults(over: Partial<VoiceDeps>): VoiceDeps {
  return {
    env: process.env,
    home: homedir(),
    exists: existsSync,
    readFile: (p) => readFileSync(p, 'utf8'),
    exec: (cmd, env) =>
      execFileAsync('bash', ['-c', cmd], { timeout: 45_000, env }) as Promise<{
        stdout: string
        stderr: string
      }>,
    ...over,
  }
}

// nome canônico -> nomes antigos que continuam valendo
const ALIASES: Record<string, readonly string[]> = {
  VOZ_STT_PROMPT: ['STT_PROMPT'],
  VOZ_TTS_VOICE: ['TTS_VOICE'],
  VOZ_TTS_SPEED: ['TTS_SPEED'],
  VOZ_TTS_MODEL: ['TTS_MODEL'],
  VOZ_TTS_KEY: ['ELEVENLABS_API_KEY'],
}

const DEFAULTS: Record<string, string> = {
  VOZ_STT_MODELO: 'whisper',
  VOZ_STT_IDIOMA: 'pt',
  VOZ_STT_MIN_SEGUNDOS: '0.4',
  VOZ_TTS_VOICE: '33B4UnXyTNbgLmdEDh5P', // Keren
  VOZ_TTS_SPEED: '2.0',
  VOZ_TTS_MODEL: 'eleven_flash_v2_5',
}

// Porte de config.py:_parse — só `CHAVE=valor` e comentários.
export function parseVozEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const raw of text.split('\n')) {
    let line = raw.trim()
    if (!line || line.startsWith('#') || !line.includes('=')) continue
    if (line.startsWith('export ')) line = line.slice('export '.length).trimStart()
    const eq = line.indexOf('=')
    const key = line.slice(0, eq).trim()
    if (!key || !/^[A-Za-z_]/.test(key)) continue
    const value = line.slice(eq + 1).trim()
    const quote = value.slice(0, 1)
    if (quote === "'" || quote === '"') {
      const close = value.indexOf(quote, 1)
      out[key] = close > 0 ? value.slice(1, close) : value.slice(1)
    } else {
      out[key] = value.split('#')[0].trim()
    }
  }
  return out
}

// Precedência (porte de config.py:conf): ambiente > arquivo > alias no
// ambiente > alias no arquivo > padrão. O ambiente vem primeiro para que teste
// e e2e possam isolar sem tocar no arquivo do usuário.
function lookup(name: string, vars: Record<string, string>, env: NodeJS.ProcessEnv): string {
  if (env[name] !== undefined) return env[name]
  if (vars[name] !== undefined) return vars[name]
  for (const old of ALIASES[name] ?? []) {
    if (env[old] !== undefined) return env[old]
    if (vars[old] !== undefined) return vars[old]
  }
  return DEFAULTS[name] ?? ''
}

// Semântica de conf_float: valor não-numérico (ou vazio) cai no padrão.
function toNumber(value: string, fallback: number): number {
  const trimmed = value.trim()
  const n = Number(trimmed)
  return trimmed !== '' && Number.isFinite(n) ? n : fallback
}

export function vozEnvPath(deps: Partial<VoiceDeps> = {}): string {
  const d = withDefaults(deps)
  const base = d.env.XDG_CONFIG_HOME || join(d.home, '.config')
  return join(base, 'voz', 'voz.env')
}

// null = arquivo não existe; {} = existe mas ilegível (mesma semântica do
// OSError → {} em config.py: cai nos erros de campo, não no de arquivo ausente).
function readVozVars(path: string, d: VoiceDeps): Record<string, string> | null {
  if (!d.exists(path)) return null
  try {
    return parseVozEnv(d.readFile(path))
  } catch {
    return {}
  }
}

export function getVoiceConfig(deps: Partial<VoiceDeps> = {}): VoiceConfigResult {
  const d = withDefaults(deps)
  const path = vozEnvPath(d)
  const fileVars = readVozVars(path, d)
  // Arquivo ausente só é fatal sem VOZ_STT_URL no ambiente (e2e aponta a URL
  // pro fake server por env, sem criar arquivo).
  if (fileVars === null && !d.env.VOZ_STT_URL) {
    return {
      ok: false,
      error: `Configuração de voz não encontrada: ${path}. Crie o arquivo a partir do voz.env.example do repo Voz.`,
    }
  }
  const vars = fileVars ?? {}
  const sttUrl = lookup('VOZ_STT_URL', vars, d.env)
  if (!sttUrl) {
    return {
      ok: false,
      error: `VOZ_STT_URL ausente em ${path} — defina a URL do serviço de transcrição.`,
    }
  }
  return {
    ok: true,
    cfg: {
      sttUrl,
      sttModel: lookup('VOZ_STT_MODELO', vars, d.env),
      sttLanguage: lookup('VOZ_STT_IDIOMA', vars, d.env),
      sttPrompt: lookup('VOZ_STT_PROMPT', vars, d.env),
      sttMinSeconds: toNumber(lookup('VOZ_STT_MIN_SEGUNDOS', vars, d.env), 0.4),
      ttsVoice: lookup('VOZ_TTS_VOICE', vars, d.env),
      ttsSpeed: toNumber(lookup('VOZ_TTS_SPEED', vars, d.env), 2.0),
      ttsModel: lookup('VOZ_TTS_MODEL', vars, d.env),
      sttKey: lookup('VOZ_STT_KEY', vars, d.env),
      sttKeyCmd: lookup('VOZ_STT_KEY_CMD', vars, d.env),
      ttsKey: lookup('VOZ_TTS_KEY', vars, d.env),
      ttsKeyCmd: lookup('VOZ_TTS_KEY_CMD', vars, d.env),
    },
  }
}

// Onde o instalador oficial deixa o gcloud. O app GUI sobe sem .bashrc (é onde
// o SDK injeta o PATH), então `bash -c` não acharia o gcloud sem isto — defeito
// medido no Voz (config.py:path_com_gcloud).
function envWithGcloudPath(d: VoiceDeps): NodeJS.ProcessEnv {
  const dirs = [
    join(d.home, 'google-cloud-sdk', 'bin'),
    join(d.home, '.local', 'google-cloud-sdk', 'bin'),
    '/usr/lib/google-cloud-sdk/bin',
    '/snap/bin',
  ]
  const extras = dirs.filter((dir) => d.exists(join(dir, 'gcloud')))
  if (extras.length === 0) return { ...d.env }
  return { ...d.env, PATH: [...extras, d.env.PATH ?? ''].join(':') }
}

// Cache em memória pelo tempo de vida do processo: a busca no cofre custa ~1s
// e o ditado não pode pagar isso a cada uso. Só sucesso entra no cache.
const secretCache = new Map<string, string>()

// Valores resolvidos, para o redator de log nunca ecoar uma chave.
const resolvedSecrets: Record<string, string> = {}

// Resolve uma credencial por valor direto (VOZ_STT_KEY) OU por comando
// (<nome>_CMD). A forma preferida é o comando: nenhuma chave fica em repouso no
// laptop; ela é buscada no cofre com a identidade da própria pessoa.
export async function resolveSecret(
  name: string,
  deps: Partial<VoiceDeps> = {},
): Promise<SecretResult> {
  const cached = secretCache.get(name)
  if (cached !== undefined) return { ok: true, value: cached }

  const d = withDefaults(deps)
  const vars = readVozVars(vozEnvPath(d), d) ?? {}
  const direct = lookup(name, vars, d.env)
  if (direct) return remember(name, direct)

  const cmd = lookup(`${name}_CMD`, vars, d.env)
  if (!cmd) {
    return {
      ok: false,
      error: `Credencial ${name} não configurada — defina ${name} ou ${name}_CMD no voz.env.`,
    }
  }
  try {
    const { stdout, stderr } = await d.exec(cmd, envWithGcloudPath(d))
    const value = stdout.trim()
    if (!value) {
      const motivo = stderr.trim() || 'o comando da credencial saiu vazio'
      return cmdFailed(name, cmd, motivo, d)
    }
    return remember(name, value)
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr?.trim()
    const motivo = stderr || (err instanceof Error ? err.message : String(err))
    return cmdFailed(name, cmd, motivo, d)
  }
}

// Comando da credencial falhou/saiu vazio. Porte de config.py:segredo (~217-226):
// se o comando usa gcloud, o login interativo pode ter vencido — tenta de novo
// com o token da credencial de aplicativo (ADC), que costuma continuar válida
// (medido no Voz: o cofre respondeu 0 com ela e 1 com o login vencido).
async function cmdFailed(
  name: string,
  cmd: string,
  motivo: string,
  d: VoiceDeps,
): Promise<SecretResult> {
  if (!cmd.includes('gcloud')) {
    return { ok: false, error: `Falha ao obter a credencial ${name}: ${motivo}` }
  }
  const token = await adcToken(d)
  if (token) {
    try {
      const { stdout } = await d.exec(cmd, {
        ...envWithGcloudPath(d),
        CLOUDSDK_AUTH_ACCESS_TOKEN: token,
      })
      const value = stdout.trim()
      if (value) return remember(name, value)
    } catch {
      // cai na mensagem de login abaixo
    }
  }
  return {
    ok: false,
    error:
      `Falha ao obter a credencial ${name}: ${motivo} — a sessão do gcloud ` +
      'provavelmente venceu; rode `gcloud auth login` e tente de novo.',
  }
}

// Porte de config.py:_token_adc — token da credencial de aplicativo do gcloud.
async function adcToken(d: VoiceDeps): Promise<string> {
  try {
    const { stdout } = await d.exec(
      'gcloud auth application-default print-access-token',
      envWithGcloudPath(d),
    )
    return stdout.trim()
  } catch {
    return ''
  }
}

function remember(name: string, value: string): SecretResult {
  secretCache.set(name, value)
  resolvedSecrets[name] = value
  return { ok: true, value }
}

// Redator para superfícies de log dos serviços de voz — mesmo padrão do
// createSecretRedactor de custom-env: snapshot no momento da chamada.
export function voiceSecretRedactor(): (text: string) => string {
  return createSecretRedactor({ ...resolvedSecrets })
}

export function clearVoiceSecrets(): void {
  secretCache.clear()
  for (const key of Object.keys(resolvedSecrets)) delete resolvedSecrets[key]
}
