import Database from 'better-sqlite3'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export type MigrationOutcome = 'already-migrated' | 'nothing-to-migrate' | 'migrated'

export interface MigrationResult {
  outcome: MigrationOutcome
  fromDir: string
  toDir: string
  /** Entradas de topo copiadas (fora o app.db). Só em 'migrated'. */
  copied?: number
}

export interface MigrationLogger {
  info(message: string): void
  error(message: string, err?: unknown): void
}

export interface MigrateUserDataOptions {
  fromDir: string
  toDir: string
  logger?: MigrationLogger
}

// Caches do Chromium são regenerados no próximo launch: copiá-los só custa I/O
// (e o Crashpad carrega dumps que não interessam ao perfil novo). Mesma lista do
// harness do drive-app (e2e/driver/launch.ts), incluindo os dirs Dawn*.
const SKIP_TOPLEVEL = new Set([
  'Cache',
  'Code Cache',
  'GPUCache',
  'ShaderCache',
  'blob_storage',
  'Crashpad',
])

const MARKER_FILE = '.migrated-from'
const DB_FILE = 'app.db'
// Nome temporário do VACUUM INTO: o app.db só aparece no destino quando está
// íntegro, então uma migração interrompida nunca é confundida com concluída.
const DB_TMP_FILE = 'app.db.migrating'

function shouldSkip(name: string): boolean {
  if (SKIP_TOPLEVEL.has(name)) return true
  if (name.startsWith('Dawn')) return true
  // O app.db vai por VACUUM INTO; copiar o -wal/-shm da origem por cima do banco
  // vacuumado (que já tem o WAL aplicado) corromperia o destino.
  if (name === DB_FILE || name.startsWith(`${DB_FILE}-`)) return true
  if (name === DB_TMP_FILE) return true
  return false
}

/**
 * Copia (nunca move — a origem é o backup) o userData de `fromDir` para `toDir`.
 * Idempotente: reexecuta a cópia se o destino existir sem app.db (cópia
 * interrompida). Em falha, loga e relança — subir com banco meio migrado é pior
 * do que não subir.
 */
export function migrateUserData({
  fromDir,
  toDir,
  logger = console,
}: MigrateUserDataOptions): MigrationResult {
  if (existsSync(join(toDir, DB_FILE))) return { outcome: 'already-migrated', fromDir, toDir }
  if (!existsSync(fromDir)) return { outcome: 'nothing-to-migrate', fromDir, toDir }

  logger.info(`[userdata-migrate] copiando ${fromDir} -> ${toDir}`)
  try {
    mkdirSync(toDir, { recursive: true })

    let copied = 0
    for (const name of readdirSync(fromDir)) {
      if (shouldSkip(name)) continue
      cpSync(join(fromDir, name), join(toDir, name), {
        recursive: true,
        force: true,
      })
      copied += 1
    }

    // O banco por último: enquanto o app.db não existir no destino, o próximo
    // boot refaz a cópia inteira em vez de abrir um perfil pela metade.
    const sourceDb = join(fromDir, DB_FILE)
    if (existsSync(sourceDb)) {
      const tmpDb = join(toDir, DB_TMP_FILE)
      rmSync(tmpDb, { force: true })
      const source = new Database(sourceDb, { readonly: true })
      try {
        // VACUUM INTO (e não cópia crua do arquivo) porque há WAL vivo: copiar só
        // o app.db deixaria para trás tudo que ainda não foi checkpointed.
        source.prepare('VACUUM INTO ?').run(tmpDb)
      } finally {
        source.close()
      }
      renameSync(tmpDb, join(toDir, DB_FILE))
    }

    writeFileSync(join(toDir, MARKER_FILE), `${fromDir}\n`, 'utf8')
    logger.info(`[userdata-migrate] concluído (${copied} entradas + banco)`)
    return { outcome: 'migrated', fromDir, toDir, copied }
  } catch (err) {
    logger.error(`[userdata-migrate] falha ao migrar ${fromDir} -> ${toDir}`, err)
    throw err
  }
}

export function resolveDefaultDirs(): { fromDir: string; toDir: string } {
  // Convenção de userData do Electron no Linux: $XDG_CONFIG_HOME (ou ~/.config)
  // + app.getName(), que vem do "name" do package.json.
  const configHome = process.env.XDG_CONFIG_HOME || join(homedir(), '.config')
  return {
    fromDir: join(configHome, 'claude-manager'),
    toDir: join(configHome, 'pitwall'),
  }
}

// Efeito no import: precisa rodar antes de qualquer coisa abrir o banco.
// Só no processo main do Electron em Linux (é o único userData que existiu com o
// nome antigo) e só sem --user-data-dir, senão o harness do drive-app — que roda
// contra uma CÓPIA em /tmp — mexeria no perfil real do usuário.
const launchedWithUserDataDir = process.argv.some((arg) => arg.startsWith('--user-data-dir'))
if (process.versions.electron && process.platform === 'linux' && !launchedWithUserDataDir) {
  migrateUserData(resolveDefaultDirs())
}
