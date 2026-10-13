import Database from 'better-sqlite3'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  backupBeforeImport,
  backupBeforeSecretsMigration,
  IMPORT_BACKUP_PREFIX,
  pruneSecretsBackups,
  reclaimFreeSpace,
  removeSecretsBackups,
  secretsBackupsToPrune,
  SECRETS_BACKUP_PREFIX,
} from './db-maintenance'

// Valores fictícios: o teste precisa de um texto reconhecível no arquivo, nunca
// de um segredo real.
const FAKE_SECRET = 'fake-plaintext-needle-0123456789'

let dir: string
let db: Database.Database

function openDb(): Database.Database {
  const handle = new Database(join(dir, 'app.db'))
  handle.pragma('journal_mode = WAL')
  return handle
}

function fileContains(path: string, needle: string): boolean {
  return readFileSync(path).includes(needle)
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cm-db-maint-'))
  db = openDb()
  db.exec('CREATE TABLE app_prefs (key TEXT PRIMARY KEY, value TEXT)')
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('secretsBackupsToPrune', () => {
  it('mantém os mais recentes e devolve o excedente', () => {
    const names = [
      'app.db',
      `${SECRETS_BACKUP_PREFIX}1`,
      `${SECRETS_BACKUP_PREFIX}3`,
      `${SECRETS_BACKUP_PREFIX}2`,
    ]
    expect(secretsBackupsToPrune(names, 2)).toEqual([`${SECRETS_BACKUP_PREFIX}1`])
  })

  it('nunca toca em arquivo que não é backup pré-migração', () => {
    expect(secretsBackupsToPrune(['app.db', 'app.db-wal'], 0)).toEqual([])
  })
})

describe('backupBeforeSecretsMigration', () => {
  it('o snapshot inclui o que só existe no WAL (por isso VACUUM INTO, não cp)', () => {
    db.prepare('INSERT INTO app_prefs (key, value) VALUES (?, ?)').run('k', FAKE_SECRET)

    const path = backupBeforeSecretsMigration(db, dir, 111)

    expect(path).toBe(join(dir, `${SECRETS_BACKUP_PREFIX}111`))
    const backup = new Database(path, { readonly: true })
    expect(backup.prepare('SELECT value FROM app_prefs WHERE key = ?').get('k')).toEqual({
      value: FAKE_SECRET,
    })
    backup.close()
  })

  it('poda os backups antigos ao criar um novo', () => {
    for (const ts of [1, 2, 3]) writeFileSync(join(dir, `${SECRETS_BACKUP_PREFIX}${ts}`), 'x')

    backupBeforeSecretsMigration(db, dir, 4)

    expect(
      readdirSync(dir)
        .filter((n) => n.startsWith(SECRETS_BACKUP_PREFIX))
        .sort(),
    ).toEqual([
      `${SECRETS_BACKUP_PREFIX}2`,
      `${SECRETS_BACKUP_PREFIX}3`,
      `${SECRETS_BACKUP_PREFIX}4`,
    ])
  })
})

describe('removeSecretsBackups', () => {
  it('apaga todos os backups e nada mais (perfil descartável)', () => {
    writeFileSync(join(dir, `${SECRETS_BACKUP_PREFIX}1`), 'x')
    writeFileSync(join(dir, `${SECRETS_BACKUP_PREFIX}2`), 'x')

    expect(removeSecretsBackups(dir)).toBe(2)
    expect(readdirSync(dir).some((n) => n.startsWith(SECRETS_BACKUP_PREFIX))).toBe(false)
    expect(readdirSync(dir)).toContain('app.db')
  })

  it('diretório sem backup nenhum é no-op', () => {
    expect(pruneSecretsBackups(dir)).toBe(0)
  })
})

describe('reclaimFreeSpace', () => {
  // O valor precisa transbordar a página para que a reescrita LIBERE páginas em
  // vez de sobrescrevê-las: é essa freelist que guarda o texto claro antigo.
  const BIG_PLAINTEXT = FAKE_SECRET.repeat(400)

  it('o texto claro antigo sobrevive nas páginas livres até o VACUUM', () => {
    const path = join(dir, 'app.db')
    db.prepare('INSERT INTO app_prefs (key, value) VALUES (?, ?)').run('secret', BIG_PLAINTEXT)
    db.pragma('wal_checkpoint(TRUNCATE)')
    db.prepare('UPDATE app_prefs SET value = ? WHERE key = ?').run('ciphertext', 'secret')
    db.pragma('wal_checkpoint(TRUNCATE)')

    // O valor vivo já é o ciphertext, mas os bytes antigos continuam no arquivo.
    expect(db.prepare('SELECT value FROM app_prefs WHERE key = ?').get('secret')).toEqual({
      value: 'ciphertext',
    })
    expect(db.pragma('freelist_count', { simple: true })).toBeGreaterThan(0)
    expect(fileContains(path, FAKE_SECRET)).toBe(true)

    reclaimFreeSpace(db)
    db.pragma('wal_checkpoint(TRUNCATE)')

    expect(db.pragma('freelist_count', { simple: true })).toBe(0)
    expect(fileContains(path, FAKE_SECRET)).toBe(false)
  })

  it('reporta o tempo e quantas páginas livres havia', () => {
    const result = reclaimFreeSpace(db)
    expect(result.freelistBefore).toBeGreaterThanOrEqual(0)
    expect(result.ms).toBeGreaterThanOrEqual(0)
  })
})

describe('backupBeforeImport', () => {
  it('usa prefixo próprio, captura o WAL e poda os antigos', () => {
    db.prepare('INSERT INTO app_prefs (key, value) VALUES (?, ?)').run('k', 'antes-do-import')
    for (const ts of [1, 2, 3]) writeFileSync(join(dir, `${IMPORT_BACKUP_PREFIX}${ts}`), 'x')

    const path = backupBeforeImport(db, dir, 4)

    expect(path).toBe(join(dir, `${IMPORT_BACKUP_PREFIX}4`))
    const backup = new Database(path, { readonly: true })
    expect(backup.prepare('SELECT value FROM app_prefs WHERE key = ?').get('k')).toEqual({
      value: 'antes-do-import',
    })
    backup.close()
    expect(
      readdirSync(dir)
        .filter((n) => n.startsWith(IMPORT_BACKUP_PREFIX))
        .sort(),
    ).toEqual([
      `${IMPORT_BACKUP_PREFIX}2`,
      `${IMPORT_BACKUP_PREFIX}3`,
      `${IMPORT_BACKUP_PREFIX}4`,
    ])
  })

  it('não confunde com o backup pré-segredos (prefixos independentes)', () => {
    writeFileSync(join(dir, `${SECRETS_BACKUP_PREFIX}1`), 'x')
    backupBeforeImport(db, dir, 1)
    expect(removeSecretsBackups(dir)).toBe(1)
    expect(readdirSync(dir)).toContain(`${IMPORT_BACKUP_PREFIX}1`)
  })
})
