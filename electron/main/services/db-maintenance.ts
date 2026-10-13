import { readdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import type Database from 'better-sqlite3'

// Manutenção do ARQUIVO do banco em torno da cifragem de segredos em repouso.
//
// Cifrar a linha viva não basta: o SQLite não sobrescreve a página antiga, ele a
// devolve pra freelist. O texto claro do segredo continua legível com um
// `strings app.db` até que as páginas sejam recuperadas — e qualquer cópia do
// userData (o harness de e2e copia o dir inteiro) leva esses bytes junto.

export const SECRETS_BACKUP_PREFIX = 'app.db.pre-secrets-'

// Quantos backups pré-migração ficam no disco. A migração roda uma vez, mas o
// cofre pode ficar indisponível e voltar (Linux sem keyring resolvido), então
// mais de um é possível — guardar alguns dá janela pro usuário perceber.
export const SECRETS_BACKUP_KEEP = 3

// Backup pré-import de sync/backup .zip. O import é replace-all DESTRUTIVO: um
// bundle ruim (o caso real: paths relativos vindos de um run de teste) troca o
// estado sincronizável inteiro sem volta. Mesmo mecanismo do pré-segredos.
export const IMPORT_BACKUP_PREFIX = 'app.db.pre-import-'
export const IMPORT_BACKUP_KEEP = 3

export function isSecretsBackup(name: string): boolean {
  return name.startsWith(SECRETS_BACKUP_PREFIX)
}

// Nome ordenável por si só: epoch em ms tem largura fixa, então ordem
// lexicográfica = ordem cronológica.
export function secretsBackupName(now: number = Date.now()): string {
  return `${SECRETS_BACKUP_PREFIX}${now}`
}

export function secretsBackupsToPrune(names: string[], keep = SECRETS_BACKUP_KEEP): string[] {
  return backupsToPrune(names, SECRETS_BACKUP_PREFIX, keep)
}

function backupsToPrune(names: string[], prefix: string, keep: number): string[] {
  return names
    .filter((n) => n.startsWith(prefix))
    .sort()
    .reverse()
    .slice(keep)
}

function pruneBackups(dir: string, prefix: string, keep: number): number {
  const stale = backupsToPrune(readdirSync(dir), prefix, keep)
  for (const name of stale) unlinkSync(join(dir, name))
  return stale.length
}

// Snapshot com `VACUUM INTO` (nunca cp do arquivo: o banco está em WAL, copiar
// só o .db produziria um backup silenciosamente desatualizado).
function snapshotDb(
  db: Database.Database,
  dir: string,
  prefix: string,
  now: number,
  keep: number,
): string {
  const path = join(dir, `${prefix}${now}`)
  db.prepare('VACUUM INTO ?').run(path)
  pruneBackups(dir, prefix, keep)
  return path
}

// Snapshot consistente do banco ANTES da migração reescrever os segredos.
// `VACUUM INTO` (e não um cp do arquivo) porque o banco está em WAL: copiar o
// .db sem o .wal produziria um backup silenciosamente desatualizado.
//
// O backup contém os segredos em CLARO — é justamente o estado pré-migração.
// Fica no userData, mesma proteção que o banco tinha até agora, e é apagado do
// perfil descartável antes de qualquer coisa (removeSecretsBackups).
export function backupBeforeSecretsMigration(
  db: Database.Database,
  dir: string,
  now: number = Date.now(),
): string {
  return snapshotDb(db, dir, SECRETS_BACKUP_PREFIX, now, SECRETS_BACKUP_KEEP)
}

// Snapshot ANTES de um import destrutivo (sync ou backup .zip). Falhar aqui
// deve abortar o import: sem rede, não se sobrescreve o banco do usuário.
export function backupBeforeImport(
  db: Database.Database,
  dir: string,
  now: number = Date.now(),
): string {
  return snapshotDb(db, dir, IMPORT_BACKUP_PREFIX, now, IMPORT_BACKUP_KEEP)
}

export function pruneSecretsBackups(dir: string, keep = SECRETS_BACKUP_KEEP): number {
  return pruneBackups(dir, SECRETS_BACKUP_PREFIX, keep)
}

export function removeSecretsBackups(dir: string): number {
  return pruneSecretsBackups(dir, 0)
}

// Recupera as páginas livres para que o texto claro anterior não sobreviva nelas.
// Custa uma reescrita do arquivo inteiro (~50ms num banco de 16 MB) e espaço
// temporário do tamanho do banco — por isso roda só quando a migração de fato
// converteu algo, nunca a cada boot.
export function reclaimFreeSpace(db: Database.Database): {
  ms: number
  freelistBefore: number
} {
  const freelistBefore = db.pragma('freelist_count', {
    simple: true,
  }) as number
  const started = Date.now()
  db.exec('VACUUM')
  // O -wal ainda carrega os frames antigos (com o texto claro) até o checkpoint:
  // limpar só o .db deixaria o segredo no arquivo ao lado.
  db.pragma('wal_checkpoint(TRUNCATE)')
  return { ms: Date.now() - started, freelistBefore }
}
