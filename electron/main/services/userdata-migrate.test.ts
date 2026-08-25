import Database from 'better-sqlite3'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { migrateUserData } from './userdata-migrate'

const silentLogger = { info: () => {}, error: () => {} }

let root: string
let fromDir: string
let toDir: string
// Mantida ABERTA durante a migração: com a conexão viva o WAL não é
// checkpointed, que é exatamente o cenário que o VACUUM INTO precisa cobrir.
let sourceHandle: Database.Database | null = null

// Cria um app.db real com WAL vivo (sem checkpoint): é justamente o caso que
// cópia crua do arquivo perderia e o VACUUM INTO preserva.
function seedSourceDb(rows: string[]): void {
  const db = new Database(join(fromDir, 'app.db'))
  db.pragma('journal_mode = WAL')
  db.exec('CREATE TABLE notes (body TEXT)')
  const insert = db.prepare('INSERT INTO notes (body) VALUES (?)')
  for (const row of rows) insert.run(row)
  sourceHandle = db
}

function readNotes(dbPath: string): string[] {
  const db = new Database(dbPath, { readonly: true })
  const rows = db.prepare('SELECT body FROM notes ORDER BY rowid').all() as {
    body: string
  }[]
  db.close()
  return rows.map((r) => r.body)
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cm-userdata-migrate-'))
  fromDir = join(root, 'claude-manager')
  toDir = join(root, 'pitwall')
  mkdirSync(fromDir, { recursive: true })
})

afterEach(() => {
  sourceHandle?.close()
  sourceHandle = null
  rmSync(root, { recursive: true, force: true })
})

describe('migrateUserData', () => {
  it('não faz nada quando o destino já tem app.db', () => {
    seedSourceDb(['origem'])
    mkdirSync(toDir, { recursive: true })
    const destDb = new Database(join(toDir, 'app.db'))
    destDb.exec('CREATE TABLE notes (body TEXT)')
    destDb.prepare('INSERT INTO notes (body) VALUES (?)').run('destino-intacto')
    destDb.close()

    const result = migrateUserData({ fromDir, toDir, logger: silentLogger })

    expect(result.outcome).toBe('already-migrated')
    expect(readNotes(join(toDir, 'app.db'))).toEqual(['destino-intacto'])
    expect(existsSync(join(toDir, '.migrated-from'))).toBe(false)
  })

  it('não faz nada quando a origem não existe', () => {
    rmSync(fromDir, { recursive: true, force: true })

    const result = migrateUserData({ fromDir, toDir, logger: silentLogger })

    expect(result.outcome).toBe('nothing-to-migrate')
    expect(existsSync(toDir)).toBe(false)
  })

  it('copia banco (com WAL vivo) e arquivos, pulando caches, e mantém a origem', () => {
    seedSourceDb(['a', 'b'])
    expect(existsSync(join(fromDir, 'app.db-wal'))).toBe(true)
    writeFileSync(join(fromDir, 'prefs.json'), '{"theme":"vacuo"}', 'utf8')
    mkdirSync(join(fromDir, 'sessions', 'nested'), { recursive: true })
    writeFileSync(join(fromDir, 'sessions', 'nested', 'log.txt'), 'hello', 'utf8')
    for (const cache of [
      'Cache',
      'Code Cache',
      'GPUCache',
      'Crashpad',
      'blob_storage',
      'DawnWebGPUCache',
    ]) {
      mkdirSync(join(fromDir, cache), { recursive: true })
      writeFileSync(join(fromDir, cache, 'junk'), 'x', 'utf8')
    }

    const result = migrateUserData({ fromDir, toDir, logger: silentLogger })

    expect(result.outcome).toBe('migrated')
    expect(readNotes(join(toDir, 'app.db'))).toEqual(['a', 'b'])
    expect(readFileSync(join(toDir, 'prefs.json'), 'utf8')).toBe('{"theme":"vacuo"}')
    expect(readFileSync(join(toDir, 'sessions', 'nested', 'log.txt'), 'utf8')).toBe('hello')
    for (const cache of [
      'Cache',
      'Code Cache',
      'GPUCache',
      'Crashpad',
      'blob_storage',
      'DawnWebGPUCache',
    ]) {
      expect(existsSync(join(toDir, cache))).toBe(false)
    }
    // O -wal da origem não é copiado: o banco vacuumado já o incorporou.
    expect(existsSync(join(toDir, 'app.db-wal'))).toBe(false)
    expect(existsSync(join(toDir, 'app.db.migrating'))).toBe(false)
    expect(readFileSync(join(toDir, '.migrated-from'), 'utf8').trim()).toBe(fromDir)
    // Origem preservada — é o backup.
    expect(readNotes(join(fromDir, 'app.db'))).toEqual(['a', 'b'])
  })

  it('recopia quando o destino existe sem app.db (cópia interrompida)', () => {
    seedSourceDb(['a'])
    writeFileSync(join(fromDir, 'prefs.json'), 'novo', 'utf8')
    mkdirSync(toDir, { recursive: true })
    writeFileSync(join(toDir, 'prefs.json'), 'parcial', 'utf8')
    writeFileSync(join(toDir, 'app.db.migrating'), 'lixo de uma tentativa anterior', 'utf8')

    const result = migrateUserData({ fromDir, toDir, logger: silentLogger })

    expect(result.outcome).toBe('migrated')
    expect(readFileSync(join(toDir, 'prefs.json'), 'utf8')).toBe('novo')
    expect(existsSync(join(toDir, 'app.db.migrating'))).toBe(false)
    expect(readNotes(join(toDir, 'app.db'))).toEqual(['a'])
  })
})
