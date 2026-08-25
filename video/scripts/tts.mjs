#!/usr/bin/env node
// Sintese das narracoes do roteiro (content/script.json) via ElevenLabs.
//
// Custa dinheiro por caractere, entao o default e DRY-RUN: sem `--go` o script
// so imprime o plano. E idempotente por sha256(text + voiceId + modelId): cena
// cujo hash bate com o manifesto e cujo mp3 existe no disco nao e regerada.
//
// Uso:
//   node scripts/tts.mjs                      plano de tudo, sem gastar
//   node scripts/tts.mjs --locale=pt-BR       plano so do pt-BR
//   node scripts/tts.mjs --locale=all --go    sintetiza de verdade
//   node scripts/tts.mjs --manifest-only      reescreve o manifesto do estado do disco
//   node scripts/tts.mjs --check-key          so prova que a credencial resolve

import {execFile} from 'node:child_process'
import {createHash} from 'node:crypto'
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs'
import {homedir} from 'node:os'
import {dirname, join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {promisify} from 'node:util'

const execFileAsync = promisify(execFile)

const VIDEO_DIR = dirname(dirname(fileURLToPath(import.meta.url)))
const SCRIPT_PATH = join(VIDEO_DIR, 'content', 'script.json')
const MANIFEST_PATH = join(VIDEO_DIR, 'content', 'audio-manifest.json')
const PUBLIC_DIR = join(VIDEO_DIR, 'public')

// Respiro antes e depois da narracao, em segundos. Preservados entre execucoes
// quando ja ajustados a mao num manifesto real (ver readPreviousEntries).
const PAD_START_SEC = 0.25
const PAD_END_SEC = 0.6

const TTS_TIMEOUT_MS = 180_000

// ---------------------------------------------------------------- credencial
// Porte de electron/main/services/voice-config.ts. A chave nesta maquina vem de
// VOZ_TTS_KEY_CMD (comando que busca no cofre), nao de um valor em repouso —
// entao o suporte a *_KEY_CMD nao e opcional.

// Porte fiel de shared/dotenv-parse.ts (o .env e LIDO, nunca sourceado).
function parseDotenv(text) {
  const out = {}
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

const ALIASES = {
  VOZ_TTS_KEY: ['ELEVENLABS_API_KEY'],
  VOZ_TTS_KEY_CMD: ['ELEVENLABS_API_KEY_CMD'],
}

function vozEnvPath() {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), '.config')
  return join(base, 'voz', 'voz.env')
}

function readVozVars() {
  const path = vozEnvPath()
  if (!existsSync(path)) return {}
  try {
    return parseDotenv(readFileSync(path, 'utf8'))
  } catch {
    return {}
  }
}

// Precedencia do app: ambiente > arquivo > alias no ambiente > alias no arquivo.
function lookup(name, vars) {
  if (process.env[name] !== undefined) return process.env[name]
  if (vars[name] !== undefined) return vars[name]
  for (const old of ALIASES[name] ?? []) {
    if (process.env[old] !== undefined) return process.env[old]
    if (vars[old] !== undefined) return vars[old]
  }
  return ''
}

// O app GUI (e um script rodado fora do shell de login) sobe sem o PATH que o
// SDK injeta no .bashrc, entao `bash -c` nao acharia o gcloud sem isto.
function envWithGcloudPath() {
  const dirs = [
    join(homedir(), 'google-cloud-sdk', 'bin'),
    join(homedir(), '.local', 'google-cloud-sdk', 'bin'),
    '/usr/lib/google-cloud-sdk/bin',
    '/snap/bin',
  ]
  const extras = dirs.filter((dir) => existsSync(join(dir, 'gcloud')))
  if (extras.length === 0) return {...process.env}
  return {...process.env, PATH: [...extras, process.env.PATH ?? ''].join(':')}
}

const runShell = (cmd, env) =>
  execFileAsync('bash', ['-c', cmd], {timeout: 45_000, env, maxBuffer: 4 * 1024 * 1024})

async function adcToken() {
  try {
    const {stdout} = await runShell(
      'gcloud auth application-default print-access-token',
      envWithGcloudPath(),
    )
    return stdout.trim()
  } catch {
    return ''
  }
}

// Valor direto (VOZ_TTS_KEY / ELEVENLABS_API_KEY) ou comando (*_KEY_CMD).
async function resolveElevenLabsKey() {
  const vars = readVozVars()
  const direct = lookup('VOZ_TTS_KEY', vars)
  if (direct) return {ok: true, value: direct, source: 'valor direto'}

  const cmd = lookup('VOZ_TTS_KEY_CMD', vars)
  if (!cmd) {
    return {
      ok: false,
      error: `Credencial nao configurada — defina ELEVENLABS_API_KEY no ambiente ou VOZ_TTS_KEY / VOZ_TTS_KEY_CMD em ${vozEnvPath()}.`,
    }
  }

  let motivo = ''
  try {
    const {stdout, stderr} = await runShell(cmd, envWithGcloudPath())
    const value = stdout.trim()
    if (value) return {ok: true, value, source: 'VOZ_TTS_KEY_CMD'}
    motivo = stderr.trim() || 'o comando da credencial saiu vazio'
  } catch (err) {
    motivo = err.stderr?.trim() || err.message || String(err)
  }

  // Login interativo do gcloud pode ter vencido; a credencial de aplicativo
  // (ADC) costuma continuar valida. Mesma segunda tentativa do app.
  if (cmd.includes('gcloud')) {
    const token = await adcToken()
    if (token) {
      try {
        const {stdout} = await runShell(cmd, {
          ...envWithGcloudPath(),
          CLOUDSDK_AUTH_ACCESS_TOKEN: token,
        })
        const value = stdout.trim()
        if (value) return {ok: true, value, source: 'VOZ_TTS_KEY_CMD (via ADC)'}
      } catch {
        // cai na mensagem abaixo
      }
    }
    return {
      ok: false,
      error: `Falha ao obter a credencial: ${motivo} — a sessao do gcloud provavelmente venceu; rode \`gcloud auth login\` e tente de novo.`,
    }
  }
  return {ok: false, error: `Falha ao obter a credencial: ${motivo}`}
}

// ---------------------------------------------------------------------- sintese
// Mesmo endpoint/headers de electron/main/services/voice-tts.ts; so o model_id
// vem do script.json em vez do voz.env.
async function synthesize(text, voiceId, modelId, key) {
  const url =
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream` +
    '?output_format=mp3_44100_128'

  let res
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {'xi-api-key': key, 'Content-Type': 'application/json'},
      body: JSON.stringify({text, model_id: modelId}),
      signal: AbortSignal.timeout(TTS_TIMEOUT_MS),
    })
  } catch (err) {
    throw new Error(`nao consegui chamar o servico de voz (rede ou tempo esgotado): ${err.message}`)
  }

  if (res.status === 401 || res.status === 403) {
    throw new Error('a credencial foi recusada (HTTP ' + res.status + ')')
  }
  if (res.status !== 200) {
    const pista = (await res.text().catch(() => '')).slice(0, 160)
    throw new Error(`o servico de voz respondeu HTTP ${res.status}${pista ? ': ' + pista : ''}`)
  }

  const bytes = Buffer.from(await res.arrayBuffer())
  if (bytes.length === 0) throw new Error('o servico de voz devolveu um arquivo vazio')
  return bytes
}

async function probeDurationSec(absPath) {
  const {stdout} = await execFileAsync('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'csv=p=0',
    absPath,
  ])
  const seconds = Number(stdout.trim())
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(`ffprobe nao devolveu duracao valida para ${absPath}: ${stdout.trim()}`)
  }
  return seconds
}

// ---------------------------------------------------------------------- plano
const textHashOf = (text, voiceId, modelId) =>
  createHash('sha256').update(text + voiceId + modelId).digest('hex')

const round3 = (n) => Number(n.toFixed(3))

// Entradas da execucao anterior, indexadas por `${locale}/${id}`. Um manifesto
// ainda marcado como stub carrega duracoes-alvo do roteiro, nao do audio: e
// descartado para nao propagar pads e hashes que nunca existiram.
function readPreviousEntries() {
  if (!existsSync(MANIFEST_PATH)) return new Map()
  let prev
  try {
    prev = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'))
  } catch {
    return new Map()
  }
  if (prev.stub === true || !prev.locales) return new Map()
  const map = new Map()
  for (const [locale, entry] of Object.entries(prev.locales)) {
    for (const scene of entry.scenes ?? []) map.set(`${locale}/${scene.id}`, scene)
  }
  return map
}

function buildPlan(script, locales, previous) {
  const modelId = script.tts.modelId
  const plan = []
  for (const locale of locales) {
    const voice = script.tts.voices[locale]
    if (!voice) throw new Error(`script.json nao tem voz configurada para o locale ${locale}`)
    for (const scene of script.scenes) {
      const text = scene.narration[locale]
      if (!text) throw new Error(`cena ${scene.id} nao tem narracao para ${locale}`)
      const hash = textHashOf(text, voice.voiceId, modelId)
      const file = `audio/${locale}/${scene.id}.mp3`
      const absPath = join(PUBLIC_DIR, file)
      const onDisk = existsSync(absPath)
      const prev = previous.get(`${locale}/${scene.id}`)
      plan.push({
        locale,
        id: scene.id,
        text,
        chars: text.length,
        voiceId: voice.voiceId,
        voiceName: voice.name,
        modelId,
        hash,
        file,
        absPath,
        onDisk,
        targetSec: scene.targetSec,
        padStartSec: prev?.padStartSec ?? PAD_START_SEC,
        padEndSec: prev?.padEndSec ?? PAD_END_SEC,
        cached: prev?.textHash === hash && onDisk,
      })
    }
  }
  return plan
}

function printPlan(plan, locales, go) {
  const header = go ? 'Plano de sintese (--go: VAI CHAMAR A API)' : 'Plano de sintese (DRY-RUN — nenhuma chamada a API)'
  console.log(header)
  let billed = 0
  for (const locale of locales) {
    const rows = plan.filter((p) => p.locale === locale)
    const voice = rows[0]
    console.log(
      `\n  ${locale}  voz ${voice.voiceId} (${voice.voiceName})  modelo ${voice.modelId}`,
    )
    for (const row of rows) {
      const mark = row.cached ? 'cache ' : 'GERAR '
      console.log(
        `    ${mark} ${row.id.padEnd(12)} ${String(row.chars).padStart(4)} chars  ${row.cached ? '(hash bate, mp3 no disco)' : row.onDisk ? '(mp3 no disco, hash mudou)' : '(sem mp3)'}`,
      )
    }
    const toGenerate = rows.filter((r) => !r.cached)
    const localeChars = toGenerate.reduce((sum, r) => sum + r.chars, 0)
    billed += localeChars
    console.log(
      `    subtotal: ${rows.length} cenas, ${toGenerate.length} a gerar, ${localeChars} caracteres cobrados` +
        ` (${rows.reduce((s, r) => s + r.chars, 0)} no roteiro inteiro)`,
    )
  }
  console.log(`\n  CUSTO: ${billed} caracteres serao enviados ao ElevenLabs.`)
  if (!go) console.log('  Nada foi gerado. Repita com --go para sintetizar.')
  return billed
}

// ------------------------------------------------------------------ manifesto
// Todos os locales entram sempre — `--locale` limita a GERACAO, nao o manifesto,
// para nunca apagar as entradas do locale que nao foi processado nesta rodada.
async function writeManifest(script, previous) {
  const allLocales = script.locales
  const full = buildPlan(script, allLocales, previous)
  const locales = {}
  for (const locale of allLocales) {
    const scenes = []
    for (const row of full.filter((r) => r.locale === locale)) {
      // Sem mp3 no disco a cena e "pendente": duracao cai no alvo do roteiro e
      // o hash fica nulo, o que forca a sintese na proxima rodada com --go.
      const durationSec = row.onDisk ? await probeDurationSec(row.absPath) : row.targetSec
      scenes.push({
        id: row.id,
        textHash: row.onDisk ? row.hash : null,
        voiceId: row.voiceId,
        modelId: row.modelId,
        file: row.onDisk ? row.file : null,
        durationSec: round3(durationSec),
        padStartSec: row.padStartSec,
        padEndSec: row.padEndSec,
      })
    }
    locales[locale] = {scenes}
  }
  const manifest = {version: 1, fps: script.fps, locales}
  writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n')
  return manifest
}

// ----------------------------------------------------------------------- main
function parseArgs(argv) {
  const flag = (name) => argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`))
  const value = (name, fallback) => {
    const found = flag(name)
    if (!found) return fallback
    const eq = found.indexOf('=')
    return eq === -1 ? fallback : found.slice(eq + 1)
  }
  return {
    locale: value('locale', 'all'),
    go: Boolean(flag('go')),
    manifestOnly: Boolean(flag('manifest-only')),
    checkKey: Boolean(flag('check-key')),
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const script = JSON.parse(readFileSync(SCRIPT_PATH, 'utf8'))

  const locales = args.locale === 'all' ? script.locales : [args.locale]
  for (const locale of locales) {
    if (!script.locales.includes(locale)) {
      console.error(`locale desconhecido: ${locale} (disponiveis: ${script.locales.join(', ')}, all)`)
      process.exit(1)
    }
  }

  // Pre-voo da credencial: resolver o *_KEY_CMD custa ~1s e uma ida ao cofre,
  // mas descobrir que ele falhou no meio de uma sintese ja paga e pior.
  if (args.checkKey) {
    const key = await resolveElevenLabsKey()
    if (!key.ok) {
      console.error(key.error)
      process.exit(1)
    }
    console.log(`credencial OK — origem: ${key.source}, ${key.value.length} caracteres.`)
    return
  }

  const previous = readPreviousEntries()

  if (args.manifestOnly) {
    await writeManifest(script, previous)
    console.log(`manifesto reescrito do estado do disco: ${MANIFEST_PATH}`)
    return
  }

  const plan = buildPlan(script, locales, previous)
  printPlan(plan, locales, args.go)
  if (!args.go) return

  const key = await resolveElevenLabsKey()
  if (!key.ok) {
    console.error(`\n${key.error}`)
    process.exit(1)
  }
  console.log(`\ncredencial obtida (${key.source}); sintetizando...`)

  for (const row of plan) {
    if (row.cached) {
      console.log(`  cache  ${row.locale}/${row.id}`)
      continue
    }
    mkdirSync(dirname(row.absPath), {recursive: true})
    const bytes = await synthesize(row.text, row.voiceId, row.modelId, key.value)
    writeFileSync(row.absPath, bytes)
    const seconds = await probeDurationSec(row.absPath)
    console.log(`  ok     ${row.locale}/${row.id}  ${(bytes.length / 1024).toFixed(0)} KB  ${seconds.toFixed(2)}s`)
  }

  await writeManifest(script, readPreviousEntries())
  console.log(`\nmanifesto atualizado: ${MANIFEST_PATH}`)
}

main().catch((err) => {
  console.error(err.message)
  process.exit(1)
})
