// PRIMEIRO import de propósito: o efeito no import migra ~/.config/claude-manager
// para ~/.config/pitwall, e ESM avalia imports na ordem de declaração — se ele
// vier depois de qualquer módulo que puxe ./services/db, o banco já foi aberto
// (vazio) no perfil novo e a migração viraria no-op.
import './services/userdata-migrate'
import { app, BrowserWindow, Menu, powerMonitor, shell } from 'electron'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { getDb, closeDb } from './services/db'
import { ptyManager } from './services/pty-manager'
import * as handoffStore from './services/handoff-store'
import {
  sessionActivityService,
  setSessionGoneHook,
  setTurnEndedHook,
} from './services/session-activity'
import { registerProjectIpc } from './ipc/projects'
import { registerSessionIpc, sweepOrphanImageTemps } from './ipc/sessions'
import { registerBatonIpc } from './ipc/baton'
import { registerShellIpc } from './ipc/shell'
import { registerDialogIpc } from './ipc/dialog'
import { registerGitIpc, cloneMissingWithToasts } from './ipc/git'
import { backfillRepoRemotes } from './services/git-remote'
import { listMissingRepos } from './services/repo-clone'
import { getPref, setPref } from './services/prefs-store'
import { setGpuState, OZONE_PREF_KEY, OZONE_PREF_DEFAULT } from './services/gpu-state'
import { rescheduleAutoPull, runAutoPullNow, stopAutoPull } from './services/repo-pull-scheduler'
import { registerFsIpc } from './ipc/fs'
import { registerPrefsIpc } from './ipc/prefs'
import { registerSecretsIpc } from './ipc/secrets'
import { registerEnvImportIpc } from './ipc/env-import'
import { migrateSecretsAtRest } from './services/custom-env'
import { electronCrypto } from './services/secret-store'
import {
  backupBeforeSecretsMigration,
  reclaimFreeSpace,
  removeSecretsBackups,
} from './services/db-maintenance'
import { scrubProfileSecrets, shouldScrubProfile } from './services/secret-scrub'
import { registerGpuIpc } from './ipc/gpu'
import { registerClaudeConfigsIpc } from './ipc/claude-configs'
import { registerClaudePluginsIpc } from './ipc/claude-plugins'
import { registerClaudeSettingsIpc } from './ipc/claude-settings'
import { registerMetricsIpc } from './ipc/metrics'
import { registerFeaturesIpc } from './ipc/features'
import { registerLoopIpc } from './ipc/loop'
import { registerRepoDependenciesIpc } from './ipc/repo-dependencies'
import { registerHandoffsIpc } from './ipc/handoffs'
import { registerObjectivesIpc } from './ipc/objectives'
import { registerTasksIpc } from './ipc/tasks'
import { registerDiagramsIpc } from './ipc/diagrams'
import { registerVideoIpc } from './ipc/video'
import { killAll as killAllVideoRenders } from './services/video/render'
import { registerMcpIpc } from './ipc/mcp'
import { registerVoiceIpc } from './ipc/voice'
import { initMeetings } from './services/meetings'
import {
  forgetSessionSummaries,
  scheduleTurnSummary,
  setVoiceSessionFilter,
} from './services/voice-summary'
import { registerSyncIpc, syncOnBoot, syncCoordinator, notifySyncMutation } from './ipc/sync'
import { setSyncMutationHook, broadcast } from './services/notify'
import { startFeatureWatcher, stopFeatureWatcher } from './services/feature-store'
import { featureMemory } from './services/feature-memory'
import {
  registerWorkspaceIpc,
  markWorkspaceRunning,
  markWorkspaceCleanShutdown,
} from './ipc/workspace'
import { startMcpServer, stopMcpServer } from './services/mcp/server'
import { initUpdater } from './services/updater'
import { startUsageMonitor, stopUsageMonitor } from './services/usage-monitor'
import { registerWindowIpc, wireWindowMaximizeBroadcast } from './ipc/window'
import { setMainWindow, emitToast } from './services/notifications'

const __dirname = dirname(fileURLToPath(import.meta.url))

const isDev = !app.isPackaged

// GPU: default agora é aceleração LIGADA em todas as plataformas (nitidez do
// terminal via renderer WebGL). Em drivers problemáticos (ex: nVidia/Wayland,
// janela preta) desliga-se via pref gpu.disabled (Settings) ou CM_DISABLE_GPU=1.
// Precisa rodar antes do ready; o getPref abre o DB cedo — as migrações são puro
// SQLite (sem dependência pós-ready), mas o try/catch cobre qualquer falha de
// I/O caindo no default (GPU ligada).
function safeGetBoolPref(key: string, fallback = false): boolean {
  try {
    return getPref(key, fallback)
  } catch {
    return fallback
  }
}
const gpuOff = process.env.CM_DISABLE_GPU === '1' || safeGetBoolPref('gpu.disabled')
if (gpuOff) app.disableHardwareAcceleration()
// Wayland nativo por padrão no Linux. Sob XWayland o servidor X gera autorepeat
// a partir do ESTADO da tecla: um teclado que perde o scancode de break (bug de
// EC/firmware, ex. Predator PHN16-73) deixa a tecla afundada e o app recebe
// digitação fantasma infinita. Cliente Wayland nativo só repete ao RECEBER
// evento, então estado parado não gera nada. `auto` cai para X11 onde não há
// compositor. Escape hatch pra driver que abra janela preta sem XWayland:
// CM_DISABLE_WAYLAND=1 — a pref só serve se a janela subir pra abrir Settings.
const ozoneWayland =
  process.platform === 'linux' &&
  process.env.CM_DISABLE_WAYLAND !== '1' &&
  safeGetBoolPref(OZONE_PREF_KEY, OZONE_PREF_DEFAULT)
if (ozoneWayland) app.commandLine.appendSwitch('ozone-platform-hint', 'auto')
setGpuState({ hwAccelDisabled: gpuOff, ozoneWayland })

function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    show: false,
    frame: false,
    autoHideMenuBar: true,
    backgroundColor: '#08080b',
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  win.on('ready-to-show', () => win.show())

  setMainWindow(win)
  wireWindowMaximizeBroadcast(win)

  // Links externos sempre vão pro browser do sistema, nunca navegam a janela do
  // app. Só abre http(s) — sem isso um window.open() vazio mandava `about:blank`
  // pro openExternal e o Chrome abria em branco.
  const openExternalSafe = (url: string) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
  }
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternalSafe(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== win.webContents.getURL()) {
      e.preventDefault()
      openExternalSafe(url)
    }
  })

  if (isDev && process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return win
}

// Backfill idempotente das origins + (se a pref permitir) clone dos repos
// registrados que não estão no disco. Best-effort: qualquer falha é logada e o
// boot segue.
async function autoCloneMissingOnBoot(): Promise<void> {
  try {
    await backfillRepoRemotes()
    if (getPref('autoCloneMissing', true) && listMissingRepos().length > 0) {
      await cloneMissingWithToasts()
    }
  } catch (err) {
    console.error('[repo-sync] auto-clone no boot falhou:', err)
  }
}

// Log de diagnóstico de GPU no boot: 1 linha com vendor/device/driver (quando o
// Chromium expõe) + o estado efetivo da aceleração. É o que permite correlacionar
// relatos de corrupção de atlas (ex: NVIDIA/Wayland) com o driver da máquina.
function logGpuInfo(): void {
  app
    .getGPUInfo('basic')
    .then((info) => {
      const { gpuDevice, driverVendor, driverVersion } = info as {
        gpuDevice?: Array<{ vendorId?: number; deviceId?: number; active?: boolean }>
        driverVendor?: string
        driverVersion?: string
      }
      const devices = (gpuDevice ?? [])
        .map(
          (d) =>
            `${d.active ? '*' : ''}${(d.vendorId ?? 0).toString(16)}:${(d.deviceId ?? 0).toString(16)}`,
        )
        .join(', ')
      console.log(
        `[gpu] devices=[${devices}] driver=${driverVendor ?? '?'} ${driverVersion ?? '?'} hwAccelDisabled=${gpuOff}`,
      )
    })
    .catch((err) => console.warn('[gpu] getGPUInfo falhou:', String(err)))
}

app.whenReady().then(async () => {
  logGpuInfo()
  // Sem menu de aplicação: o menu default do Electron traz um item Edit→Paste com
  // acelerador Ctrl+V que dispara webContents.paste() ALÉM do paste nativo do
  // textarea do xterm — resultado é colar 2x. Campos de input normais continuam
  // colando via clipboard nativo do Chromium. Coerente com autoHideMenuBar.
  Menu.setApplicationMenu(null)
  getDb()
  // Segredos em repouso. Roda aqui e não em getDb() porque safeStorage só
  // responde de forma confiável depois do ready (no Linux ele precisa do
  // keyring já resolvido).
  //
  // Perfil descartável (cópia do userData que o harness de e2e joga em /tmp):
  // troca os valores por placeholder ANTES de qualquer coisa poder usá-los.
  if (shouldScrubProfile(process.env, app.getPath('userData'), tmpdir())) {
    try {
      const count = scrubProfileSecrets()
      // Trocar o valor vivo não basta: o texto claro original segue nas páginas
      // livres da cópia, e um backup pré-migração copiado junto conteria o
      // segredo inteiro. Os dois somem aqui.
      const removed = removeSecretsBackups(app.getPath('userData'))
      const { ms } = reclaimFreeSpace(getDb())
      console.warn(
        `[secrets] perfil descartável: ${count} valor(es) substituído(s) por placeholder, ${removed} backup(s) removido(s), páginas livres recuperadas em ${ms}ms`,
      )
    } catch (err) {
      console.warn('[secrets] falha ao limpar perfil descartável:', String(err))
    }
  } else {
    // Perfil real: cifra o que ainda estiver em claro (pref legada ou gravada
    // com o cofre indisponível). Nunca derruba o boot.
    try {
      const result = migrateSecretsAtRest(electronCrypto, {
        // Rede de segurança: snapshot do banco antes de converter dado do
        // usuário. Só é chamado quando a migração vai mesmo reescrever, e falhar
        // aqui aborta a migração (sem backup, não reescreve — tenta no próximo
        // boot).
        beforeWrite: () => {
          const path = backupBeforeSecretsMigration(getDb(), app.getPath('userData'))
          console.log(`[secrets] backup pré-migração em ${path}`)
        },
        // O texto claro convertido continua nas páginas livres até o VACUUM.
        // Falhar aqui (outra instância segurando o banco) NÃO desfaz a migração:
        // o dado já está cifrado, só o resíduo continua — avisa e segue.
        afterWrite: () => {
          try {
            const { ms, freelistBefore } = reclaimFreeSpace(getDb())
            console.log(`[secrets] ${freelistBefore} página(s) livre(s) recuperada(s) em ${ms}ms`)
          } catch (err) {
            console.warn(
              '[secrets] VACUUM adiado — texto claro segue em páginas livres:',
              String(err),
            )
          }
        },
      })
      if (result.migrated > 0) {
        console.log(`[secrets] ${result.migrated} valor(es) cifrado(s) em repouso`)
      }
      if (result.skipped === 'unavailable' && result.plaintext.length > 0) {
        console.warn(
          `[secrets] cofre do SO indisponível — ${result.plaintext.length} valor(es) seguem em claro no banco`,
        )
      }
    } catch (err) {
      console.warn('[secrets] migração adiada:', String(err))
    }
  }
  // MCP server local (writes externos via Claude Code). Async e fire-and-forget:
  // EADDRINUSE etc. são logados dentro do start — nunca derrubam o boot.
  void startMcpServer()
  // Captura o clean_shutdown do boot anterior e o zera; deve rodar antes da
  // janela para que o renderer leia o valor correto via workspace:get-boot-state.
  markWorkspaceRunning()
  registerProjectIpc()
  registerRepoDependenciesIpc()
  registerHandoffsIpc()
  registerSessionIpc()
  registerBatonIpc()
  // Boot reconcile: apaga temporários de imagem órfãos (pasted/dropped no
  // composer) deixados por sessões de execuções anteriores.
  sweepOrphanImageTemps()
  registerShellIpc()
  registerDialogIpc()
  registerGitIpc()
  registerFsIpc()
  registerPrefsIpc()
  registerSecretsIpc()
  registerEnvImportIpc()
  registerGpuIpc()
  registerWorkspaceIpc()
  registerClaudeConfigsIpc()
  registerClaudePluginsIpc()
  registerClaudeSettingsIpc()
  registerMetricsIpc()
  registerFeaturesIpc()
  registerLoopIpc()
  registerObjectivesIpc()
  registerTasksIpc()
  registerDiagramsIpc()
  registerVideoIpc()
  registerMcpIpc()
  registerVoiceIpc()
  initMeetings()
  registerSyncIpc()
  // Wire o ponto único de mutação → coordinator (auto-sync on-idle). Cobre
  // objectives/tasks/features (via notify.broadcast) e projects/repos (via
  // pingSyncMutation), tanto pela camada IPC quanto pelo MCP server.
  setSyncMutationHook(notifySyncMutation)
  // Fim de turno (working → waiting/idle) → resumo falado do modo voz. Hook
  // injetado aqui pra evitar ciclo session-activity ↔ chat-transcript-service.
  setTurnEndedHook(scheduleTurnSummary)
  // O índice cobre toda sessão CC da máquina; o resumo só paga transcript +
  // claude pra sessões que o app exibe (pane aberto = watch de atividade).
  setVoiceSessionFilter((id) => sessionActivityService.isWatched(id))
  // Sessão que sumiu do índice limpa o estado de dedupe do resumo.
  setSessionGoneHook(forgetSessionSummaries)
  registerWindowIpc()

  // A janela é criada PRIMEIRO (sem await no sync) para não pintar tela preta
  // até 8s em rede lenta. O watcher inicia já — o syncOnBoot pausa/reinicia o
  // watcher via watcherHooks internamente quando importa.
  createMainWindow()
  initUpdater()
  startUsageMonitor()
  startFeatureWatcher()
  // Self-heal periódico de handoffs presos em 'running' cuja filha já morreu em
  // runtime (PTY exit pode não ter disparado a reconciliação). Não bloqueia o
  // boot e é idempotente — a query só toca handoffs órfãos.
  handoffReconcileTimer = setInterval(
    () => handoffStore.reconcileStuck(),
    HANDOFF_RECONCILE_INTERVAL_MS,
  )

  // Cron opt-in de auto-pull (pref autoPullEnabled/autoPullIntervalMinutes) +
  // um tick único poucos segundos após o boot, quando ligado. Best-effort.
  rescheduleAutoPull()
  autoPullBootTimer = setTimeout(() => void runAutoPullNow(), AUTO_PULL_BOOT_DELAY_MS)

  // Pull-no-boot CONSERVADOR em BACKGROUND: importa só fast-forward limpo (sem
  // trabalho local não-empurrado), bounded por timeout e NÃO-fatal (offline/erro
  // → segue com dados locais). Roda sob o mutex de sync (não corre com o
  // coordinator). Se IMPORTOU (mudou dados), faz broadcast dos canais das
  // entidades sincronizadas para o renderer recarregar ao vivo — as stores de
  // features/objectives/tasks tratam um payload-sinal como "refresh()".
  void syncOnBoot()
    .then((imported) => {
      if (!imported) return
      broadcast('feature:updated', { backfill: true })
      broadcast('objective:updated', { reload: true })
      broadcast('task:updated', { reload: true })
    })
    // Auto-clone dos repos faltantes DEPOIS do import do boot (o sync pode ter
    // trazido registros novos de outra máquina). Best-effort e não-bloqueante.
    .finally(() => void autoCloneMissingOnBoot())

  // Pós-suspend o contexto WebGL pode morrer SEM disparar onContextLoss no
  // renderer — avisamos as janelas pra cada terminal se curar (clearTextureAtlas
  // + refresh). powerMonitor só existe depois do ready.
  powerMonitor.on('resume', () => {
    broadcast('gpu:resumed', { at: Date.now() })
  })

  // Auto-fallback em crash do processo de GPU (driver instável, ex: NVIDIA/
  // Wayland): avisa os renderers pra largarem o WebGL (seguem em DOM na mesma
  // sessão). No 2º crash do processo, desliga a aceleração pro PRÓXIMO boot
  // (a flag só vale antes do ready) e avisa o usuário via toast.
  app.on('child-process-gone', (_e, details) => {
    if (details.type !== 'GPU') return
    if (!['crashed', 'oom', 'launch-failed', 'killed'].includes(details.reason)) return
    gpuCrashCount += 1
    console.warn(`[gpu] processo de GPU morreu (${details.reason}) — crash #${gpuCrashCount}`)
    broadcast('gpu:crashed', { reason: details.reason, count: gpuCrashCount })
    if (gpuCrashCount === 2) {
      setPref('gpu.disabled', true)
      emitToast(
        'Aceleração de GPU desativada',
        'Aceleração de GPU instável neste driver — desativada. Reinicie o app pra aplicar totalmente.',
      )
    }
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
  })
})

// Crashes do processo de GPU nesta execução (ver child-process-gone no whenReady).
let gpuCrashCount = 0

// Self-heal de handoffs órfãos a cada 5min (ver app.whenReady).
const HANDOFF_RECONCILE_INTERVAL_MS = 5 * 60 * 1000
let handoffReconcileTimer: ReturnType<typeof setInterval> | null = null

// Cron opt-in de auto-pull dos repos de projeto (ver app.whenReady). O
// agendamento em si vive em services/repo-pull-scheduler.ts; aqui só fica o tick
// único de boot, que é lógica de boot e não de agendamento.
const AUTO_PULL_BOOT_DELAY_MS = 5000
let autoPullBootTimer: ReturnType<typeof setTimeout> | null = null

// Shutdown síncrono final: roda DEPOIS do flush de sync (que lê o DB), porque a
// última operação fecha o DB. Idempotente via flag `didShutdown`.
let didShutdown = false
function runFinalShutdown(): void {
  if (didShutdown) return
  didShutdown = true
  void stopMcpServer()
  stopUsageMonitor()
  stopFeatureWatcher()
  if (handoffReconcileTimer) {
    clearInterval(handoffReconcileTimer)
    handoffReconcileTimer = null
  }
  stopAutoPull()
  if (autoPullBootTimer) {
    clearTimeout(autoPullBootTimer)
    autoPullBootTimer = null
  }
  syncCoordinator.stop()
  featureMemory.close()
  ptyManager.killAll()
  // Render do Remotion é processo filho e não morre sozinho com o app.
  killAllVideoRenders()
  sessionActivityService.closeAll()
  getDb()
    .prepare("UPDATE sessions SET status = 'exited', ended_at = ? WHERE status = 'running'")
    .run(Date.now())
  markWorkspaceCleanShutdown()
  closeDb()
}

// Bounded ~6s + não-fatal: nunca trava o fechamento indefinidamente. Resolve
// quando o flush termina OU quando o timeout estoura, o que vier primeiro.
const QUIT_FLUSH_TIMEOUT_MS = 6000

let quitFlushStarted = false
app.on('before-quit', (event) => {
  if (didShutdown) return // shutdown já concluído → deixa o quit prosseguir
  if (quitFlushStarted) {
    // Flush em andamento: um 2º quit não pode escapar o shutdown limpo (sem o
    // preventDefault o Electron prosseguiria e fecharia o DB no meio do flush).
    event.preventDefault()
    return
  }
  quitFlushStarted = true

  // Adia o quit para empurrar a última edição (best-effort) ANTES de fechar o
  // DB — sem isso, trocar de máquina perderia a última mutação. O flush lê o DB,
  // então DEVE rodar antes do closeDb (em runFinalShutdown).
  event.preventDefault()

  const flushDone = syncCoordinator.flush().catch((err) => {
    console.warn('[sync] flush no quit falhou (não-fatal):', String((err as Error)?.message ?? err))
  })
  const bounded = Promise.race([
    flushDone,
    new Promise<void>((resolve) => setTimeout(resolve, QUIT_FLUSH_TIMEOUT_MS)),
  ])

  void bounded.then(() => {
    runFinalShutdown()
    app.quit() // re-dispara o quit; didShutdown=true → before-quit é no-op agora
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
