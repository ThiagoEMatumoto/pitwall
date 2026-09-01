import type Database from 'better-sqlite3'
import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'
import {
  type BundleManifest,
  type SyncedTable,
  PATH_COLUMNS,
  SYNCED_TABLES,
  TABLE_PRIMARY_KEYS,
  UNPACKAGED_SUFFIX,
  ensureAbsolutePath,
  featuresDir,
  isBundlePath,
  isPathColumnName,
  manifestPath,
  portablizePath,
  stableStringify,
  tableFilePath,
  tablesDir,
} from './bundle-format'

export interface ExportOpts {
  // Raiz dos `.md` de feature. Injetável para teste; default = featuresRoot real.
  // Aceita string ou factory (alinha com a assinatura de feature-store.featuresRoot()).
  featuresRoot?: string | (() => string)
  // Metadados do manifest. Defaults derivam de electron/os quando ausentes.
  appVersion?: string
  machineId?: string
  exportedAt?: number // injetável p/ testes de determinismo; default = Date.now()
  // Raiz absoluta dos projetos NESTA máquina. Paths sob ela viram <CM_ROOT>/...
  // (determinístico entre máquinas). null/ausente = paths exportados ficam
  // absolutos. Injetável p/ teste; produção passa o projectsRoot da sync-config.
  projectsRoot?: string | null
}

function resolveFeaturesRoot(opts?: ExportOpts): string {
  const r = opts?.featuresRoot
  if (typeof r === 'function') return r()
  if (typeof r === 'string') return r
  // default real: featuresRoot() = <userData>/features
  return join(app.getPath('userData'), 'features')
}

function resolveAppVersion(opts?: ExportOpts): string {
  if (opts?.appVersion) return opts.appVersion
  try {
    const v = app.getVersion()
    // Fora do pacote (dev, harness de e2e) `app.getVersion()` devolve a versão
    // do ELECTRON, não a do app — foi o "32.3.3" do bundle envenenado que caiu
    // no repo de sync real. Marcar deixa a origem explícita no manifest.
    return app.isPackaged === false ? `${v}${UNPACKAGED_SUFFIX}` : v
  } catch {
    return 'unknown'
  }
}

// Colunas da tabela na ordem de declaração do schema (PRAGMA table_info).
// Derivar do DB real evita hardcodar colunas e sobrevive a migrations futuras.
function tableColumns(db: Database.Database, table: string): string[] {
  const rows = db.pragma(`table_info(${table})`) as Array<{ name: string }>
  return rows.map((r) => r.name)
}

// O DB do usuário JÁ tem rows contaminadas (o bug gravou path relativo), então
// recusar o export inteiro pararia o sync dele. Reparamos: absolutiza contra a
// raiz local e re-portabiliza (colunas de PATH_COLUMNS voltam a <CM_ROOT>/...).
// Sem raiz utilizável não há reparo honesto — aí sim lança, porque publicar o
// relativo contamina todas as máquinas que puxarem o bundle.
function repairPath(
  table: SyncedTable,
  column: string,
  value: unknown,
  projectsRoot: string | null,
  portable: boolean,
): unknown {
  const abs = ensureAbsolutePath(value, projectsRoot)
  if (abs.unresolved) {
    throw new Error(
      `[sync] recusa exportar path não-absoluto: ${table}.${column}=${String(value)}`,
    )
  }
  const fixed = portable ? portablizePath(abs.value, projectsRoot) : abs.value
  console.warn(
    `[sync] path relativo reparado no export: ${table}.${column}: ` +
      `${String(value)} → ${String(fixed)}`,
  )
  return fixed
}

// Serializa uma tabela como .ndjson determinístico: SELECT * ORDER BY <pk>, cada
// row é um objeto {coluna: valor} serializado com stableStringify (chaves
// ordenadas), uma por linha, com \n final.
//
// Nenhuma coluna de path sai NÃO-absoluta e NÃO-portável: um DB contaminado (o
// bug do path relativo) não pode virar bundle publicado — quem importa não tem
// como saber que o relativo é lixo, e o estrago se espalha pra todas as
// máquinas. Ver repairPath para o que acontece com o valor contaminado.
function buildTable(
  db: Database.Database,
  table: SyncedTable,
  projectsRoot: string | null,
): string {
  const cols = tableColumns(db, table)
  const pk = TABLE_PRIMARY_KEYS[table]
  const orderBy = pk.map((c) => `"${c}" ASC`).join(', ')
  const rows = db.prepare(`SELECT * FROM "${table}" ORDER BY ${orderBy}`).all() as Array<
    Record<string, unknown>
  >
  const pathCols = new Set(PATH_COLUMNS[table] ?? [])

  const lines = rows.map((row) => {
    // Reconstrói o objeto na ordem de colunas do schema (stableStringify
    // reordena alfabeticamente de qualquer forma; isto só garante presença das
    // colunas mesmo quando o valor é null/undefined no driver).
    const obj: Record<string, unknown> = {}
    for (const c of cols) {
      const v = row[c] ?? null
      // Paths sob a raiz desta máquina viram <CM_ROOT>/... → portáveis entre
      // máquinas (some do diff). NULL passa intacto (portablizePath é no-op).
      const out = pathCols.has(c) ? portablizePath(v, projectsRoot) : v
      obj[c] = isPathColumnName(c) && !isBundlePath(out)
        ? repairPath(table, c, out, projectsRoot, pathCols.has(c))
        : out
    }
    return stableStringify(obj)
  })

  return lines.length ? lines.join('\n') + '\n' : ''
}

// Copia os `.md` de <featuresRoot>/<projectId>/<slug>.md para o bundle,
// podando órfãos: o conteúdo de features/ no bundle passa a refletir EXATAMENTE
// o disco de origem (arquivos que não existem mais são removidos do bundle).
function copyFeatures(bundleDir: string, srcRoot: string): void {
  const destRoot = featuresDir(bundleDir)
  mkdirSync(destRoot, { recursive: true })

  // 1. Coletar os .md de origem (<srcRoot>/<projectId>/<slug>.md).
  const wanted = new Set<string>() // caminhos relativos "projectId/slug.md"
  if (existsSync(srcRoot)) {
    for (const projectId of readdirSync(srcRoot, { withFileTypes: true })) {
      if (!projectId.isDirectory()) continue
      const projDir = join(srcRoot, projectId.name)
      for (const entry of readdirSync(projDir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith('.md')) continue
        const rel = join(projectId.name, entry.name)
        wanted.add(rel)
        const destDir = join(destRoot, projectId.name)
        mkdirSync(destDir, { recursive: true })
        writeFileSync(join(destRoot, rel), readFileSync(join(projDir, entry.name)))
      }
    }
  }

  // 2. Podar órfãos do bundle (presentes no destino mas ausentes na origem).
  for (const projectId of readdirSync(destRoot, { withFileTypes: true })) {
    if (!projectId.isDirectory()) continue
    const projDir = join(destRoot, projectId.name)
    for (const entry of readdirSync(projDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue
      const rel = join(projectId.name, entry.name)
      if (!wanted.has(rel)) rmSync(join(projDir, entry.name))
    }
    // Remove diretório de projeto vazio remanescente.
    if (readdirSync(projDir).length === 0) rmSync(projDir, { recursive: true })
  }
}

function maxSchemaVersion(db: Database.Database): number {
  const row = db.prepare('SELECT MAX(version) AS v FROM _migrations').get() as { v: number | null }
  return row.v ?? 0
}

// Exporta o estado sincronizável do DB para um bundle determinístico em
// <bundleDir>. Idempotente em conteúdo de dados: exportar 2× sem mutação produz
// arquivos byte-idênticos (exceto exportedAt no manifest, isolado de propósito).
export function exportBundle(
  db: Database.Database,
  bundleDir: string,
  opts?: ExportOpts,
): BundleManifest {
  // Garante que o WAL foi aplicado ao .db antes de ler (relevante quando o
  // mesmo processo escreveu há pouco). TRUNCATE encolhe o -wal.
  db.pragma('wal_checkpoint(TRUNCATE)')

  mkdirSync(tablesDir(bundleDir), { recursive: true })

  const projectsRoot = opts?.projectsRoot ?? null
  // Serializa TODAS as tabelas antes de gravar qualquer uma: se a guarda de
  // path lançar na 5ª tabela, o bundle não fica meio-atualizado no disco (o
  // working tree do git-sync é reusado entre exports).
  const contents = SYNCED_TABLES.map(
    (table) => [table, buildTable(db, table, projectsRoot)] as const,
  )
  for (const [table, content] of contents) {
    writeFileSync(tableFilePath(bundleDir, table), content, 'utf8')
  }

  copyFeatures(bundleDir, resolveFeaturesRoot(opts))

  const manifest: BundleManifest = {
    schemaVersion: maxSchemaVersion(db),
    appVersion: resolveAppVersion(opts),
    exportedAt: opts?.exportedAt ?? Date.now(),
    machineId: opts?.machineId ?? hostname(),
    hostname: hostname(),
  }
  writeFileSync(manifestPath(bundleDir), stableStringify(manifest) + '\n', 'utf8')

  return manifest
}
