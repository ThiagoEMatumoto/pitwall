import type Database from 'better-sqlite3'
import { app } from 'electron'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { markSelfWrite, startFeatureWatcher, stopFeatureWatcher } from '../feature-store'
import {
  type BundleManifest,
  type SyncedTable,
  PATH_COLUMNS,
  UNPACKAGED_SUFFIX,
  SYNCED_TABLES,
  TABLE_PRIMARY_KEYS,
  ensureAbsolutePath,
  featuresDir,
  localizePath,
  manifestPath,
  tableFilePath,
} from './bundle-format'

export interface ImportResult {
  // Quantos paths <CM_ROOT>/... não puderam ser resolvidos (sem projectsRoot
  // local). >0 sinaliza que a UI deve pedir a configuração da pasta-raiz.
  unresolvedPaths: number
}

export interface ImportOpts {
  // Raiz local dos `.md` (destino da reconciliação). Injetável p/ teste.
  featuresRoot?: string | (() => string)
  // Watcher hooks injetáveis (default = feature-store reais). Em teste passamos
  // no-ops para evitar tocar no chokidar/electron real.
  stopWatcher?: () => void
  startWatcher?: () => void
  markSelfWrite?: (path: string) => void
  // Indica se o watcher estava ativo (para reiniciar no finally). Default false.
  watcherWasActive?: boolean
  // Raiz absoluta dos projetos NESTA máquina. Paths <CM_ROOT>/... do bundle são
  // resolvidos contra ela (portabilidade cross-root). null/ausente = sentinela
  // resolvido best-effort (path relativo). Paths absolutos legados passam
  // intactos. Injetável p/ teste; produção passa o projectsRoot da sync-config.
  projectsRoot?: string | null
}

function resolveFeaturesRoot(opts?: ImportOpts): string {
  const r = opts?.featuresRoot
  if (typeof r === 'function') return r()
  if (typeof r === 'string') return r
  return join(app.getPath('userData'), 'features')
}

// Raiz local do vault (app_prefs.vault_root, machine-local, fora do sync).
// Fallback do importer quando o bundle traz path portável e não há projectsRoot
// configurado: absolutizar contra o vault é melhor que gravar path relativo.
// Só a pref EXPLÍCITA conta — nada do default ~/ClaudeManager aqui (chutar a
// raiz fabricaria paths inexistentes; preservar o row local é mais seguro).
function localVaultRoot(db: Database.Database): string | null {
  try {
    const row = db.prepare('SELECT value FROM app_prefs WHERE key = ?').get('vault_root') as
      | { value?: string }
      | undefined
    return row?.value?.trim() || null
  } catch {
    return null
  }
}

function localSchemaVersion(db: Database.Database): number {
  const row = db.prepare('SELECT MAX(version) AS v FROM _migrations').get() as { v: number | null }
  return row.v ?? 0
}

// Valida o manifest ANTES de qualquer escrita. Além do schemaVersion, checa a
// PROCEDÊNCIA do bundle: um run fora do pacote (dev/harness de e2e) já publicou
// um bundle no repo de sync real e contaminou o banco de todas as máquinas.
function readManifest(bundleDir: string): { schemaVersion: number } {
  const raw = readFileSync(manifestPath(bundleDir), 'utf8')
  const parsed = JSON.parse(raw) as Partial<BundleManifest>
  if (typeof parsed.schemaVersion !== 'number') {
    throw new Error('[sync] manifest inválido: schemaVersion ausente')
  }
  const appVersion = parsed.appVersion
  if (typeof appVersion !== 'string' || appVersion.trim().length === 0) {
    throw new Error('[sync] manifest inválido: appVersion ausente ou vazio')
  }
  if (typeof parsed.machineId !== 'string' || parsed.machineId.trim().length === 0) {
    throw new Error('[sync] manifest inválido: machineId ausente ou vazio')
  }
  // Duas assinaturas do MESMO caso (export feito fora do app empacotado):
  //  - appVersion == versão do Electron: `app.getVersion()` sem pacote devolve
  //    a versão do Electron (foi o "32.3.3" do bundle envenenado).
  //  - sufixo -unpackaged: a marca que o exporter passou a gravar.
  const electronVersion = process.versions.electron
  if (appVersion.endsWith(UNPACKAGED_SUFFIX) || (electronVersion && appVersion === electronVersion)) {
    throw new Error(
      `[sync] bundle recusado: appVersion "${appVersion}" indica export fora ` +
        'do app empacotado (dev/teste) — não é estado de usuário',
    )
  }
  return { schemaVersion: parsed.schemaVersion }
}

function tableColumns(db: Database.Database, table: string): string[] {
  const rows = db.pragma(`table_info(${table})`) as Array<{ name: string }>
  return rows.map((r) => r.name)
}

// Lê um .ndjson em array de objetos. Linhas vazias são ignoradas (tabela vazia
// => arquivo vazio ou só com \n).
//
// Devolve `null` quando o ARQUIVO NÃO EXISTE — e essa distinção é o ponto: o
// exporter escreve SEMPRE um arquivo por tabela que conhece (inclusive vazio),
// então arquivo ausente significa inequivocamente "a versão que exportou este
// bundle não conhece esta tabela", e não "a tabela está vazia lá". Ver
// importBundle para o que fazemos com cada caso.
function readTable(bundleDir: string, table: SyncedTable): Array<Record<string, unknown>> | null {
  const path = tableFilePath(bundleDir, table)
  if (!existsSync(path)) return null
  const raw = readFileSync(path, 'utf8')
  const lines = raw.split('\n').filter((l) => l.trim().length > 0)
  return lines.map((l) => JSON.parse(l) as Record<string, unknown>)
}

interface FkViolation {
  table: string
  rowid: number | null
  parent: string
  fkid: number
}

// Apaga, SÓ das tabelas em `tables`, as linhas que o foreign_key_check acusa
// como órfãs. Usado nas tabelas preservadas (ausentes do bundle): o pai delas
// pode ter sumido no replace-all — ex.: uma feature que só existia aqui é
// substituída pelo conjunto do bundle — e a linha filha segue o pai, exatamente
// como o ON DELETE CASCADE do schema faria. Repete porque apagar uma linha pode
// orfanar outra (feature_metrics → feature_metric_points); o teto evita laço
// infinito caso algo não convirja.
function dropOrphansIn(db: Database.Database, tables: ReadonlySet<string>): void {
  for (let pass = 0; pass <= tables.size; pass++) {
    const violations = db.pragma('foreign_key_check') as FkViolation[]
    const orphans = violations.filter((v) => tables.has(v.table) && v.rowid !== null)
    if (orphans.length === 0) return
    for (const v of orphans) {
      db.prepare(`DELETE FROM "${v.table}" WHERE rowid = ?`).run(v.rowid)
    }
  }
}

// Reconcilia os `.md`: sobrescreve cada arquivo do bundle no destino local
// (via markSelfWrite para o watcher ignorar) e remove os `.md` locais que não
// existem no bundle. Replace-all => idempotente.
function reconcileFeatures(
  bundleDir: string,
  destRoot: string,
  mark: (path: string) => void,
): void {
  const srcRoot = featuresDir(bundleDir)
  mkdirSync(destRoot, { recursive: true })

  const wanted = new Set<string>() // "projectId/slug.md"

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
        const destPath = join(destRoot, rel)
        mark(destPath)
        writeFileSync(destPath, readFileSync(join(projDir, entry.name)))
      }
    }
  }

  // Remove .md locais ausentes no bundle.
  if (existsSync(destRoot)) {
    for (const projectId of readdirSync(destRoot, { withFileTypes: true })) {
      if (!projectId.isDirectory()) continue
      const projDir = join(destRoot, projectId.name)
      for (const entry of readdirSync(projDir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith('.md')) continue
        const rel = join(projectId.name, entry.name)
        if (!wanted.has(rel)) {
          const p = join(projDir, entry.name)
          mark(p)
          rmSync(p)
        }
      }
      if (readdirSync(projDir).length === 0) rmSync(projDir, { recursive: true })
    }
  }
}

// Importa um bundle, substituindo TODO o estado sincronizável local
// (last-writer-wins, replace-all). Idempotente: rodar 2× = mesmo estado.
//
// Sequência:
//   1. valida schema (manifest vs MAX(_migrations) local; bundle MAIOR => erro)
//   2. pausa watcher
//   3. foreign_keys = OFF
//   4. transação: DELETE em ordem REVERSA de FK; INSERT em ordem de FK;
//      tabelas AUSENTES do bundle ficam de fora dos dois loops (preservadas);
//      foreign_key_check DENTRO da tx (viola → throw → ROLLBACK automático,
//      dados locais preservados)
//   5. reconcilia .md (sobrescreve via markSelfWrite, remove órfãos) — SÓ após
//      a tx ter sucesso
//   6. finally: foreign_keys = ON, reinicia watcher
export function importBundle(
  db: Database.Database,
  bundleDir: string,
  opts?: ImportOpts,
): ImportResult {
  const stop = opts?.stopWatcher ?? stopFeatureWatcher
  const start = opts?.startWatcher ?? startFeatureWatcher
  const mark = opts?.markSelfWrite ?? markSelfWrite
  const projectsRoot = opts?.projectsRoot ?? null
  // Raiz de fallback p/ absolutizar paths que localizePath não resolveu:
  // projectsRoot (sync-config) > vault_root local (app_prefs).
  const fallbackRoot = projectsRoot ?? localVaultRoot(db)
  const localFeaturesRoot = resolveFeaturesRoot(opts)

  const { schemaVersion } = readManifest(bundleDir)
  const local = localSchemaVersion(db)
  if (schemaVersion > local) {
    throw new Error(
      `[sync] bundle com schemaVersion ${schemaVersion} > local ${local}: ` +
        'app desatualizado, atualize antes de importar',
    )
  }

  stop()

  // Pré-lê todas as tabelas ANTES de mexer no DB (falha de parse aborta sem
  // deixar o DB num estado parcial).
  const tableData = new Map<SyncedTable, Array<Record<string, unknown>> | null>()
  for (const table of SYNCED_TABLES) {
    tableData.set(table, readTable(bundleDir, table))
  }

  // Tabela SEM arquivo no bundle é PRESERVADA (nem DELETE nem INSERT): quem
  // exportou roda uma versão anterior, que sequer conhece a tabela, então o
  // replace-all não tem o que dizer sobre ela. Sem esta distinção, importar um
  // bundle de uma máquina desatualizada apagava os dados locais dessas tabelas
  // — o DELETE rodava e o INSERT não tinha linha nenhuma para repor (perda
  // silenciosa). Arquivo PRESENTE e vazio é o caso oposto: a tabela está mesmo
  // vazia na origem e deve ser limpa aqui, como sempre.
  const inBundle: ReadonlySet<SyncedTable> = new Set(
    SYNCED_TABLES.filter((t) => tableData.get(t) !== null),
  )
  const preserved: ReadonlySet<string> = new Set(SYNCED_TABLES.filter((t) => !inBundle.has(t)))

  // Snapshot dos paths locais ATUAIS (por PK) das tabelas com colunas de path
  // que o replace-all vai substituir: se o bundle trouxer um path que não dá
  // pra absolutizar (sem raiz local), preservamos o valor do row local em vez
  // de sobrescrevê-lo com um relativo quebrado.
  const existingPaths = new Map<SyncedTable, Map<string, Record<string, unknown>>>()
  for (const table of SYNCED_TABLES) {
    if (!inBundle.has(table)) continue
    const cols = PATH_COLUMNS[table]
    if (!cols || cols.length === 0) continue
    const pks = TABLE_PRIMARY_KEYS[table]
    const select = [...pks, ...cols].map((c) => `"${c}"`).join(', ')
    const byKey = new Map<string, Record<string, unknown>>()
    const rows = db.prepare(`SELECT ${select} FROM "${table}"`).all() as Array<
      Record<string, unknown>
    >
    for (const r of rows) {
      byKey.set(pks.map((k) => String(r[k])).join('\u0000'), r)
    }
    existingPaths.set(table, byKey)
  }

  let unresolvedPaths = 0

  db.pragma('foreign_keys = OFF')
  try {
    const tx = db.transaction(() => {
      // DELETE em ordem reversa de FK (filhos antes de pais).
      for (const table of [...SYNCED_TABLES].reverse()) {
        if (!inBundle.has(table)) continue
        db.prepare(`DELETE FROM "${table}"`).run()
      }
      // INSERT em ordem de FK (pais antes de filhos).
      for (const table of SYNCED_TABLES) {
        const rows = tableData.get(table)
        if (!rows || rows.length === 0) continue
        const cols = tableColumns(db, table)
        const pathCols = new Set(PATH_COLUMNS[table] ?? [])
        const placeholders = cols.map((c) => `@${c}`).join(', ')
        const colList = cols.map((c) => `"${c}"`).join(', ')
        const ins = db.prepare(`INSERT INTO "${table}" (${colList}) VALUES (${placeholders})`)
        const pks = TABLE_PRIMARY_KEYS[table]
        for (const row of rows) {
          const rowKey = pks.map((k) => String(row[k])).join('\u0000')
          const params: Record<string, unknown> = {}
          for (const c of cols) {
            const v = row[c] ?? null
            if (pathCols.has(c)) {
              // <CM_ROOT>/... → resolve contra a raiz LOCAL; absoluto legado passa
              // intacto; NULL intacto. ensureAbsolutePath garante que NUNCA
              // persistimos path relativo: sem projectsRoot, absolutiza contra o
              // vault_root local; sem raiz nenhuma, preserva o valor do row local
              // pré-import (se absoluto). Preservado/irrecuperável conta em
              // unresolvedPaths (a UI segue pedindo a configuração da raiz).
              const localized = localizePath(v, projectsRoot)
              const existing = existingPaths.get(table)?.get(rowKey)?.[c]
              const r = ensureAbsolutePath(localized.value, fallbackRoot, existing)
              if (r.unresolved) unresolvedPaths++
              params[c] = r.value
            } else {
              params[c] = v
            }
          }
          // features.doc_path é absoluto sob <userData>/features (FORA da
          // <CM_ROOT>), então não está em PATH_COLUMNS — recomputamos a partir
          // da raiz de features LOCAL + project_id + slug, em vez de gravar o
          // path da máquina de origem (que apontaria pro userData dela).
          if (table === 'features') {
            params.doc_path = join(
              localFeaturesRoot,
              String(row.project_id),
              `${String(row.slug)}.md`,
            )
          }
          ins.run(params)
        }
      }
      // Linha preservada cujo pai sumiu no replace-all vira órfã: apagamos antes
      // do check (mesmo efeito do CASCADE). Violação em tabela VINDA do bundle
      // continua sendo erro — bundle corrompido não deve virar delete silencioso.
      if (preserved.size > 0) dropOrphansIn(db, preserved)

      // FK check DENTRO da tx: violação → throw → ROLLBACK automático (o DELETE
      // não é commitado, dados locais ficam intactos). Funciona com o pragma OFF.
      const violations = db.pragma('foreign_key_check') as unknown[]
      if (violations.length > 0) {
        throw new Error(
          `[sync] import deixou ${violations.length} violação(ões) de FK: ` +
            JSON.stringify(violations.slice(0, 5)),
        )
      }
    })
    tx()

    // Só após a tx ter sucesso (se lançou, os .md locais ficam intactos).
    reconcileFeatures(bundleDir, localFeaturesRoot, mark)
  } finally {
    db.pragma('foreign_keys = ON')
    if (opts?.watcherWasActive) start()
  }

  if (unresolvedPaths > 0) {
    console.warn(
      `[sync] import: ${unresolvedPaths} caminho(s) não resolvido(s) — ` +
        'configure a pasta-raiz dos projetos para resolver paths portáveis.',
    )
  }

  return { unresolvedPaths }
}
