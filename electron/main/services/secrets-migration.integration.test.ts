import Database from 'better-sqlite3'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Migração de segredos exercitada contra um ARQUIVO SQLite de verdade — é onde
// os dois defeitos moram: a perda da chave ilegível só aparece no mapa misto
// gravado, e o resíduo em texto claro só existe em arquivo (o :memory: não tem
// freelist observável nem WAL).
vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptString: (plain: string) => Buffer.from(`v:${plain}`, 'utf8'),
    decryptString: (buf: Buffer) => {
      const raw = buf.toString('utf8')
      if (!raw.startsWith('v:')) throw new Error('não é deste cofre')
      return raw.slice(2)
    },
  },
}))

let db: Database.Database
vi.mock('./db', () => ({ getDb: () => db }))

import { CUSTOM_ENV_VARS_KEY, listCustomEnvEntries, migrateSecretsAtRest } from './custom-env'
import {
  backupBeforeSecretsMigration,
  reclaimFreeSpace,
  SECRETS_BACKUP_PREFIX,
} from './db-maintenance'
import { getPref, setPref } from './prefs-store'

// Valor fictício, grande o bastante para ocupar páginas próprias: é o que faz o
// texto claro antigo cair na freelist em vez de ser sobrescrito no lugar.
const FAKE_NEEDLE = 'fake-plaintext-needle-0123456789'
const FAKE_PLAINTEXT = FAKE_NEEDLE.repeat(400)
const ALIEN_BLOB = Buffer.from('outro-cofre:opaco', 'utf8').toString('base64')

let dir: string

function dbFileContains(name: string, needle: string): boolean {
  const path = join(dir, name)
  return existsSync(path) && readFileSync(path).includes(needle)
}

function backups(): string[] {
  return readdirSync(dir).filter((n) => n.startsWith(SECRETS_BACKUP_PREFIX))
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cm-secrets-mig-'))
  db = new Database(join(dir, 'app.db'))
  db.pragma('journal_mode = WAL')
  db.exec('CREATE TABLE app_prefs (key TEXT PRIMARY KEY, value TEXT)')
  // Mapa v2 MISTO: um ciphertext que não decifra neste cofre ao lado de um valor
  // ainda em claro.
  setPref(CUSTOM_ENV_VARS_KEY, {
    version: 2,
    vars: {
      LOST: { enc: true, data: ALIEN_BLOB },
      PLAIN: { enc: false, value: FAKE_PLAINTEXT },
    },
  })
  db.pragma('wal_checkpoint(TRUNCATE)')
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('migração de segredos sobre arquivo real', () => {
  function migrate() {
    return migrateSecretsAtRest(undefined, {
      beforeWrite: () => backupBeforeSecretsMigration(db, dir, 1700000000000),
      afterWrite: () => reclaimFreeSpace(db),
    })
  }

  it('a chave ilegível sobrevive e o texto claro some do arquivo', () => {
    expect(dbFileContains('app.db', FAKE_NEEDLE)).toBe(true)

    const result = migrate()

    expect(result.migrated).toBe(1)
    // Ilegível preservado com o ciphertext original, e ainda visível pra UI.
    expect(
      getPref<{ vars: Record<string, unknown> }>(CUSTOM_ENV_VARS_KEY, {
        vars: {},
      }).vars.LOST,
    ).toEqual({ enc: true, data: ALIEN_BLOB })
    expect(listCustomEnvEntries().map((e) => e.key)).toEqual(['LOST', 'PLAIN'])
    // Nem na linha viva, nem nas páginas livres, nem no WAL.
    expect(dbFileContains('app.db', FAKE_NEEDLE)).toBe(false)
    expect(dbFileContains('app.db-wal', FAKE_NEEDLE)).toBe(false)
  })

  it('o backup pré-migração fica ao lado do banco e guarda o estado anterior', () => {
    migrate()

    expect(backups()).toEqual([`${SECRETS_BACKUP_PREFIX}1700000000000`])
    const backup = new Database(join(dir, backups()[0]), { readonly: true })
    const raw = backup.prepare('SELECT value FROM app_prefs WHERE key = ?').get(CUSTOM_ENV_VARS_KEY)
    backup.close()
    expect(String((raw as { value: string }).value)).toContain(FAKE_NEEDLE)
  })

  it('segunda execução não migra de novo nem gera outro backup', () => {
    migrate()

    const second = migrate()

    expect(second.skipped).toBe('not-needed')
    expect(backups()).toHaveLength(1)
  })
})
