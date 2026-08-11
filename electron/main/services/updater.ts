import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import electronUpdater from 'electron-updater'
import type { GithubAsset, UpdateFormat, UpdateStatus } from '../../../shared/types/ipc'

const { autoUpdater } = electronUpdater
const execFileAsync = promisify(execFile)

const PKEXEC_PATH = '/usr/bin/pkexec'

const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000
const FOCUS_THROTTLE_MS = 60 * 1000
const RELEASE_API = 'https://api.github.com/repos/ThiagoEMatumoto/pitwall/releases/latest'
const RELEASE_PAGE = 'https://github.com/ThiagoEMatumoto/pitwall/releases/latest'

interface GithubRelease {
  tag_name: string
  assets: GithubAsset[]
}

type UpdateTarget = { format: UpdateFormat; mode: 'native' | 'assisted'; ext?: string }

// Deriva o alvo de atualização da plataforma corrente:
// - native  = electron-updater faz tudo (download in-place + quitAndInstall).
// - assisted = baixa o instalador e abre; o usuário conclui manualmente.
function resolveUpdateTarget(): UpdateTarget {
  if (process.platform === 'win32') return { format: 'nsis', mode: 'native' }
  if (process.platform === 'darwin') return { format: 'dmg', mode: 'assisted', ext: '.dmg' }
  if (process.env.APPIMAGE) return { format: 'appimage', mode: 'native' }
  return { format: 'deb', mode: 'assisted', ext: '.deb' }
}

const updateTarget = resolveUpdateTarget()
const currentFormat: UpdateFormat = updateTarget.format

let latestRelease: GithubRelease | null = null
let lastFocusCheck = 0
// Sinaliza que um .deb foi instalado in-place via pkexec e o 'updates:install'
// deve fazer relaunch+quit (em vez do quitAndInstall do electron-updater).
let debInstalled = false

function broadcast(status: UpdateStatus): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('update:status', status)
  }
}

// Append-only log persistente do fluxo de update. Sobrevive a reinícios e
// permite diagnosticar falhas do pkexec/apt-get depois do fato (o stderr do
// apt some quando o app fecha).
function updaterLog(event: string, detail?: string): void {
  try {
    const file = join(app.getPath('userData'), 'logs', 'updater.log')
    mkdirSync(dirname(file), { recursive: true })
    const line = `${new Date().toISOString()} [${event}]${detail ? ` ${detail}` : ''}\n`
    appendFileSync(file, line)
  } catch {
    // logging best-effort: nunca derrubar o update por falha de escrita do log.
  }
}

// Mantém só as últimas N linhas não-vazias de uma saída (stderr do apt costuma
// ser verboso); usado tanto pro log quanto pra mensagem amigável de erro.
function tailLines(text: string, n: number): string {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(-n)
    .join(' ')
}

// Compara X.Y.Z numericamente. Retorna true se `latest` > `current`.
function isNewer(latest: string, current: string): boolean {
  const a = latest.split('.').map((n) => parseInt(n, 10) || 0)
  const b = current.split('.').map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < 3; i++) {
    const da = a[i] ?? 0
    const db = b[i] ?? 0
    if (da !== db) return da > db
  }
  return false
}

async function checkForUpdate(): Promise<void> {
  try {
    const res = await fetch(RELEASE_API, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'pitwall',
      },
    })
    if (!res.ok) return

    const release = (await res.json()) as GithubRelease
    const latestVersion = release.tag_name.replace(/^v/, '')

    if (!isNewer(latestVersion, app.getVersion())) return

    latestRelease = release
    // Só o broadcast: o UpdateToast já mostra "atualização vX disponível /
    // Atualizar". Disparar notify aqui criava um 2º toast empilhado pro MESMO
    // evento.
    broadcast({ state: 'available', version: latestVersion, format: currentFormat })
  } catch {
    // rede indisponível / API fora — silencioso, tentamos de novo no próximo ciclo.
  }
}

// Baixa o asset inteiro em memória e grava de forma atômica em disco. Usamos
// arrayBuffer (98MB cabe folgado) em vez de stream `on('data')`+`pipe` porque o
// esquema anterior produzia o arquivo com TAMANHO correto mas BYTES corrompidos
// (consumir os dados em dois caminhos — o listener de progresso e o pipe — abria
// margem pra corrupção). arrayBuffer entrega os bytes exatos da resposta.
async function downloadAssetToFile(url: string, destPath: string): Promise<void> {
  const res = await fetch(url, { headers: { 'User-Agent': 'pitwall' } })
  if (!res.ok) throw new Error(`download falhou: HTTP ${res.status}`)
  // Progresso indeterminado: o download é uma compra única em memória.
  broadcast({ state: 'downloading', percent: 0 })
  const buf = Buffer.from(await res.arrayBuffer())
  writeFileSync(destPath, buf)
  broadcast({ state: 'downloading', percent: 100 })
}

// sha512 do arquivo em base64 — mesmo formato do `latest-linux.yml` (electron-updater).
function sha512Base64(filePath: string): string {
  return createHash('sha512').update(readFileSync(filePath)).digest('base64')
}

// Lê o sha512 esperado do manifest `latest-linux.yml` da release. O manifest é um
// YAML plano (files: [{ url, sha512, size }]); fazemos parse via regex em vez de
// depender de uma lib de YAML transitiva. Retorna null se o manifest ou a entrada
// do .deb não forem encontrados (nesse caso seguimos sem verificação — fail-open
// só na AUSÊNCIA do dado, nunca no mismatch).
async function fetchExpectedSha512(debName: string): Promise<string | null> {
  const manifest = latestRelease?.assets.find((a) => a.name === 'latest-linux.yml')
  if (!manifest) return null
  try {
    const res = await fetch(manifest.browser_download_url, {
      headers: { 'User-Agent': 'pitwall' },
    })
    if (!res.ok) return null
    const text = await res.text()
    return parseSha512FromManifest(text, debName)
  } catch {
    return null
  }
}

// Extrai o sha512 do arquivo cujo `url` bate com `debName`. O bloco no yml é:
//   - url: pitwall_0.6.4_amd64.deb
//     sha512: <base64>
//     size: 97957504
export function parseSha512FromManifest(yml: string, debName: string): string | null {
  const lines = yml.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const urlMatch = lines[i].match(/url:\s*(\S+)/)
    if (!urlMatch || urlMatch[1] !== debName) continue
    // sha512 costuma vir na linha seguinte, mas varremos algumas pra robustez.
    for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
      // Para no próximo item da lista pra não pegar o sha512 de outro arquivo.
      if (/^\s*-\s/.test(lines[j])) break
      const shaMatch = lines[j].match(/sha512:\s*(\S+)/)
      if (shaMatch) return shaMatch[1]
    }
  }
  return null
}

async function applyAssistedUpdate(ext: string): Promise<void> {
  const asset = latestRelease?.assets.find((a) => a.name.endsWith(ext))
  if (!asset) {
    broadcast({ state: 'error', message: 'Nenhum instalador encontrado na release.' })
    return
  }

  try {
    const destPath = join(app.getPath('downloads'), asset.name)
    const version = latestRelease?.tag_name.replace(/^v/, '') ?? app.getVersion()
    const verifyChecksum = currentFormat === 'deb'

    const expected = verifyChecksum ? await fetchExpectedSha512(asset.name) : null
    if (verifyChecksum && !expected) {
      // Sem manifest/sha512 disponível: seguimos (não bloqueia em release antiga
      // sem latest-linux.yml), mas registramos pra diagnóstico.
      updaterLog('verify:skip', `no sha512 for ${asset.name} in latest-linux.yml`)
    }

    // Tenta baixar (e, se houver sha512 esperado, verificar). Em mismatch,
    // re-baixa 1 vez. NUNCA instala um arquivo que falha no checksum.
    let verified = false
    for (let attempt = 1; attempt <= 2; attempt++) {
      await downloadAssetToFile(asset.browser_download_url, destPath)

      if (!expected) {
        verified = true
        break
      }

      const actual = sha512Base64(destPath)
      if (actual === expected) {
        updaterLog('verify:ok', `${asset.name} attempt=${attempt}`)
        verified = true
        break
      }

      updaterLog(
        'verify:mismatch',
        `${asset.name} attempt=${attempt} expected=${expected} actual=${actual}`,
      )
      // Remove o arquivo corrompido antes de re-tentar / desistir.
      try {
        rmSync(destPath, { force: true })
      } catch {
        // best-effort.
      }
    }

    if (!verified) {
      updaterLog('verify:failed', `${asset.name} download corrompido após 2 tentativas`)
      broadcast({
        state: 'error',
        message: 'Download corrompido (checksum não confere). Tente novamente.',
      })
      return
    }

    if (currentFormat === 'deb' && existsSync(PKEXEC_PATH)) {
      await installDebWithPkexec(destPath, version)
      return
    }

    await shell.openPath(destPath)
    broadcast({ state: 'awaiting-install', version })
  } catch (err) {
    broadcast({ state: 'error', message: err instanceof Error ? err.message : 'Erro ao baixar.' })
  }
}

// Instala o .deb in-place via prompt gráfico de senha do polkit.
// `apt-get install <path>` resolve dependências e faz upgrade.
// - `env DEBIAN_FRONTEND=noninteractive`: pkexec roda /usr/bin/env, que então
//   exec'a o apt-get com a env setada — evita prompt de conffile (sem tty).
// - `-o DPkg::Lock::Timeout=120`: aguarda até 120s pelo lock do dpkg em vez de
//   falhar na hora (contenção comum com unattended-upgrades).
// Tratamento de saída:
// - exit 126/127 = pkexec (prompt cancelado / não autorizado) → NÃO é erro de
//   instalação: volta pro estado disponível, sem abrir a Central.
// - outro exit≠0 = erro do apt-get → estado de erro com as últimas linhas do
//   stderr (mensagem amigável se for lock). Nunca abre a Central (inútil aqui).
async function installDebWithPkexec(destPath: string, version: string): Promise<void> {
  broadcast({ state: 'installing', version })
  updaterLog('install:start', `version=${version} path=${destPath}`)
  try {
    await execFileAsync(
      PKEXEC_PATH,
      [
        'env',
        'DEBIAN_FRONTEND=noninteractive',
        'apt-get',
        '-o',
        'DPkg::Lock::Timeout=120',
        'install',
        '-y',
        destPath,
      ],
      { timeout: 5 * 60 * 1000 },
    )
    debInstalled = true
    updaterLog('install:success', `version=${version}`)
    broadcast({ state: 'installed', version })
  } catch (err) {
    const e = err as { code?: number | string; stdout?: string; stderr?: string }
    const stderr = e.stderr ?? ''
    const stdout = e.stdout ?? ''
    const code = e.code

    // pkexec: 126 = não autorizado / dismissed, 127 = autenticação cancelada.
    if (code === 126 || code === 127) {
      updaterLog('install:cancelled', `code=${code}`)
      broadcast({ state: 'available', version, format: currentFormat })
      return
    }

    const tail = tailLines(stderr || stdout, 4)
    // O erro real do dpkg/lzma costuma sair no STDOUT do apt-get (não no stderr).
    // Logamos os dois pra diagnosticar corrupção de pacote depois do fato.
    updaterLog(
      'install:error',
      `code=${code} stdout=${tailLines(stdout, 6)} stderr=${tailLines(stderr, 6)}`,
    )

    const message = /could not get lock|dpkg.*lock|lock-frontend/i.test(stderr)
      ? 'Não foi possível instalar agora: o gerenciador de pacotes está ocupado (atualizações automáticas). Tente novamente em instantes.'
      : tail || 'Falha ao instalar o pacote.'

    broadcast({ state: 'error', message })
  }
}

export function initUpdater(): void {
  // Em dev não há artefato publicado nem APPIMAGE; o autoUpdater quebraria ao buscar feed.
  if (!app.isPackaged) return

  autoUpdater.autoDownload = true

  autoUpdater.on('download-progress', (progress) => {
    broadcast({ state: 'downloading', percent: Math.round(progress.percent) })
  })
  autoUpdater.on('update-downloaded', (info) => {
    broadcast({ state: 'downloaded', version: info.version })
  })
  autoUpdater.on('error', (err) => {
    broadcast({ state: 'error', message: err.message })
  })

  // Roteia por modo: native (nsis/appimage) delega ao electron-updater (download +
  // quitAndInstall); assisted (deb/dmg) baixa manualmente e abre o instalador gráfico,
  // pois o electron-updater não suporta auto-install desses formatos.
  ipcMain.handle('updates:apply', async () => {
    if (updateTarget.mode === 'native') {
      void autoUpdater.checkForUpdates()
      return
    }
    await applyAssistedUpdate(updateTarget.ext ?? '')
  })

  ipcMain.handle('updates:install', () => {
    // deb já foi instalado in-place via pkexec: só relança o app na versão nova.
    if (debInstalled) {
      app.relaunch()
      app.quit()
      return
    }
    autoUpdater.quitAndInstall()
  })

  ipcMain.handle('updates:open-release', () => shell.openExternal(RELEASE_PAGE))

  ipcMain.handle('updates:open-downloads', () => shell.openPath(app.getPath('downloads')))

  void checkForUpdate()
  setInterval(() => void checkForUpdate(), CHECK_INTERVAL_MS)

  app.on('browser-window-focus', () => {
    const now = Date.now()
    if (now - lastFocusCheck < FOCUS_THROTTLE_MS) return
    lastFocusCheck = now
    void checkForUpdate()
  })
}
