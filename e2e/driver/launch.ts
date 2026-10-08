import { _electron as electron, type ElectronApplication, type Page } from 'playwright'
import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isSecretsBackup } from '../../electron/main/services/db-maintenance'

const here = dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT = resolve(here, '../..')
const MAIN_ENTRY = join(REPO_ROOT, 'out/main/index.js')
// node:sqlite via require: @types/node do repo (20.x) ainda não tipa o módulo,
// então o recorte usado aqui é tipado à mão.
const nodeRequire = createRequire(import.meta.url)
interface SqliteSync {
  prepare(sql: string): {
    get(): unknown
    run(...params: unknown[]): { changes: number | bigint }
  }
  exec(sql: string): void
  close(): void
}

// O dir de userData real é o que contém o app.db — db.ts deriva o path do banco
// de app.getPath('userData'), então o dir com app.db É a instalação real.
// Override explícito via CM_REAL_USERDATA quando preciso apontar outro perfil.
export function resolveRealUserData(): string {
  const override = process.env.CM_REAL_USERDATA
  if (override) return override
  const configDir = join(homedir(), '.config')
  const preferred = join(configDir, 'pitwall')
  if (existsSync(join(preferred, 'app.db'))) return preferred
  if (existsSync(configDir)) {
    for (const name of readdirSync(configDir)) {
      // ~/.config/Electron é o userData default do `npm run dev` (DB stale de dev),
      // nunca a instalação real — pular no fallback scan.
      if (name === 'Electron') continue
      const candidate = join(configDir, name)
      if (existsSync(join(candidate, 'app.db'))) return candidate
    }
  }
  return preferred
}

// Caches do Chromium são regenerados no launch — copiá-los só custa I/O e RAM
// (a cópia vai pra /tmp, que é tmpfs). Excluídos por nome de topo: um `Cache/`
// aninhado dentro de um dir de dados legítimo continua sendo copiado.
const SKIP_TOPLEVEL = new Set([
  'Cache',
  'Code Cache',
  'GPUCache',
  'ShaderCache',
  'blob_storage',
  'Crashpad',
  'DawnGraphiteCache',
  'DawnWebGPUCache',
])

export interface LaunchResult {
  app: ElectronApplication
  page: Page
  userDataCopy: string
  // stdout+stderr do main desde o launch: o captureLogs só assina depois do
  // firstWindow e perde o boot (ex.: as linhas [drive-safe]).
  mainOutput: () => string
}

export interface LaunchOptions {
  // Switches extras do Chromium (ex.: --use-fake-device-for-media-stream).
  extraArgs?: string[]
  // Variáveis a mais no ambiente do main (sobrepõem o process.env herdado).
  env?: Record<string, string>
  // Reusa uma cópia de userData já existente (o userDataCopy de um launch anterior
  // do mesmo processo) em vez de copiar o perfil real de novo — o padrão "1ª
  // subida roda migrations, cenário semeia o app.db, 2ª subida valida". A limpeza
  // continua com o launch que criou a cópia.
  userDataDir?: string
  // Default false: a cópia nasce SEM as abas restauráveis e sem handoffs
  // 'pending' (ver neutralizeBootSpawns). true mantém o comportamento antigo — o
  // boot re-spawna `claude --resume` das sessões REAIS, com o HOME real, e elas
  // podem agir sozinhas nos repos. Só ligar com env.HOME apontando pra um
  // fake-home. Ignorado quando userDataDir é passado (a cópia já existe).
  restoreTabs?: boolean
}

// Lança o app BUILDADO (out/main/index.js) contra uma CÓPIA do userData real.
// --user-data-dir redireciona o SQLite e todo o app.getPath('userData') pra cópia,
// então nada que eu fizer toca os dados reais.
// Marcadores de "estou dentro de uma sessão Claude Code" herdados de quem roda o
// harness: com eles a filha spawnada pelo app se trata como sessão aninhada e não
// grava transcript, e o cenário valida um chat vazio.
const INHERITED_CLAUDE_VARS = ['CLAUDECODE', 'CLAUDE_CODE_CHILD_SESSION']

export function inheritedEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out = { ...env }
  for (const key of INHERITED_CLAUDE_VARS) delete out[key]
  return out
}

export async function launchApp(options: LaunchOptions = {}): Promise<LaunchResult> {
  if (!existsSync(MAIN_ENTRY)) {
    throw new Error(
      `Build não encontrado em ${MAIN_ENTRY}.\nRode antes: npm run rebuild:native && npm run build`,
    )
  }
  const copy = options.userDataDir ?? copyRealUserData(options.restoreTabs ?? false)
  // A cópia carrega o app_prefs inteiro, incluindo as chaves de API do usuário.
  // Elas ficam cifradas em repouso, mas a cópia roda como o MESMO usuário do SO —
  // o cofre decifraria normalmente. Por padrão o app troca os valores por um
  // placeholder no boot (CM_SCRUB_SECRETS; só vale para userData dentro do
  // tmpdir — ver services/secret-scrub.ts), então nenhum segredo utilizável vive
  // na cópia. Os testes que só checam "a integração está configurada" continuam
  // passando, porque o placeholder é não-vazio.
  //
  // CM_KEEP_SECRETS=1 é o opt-out EXPLÍCITO para o punhado de cenários que
  // precisam da credencial real (ex.: integration-webaudit, que loga no legal-ui
  // staging). Nunca ligar por padrão.
  const keepSecrets = process.env.CM_KEEP_SECRETS === '1'
  const app = await electron.launch({
    args: [MAIN_ENTRY, '--no-sandbox', `--user-data-dir=${copy}`, ...(options.extraArgs ?? [])],
    env: {
      ...inheritedEnv(),
      CM_SCRUB_SECRETS: keepSecrets ? '0' : '1',
      CM_MCP_EPHEMERAL_PORT: '1',
      // A cópia protege o banco, não o filesystem nem o microfone: sem isto o
      // app buildado roda auto-pull/auto-clone nos repos REAIS e a detecção de
      // reunião reage ao mic real (ver electron/main/services/drive-safe.ts).
      // Opt-out explícito: options.env = { CM_DRIVE_SAFE: '0' }.
      CM_DRIVE_SAFE: '1',
      ...(options.env ?? {}),
    } as Record<string, string>,
  })
  // Morte externa do Electron (SIGTERM/SIGKILL, OOM) chega ao cenário só como
  // "Target page, context or browser has been closed" — sem isto não dá pra
  // distinguir crash do app de kill de fora.
  app.process().on('exit', (code, signal) => {
    if (code !== 0) console.error(`[launch] electron saiu: code=${code} signal=${signal}`)
  })
  const output: string[] = []
  app.process().stdout?.on('data', (d) => output.push(String(d)))
  app.process().stderr?.on('data', (d) => output.push(String(d)))
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  return { app, page, userDataCopy: copy, mainOutput: () => output.join('') }
}

export function copyRealUserData(restoreTabs = false): string {
  const real = resolveRealUserData()
  const copy = mkdtempSync(join(tmpdir(), 'cm-drive-userdata-'))

  // tmpdir() é tmpfs nesta máquina: cada cópia deixada pra trás fica residente em
  // RAM até o reboot. Sem isto, cada run vazava ~334MB permanentes.
  process.once('exit', () => {
    try {
      rmSync(copy, { recursive: true, force: true })
    } catch {
      // best-effort: não mascarar o erro real que causou a saída
    }
  })
  // Handlers de sinal só redirecionam pro 'exit' acima (Ctrl-C não o dispara sozinho).
  process.once('SIGINT', () => process.exit(130))
  process.once('SIGTERM', () => process.exit(143))

  if (existsSync(real)) {
    cpSync(real, copy, {
      recursive: true,
      filter: (src) => {
        const rel = relative(real, src)
        if (!rel) return true
        const top = rel.split(sep)[0]
        // Backup pré-migração dos segredos: é um snapshot do banco ANTES da
        // cifragem, ou seja, texto claro. O scrub do boot só mexe no app.db —
        // então este nem entra na cópia.
        if (isSecretsBackup(top)) return false
        // `sync/` é o CLONE do repo de backup real do usuário, e
        // `isConfigured()` (ipc/sync.ts) é literalmente `existsSync(sync/.git)`.
        // Copiado, a cópia nasce sincronizada: o boot puxa o bundle remoto e o
        // coordinator dá `git push` a cada mutação — dois runs seguidos do drive
        // geraram 3 commits em claude-manager-backup, e o 2º run nasceu com o
        // estado de teste que o 1º havia empurrado. A cópia protege o banco
        // local, não o remoto. `sync-config.json` CONTINUA na cópia: ele carrega
        // o projectsRoot que o auto-pull de repos usa (sem ele o app tenta
        // clonar os 32 repos do zero). CM_KEEP_SYNC=1 é o opt-in de quem testa
        // sync de propósito.
        if (top === 'sync' && process.env.CM_KEEP_SYNC !== '1') return false
        return !SKIP_TOPLEVEL.has(top)
      },
    })
  }
  if (!restoreTabs && existsSync(join(copy, 'app.db'))) {
    const { panes, handoffs } = neutralizeBootSpawns(copy)
    console.log(
      `[launch] cópia sem gatilhos de spawn: ${panes} aba(s), ${handoffs} handoff(s) pending`,
    )
  }
  return copy
}

// O boot do app spawna PTYs sozinho por dois caminhos, ambos lidos deste banco:
// - restoreWorkspace (src/store/appStore.ts) roda `claude --resume` para cada
//   pane de workspace_state.open_panes (dock_layout só posiciona esses panes);
// - useHandoffs (src/features/handoffs/useHandoffs.ts), com o gate desligado
//   (default), aprova todo handoff 'pending' e sobe a filha no repo-alvo.
// Na cópia do perfil real, os dois ressuscitam sessões REAIS com o HOME real.
//
// node:sqlite, e não sql.js: o app real costuma estar aberto, então as abas
// recentes vivem só no app.db-wal. sql.js lê só o app.db e, ao regravá-lo, o
// -wal copiado seria reaplicado por cima no boot. node:sqlite lê o WAL e faz o
// checkpoint no close, deixando o app.db autocontido.
function neutralizeBootSpawns(userDataDir: string): { panes: number; handoffs: number } {
  const db = openCopyDb(userDataDir)
  try {
    const panes = db.prepare('SELECT open_panes FROM workspace_state WHERE id = 1').get() as
      { open_panes: string | null } | undefined
    db.exec('UPDATE workspace_state SET open_panes = NULL, dock_layout = NULL')
    const handoffs = db
      .prepare("UPDATE handoffs SET status = 'rejected' WHERE status = 'pending'")
      .run()
    return { panes: countPanes(panes?.open_panes), handoffs: Number(handoffs.changes) }
  } finally {
    db.close()
  }
}

function openCopyDb(userDataDir: string): SqliteSync {
  const { DatabaseSync } = nodeRequire('node:sqlite') as {
    DatabaseSync: new (path: string) => SqliteSync
  }
  return new DatabaseSync(join(userDataDir, 'app.db'))
}

// Ajusta app_prefs de uma cópia ANTES do boot (null apaga a chave). Mesmo motivo
// do node:sqlite acima: a cópia pode ter o -wal do app real aberto. Ex.: zerar os
// atalhos remapeados do perfil real num cenário que aperta os defaults.
export function writeCopyPrefs(userDataDir: string, prefs: Record<string, string | null>): void {
  const db = openCopyDb(userDataDir)
  try {
    for (const [key, value] of Object.entries(prefs)) {
      if (value == null) db.prepare('DELETE FROM app_prefs WHERE key = ?').run(key)
      else db.prepare('INSERT OR REPLACE INTO app_prefs (key, value) VALUES (?, ?)').run(key, value)
    }
  } finally {
    db.close()
  }
}

function countPanes(raw: string | null | undefined): number {
  try {
    return raw ? (JSON.parse(raw) as unknown[]).length : 0
  } catch {
    return 0
  }
}
