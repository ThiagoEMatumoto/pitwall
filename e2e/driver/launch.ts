import { _electron as electron, type ElectronApplication, type Page } from 'playwright'
import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isSecretsBackup } from '../../electron/main/services/db-maintenance'

const here = dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT = resolve(here, '../..')
const MAIN_ENTRY = join(REPO_ROOT, 'out/main/index.js')

// O dir de userData real é o que contém o app.db — db.ts deriva o path do banco
// de app.getPath('userData'), então o dir com app.db É a instalação real.
// Override explícito via CM_REAL_USERDATA quando preciso apontar outro perfil.
export function resolveRealUserData(): string {
  const override = process.env.CM_REAL_USERDATA
  if (override) return override
  const configDir = join(homedir(), '.config')
  const preferred = join(configDir, 'claude-manager')
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
}

export interface LaunchOptions {
  // Switches extras do Chromium (ex.: --use-fake-device-for-media-stream).
  extraArgs?: string[]
  // Variáveis a mais no ambiente do main (sobrepõem o process.env herdado).
  env?: Record<string, string>
}

// Lança o app BUILDADO (out/main/index.js) contra uma CÓPIA do userData real.
// --user-data-dir redireciona o SQLite e todo o app.getPath('userData') pra cópia,
// então nada que eu fizer toca os dados reais.
export async function launchApp(options: LaunchOptions = {}): Promise<LaunchResult> {
  if (!existsSync(MAIN_ENTRY)) {
    throw new Error(
      `Build não encontrado em ${MAIN_ENTRY}.\nRode antes: npm run rebuild:native && npm run build`,
    )
  }
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
        return !SKIP_TOPLEVEL.has(top)
      },
    })
  }
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
      ...process.env,
      CM_SCRUB_SECRETS: keepSecrets ? '0' : '1',
      ...(options.env ?? {}),
    } as Record<string, string>,
  })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  return { app, page, userDataCopy: copy }
}
