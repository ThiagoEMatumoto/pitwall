import { join } from 'node:path'

// ---- Bundle layout ----
//
// <bundleDir>/manifest.json            metadata (schemaVersion + único campo volátil exportedAt)
// <bundleDir>/tables/<tabela>.ndjson   SELECT * ORDER BY <pk>, 1 row/linha, stableStringify, \n final
// <bundleDir>/features/<projectId>/<slug>.md   cópia verbatim dos .md (corpo = fonte de verdade)

export const MANIFEST_FILE = 'manifest.json'
export const TABLES_DIR = 'tables'
export const FEATURES_DIR = 'features'

export function manifestPath(bundleDir: string): string {
  return join(bundleDir, MANIFEST_FILE)
}

export function tablesDir(bundleDir: string): string {
  return join(bundleDir, TABLES_DIR)
}

export function tableFilePath(bundleDir: string, table: string): string {
  return join(bundleDir, TABLES_DIR, `${table}.ndjson`)
}

export function featuresDir(bundleDir: string): string {
  return join(bundleDir, FEATURES_DIR)
}

// ---- Tabelas sincronizadas, em ORDEM DE FK (pais antes de filhos) ----
//
// Derivado das migrations reais (001_init, 007_features, 011_objectives,
// 012_tasks, 013_feature_links):
//   projects            (raiz)
//   repos               → projects
//   repo_dependencies   → repos, repos  (PK id; UNIQUE from,to,kind — migration 017)
//   features            → projects
//   feature_repos       → features, repos
//   objectives          → objectives (self, parent_objective_id)  [pai antes do filho via ordenação por created_at; ver nota]
//   key_results         → objectives
//   tasks               (sem FK)
//   task_links          → tasks  (parent_id polimórfico, sem FK)
//   feature_links       → features  (target_id polimórfico, sem FK)
//   feature_pulses         → features  (migration 042)
//   feature_ledger         → features  (PK composta feature_id,entry_id)
//   feature_metrics        → features  (PK composta feature_id,column_key)
//   feature_metric_points  → feature_metrics  (FK COMPOSTA feature_id,column_key)
//
// As tabelas EXCLUÍDAS (machine-local/derivado) NÃO entram aqui:
//   _migrations, metrics_session_cache, sessions, feature_session_records,
//   workspace_state, layouts, app_prefs.
//
// Nota sobre objectives self-FK (parent_objective_id REFERENCES objectives
// ON DELETE SET NULL): no INSERT em massa o import roda com foreign_keys=OFF,
// então a auto-referência não precisa de ordenação topológica entre rows — o
// foreign_key_check no fim valida a integridade.
export const SYNCED_TABLES = [
  'projects',
  'repos',
  'repo_dependencies',
  'features',
  'feature_repos',
  'objectives',
  'key_results',
  'tasks',
  'task_links',
  'feature_links',
  // feature_metric_points depende de feature_metrics por FK COMPOSTA, então vem
  // depois dela: o importer insere nesta ordem e deleta na inversa.
  'feature_pulses',
  'feature_ledger',
  'feature_metrics',
  'feature_metric_points',
] as const

export type SyncedTable = (typeof SYNCED_TABLES)[number]

// Primary keys por tabela, na ordem da declaração (usado no ORDER BY do export
// para um dump determinístico e diff-friendly). Derivado das migrations reais.
export const TABLE_PRIMARY_KEYS: Record<SyncedTable, readonly string[]> = {
  projects: ['id'],
  repos: ['id'],
  repo_dependencies: ['id'],
  features: ['id'],
  feature_repos: ['feature_id', 'repo_id'],
  objectives: ['id'],
  key_results: ['id'],
  tasks: ['id'],
  task_links: ['task_id', 'parent_type', 'parent_id'],
  feature_links: ['feature_id', 'target_type', 'target_id'],
  feature_pulses: ['id'],
  feature_ledger: ['feature_id', 'entry_id'],
  feature_metrics: ['feature_id', 'column_key'],
  feature_metric_points: ['id'],
}

// Conjunto para checagem rápida "essa tabela é sincronizada?".
export const SYNCED_TABLE_SET: ReadonlySet<string> = new Set(SYNCED_TABLES)

// ---- Portabilidade de paths (raiz por máquina) ----
//
// Três colunas guardam paths ABSOLUTOS que quebram entre máquinas (Linux ↔ Mac).
// No export, paths sob a raiz desta máquina viram um sentinela portável; no
// import, o sentinela é resolvido contra a raiz LOCAL. Paths fora da raiz (ou
// quando não há raiz configurada) ficam absolutos — backward-compat com bundles
// legados (todos absolutos) é preservada.
export const ROOT_SENTINEL = '<CM_ROOT>'

// Colunas de path por tabela, derivadas do schema real (vault_path / path /
// worktree_path). Só estas recebem portablize/localize.
export const PATH_COLUMNS: Partial<Record<SyncedTable, readonly string[]>> = {
  projects: ['vault_path'],
  repos: ['path'],
  feature_repos: ['worktree_path'],
}

// Colunas de `repos` que sincronizam VERBATIM (migration 027): `remote_url` e
// `default_branch` são machine-independent e DEVEM ser copiadas sem tocar — por
// isso ficam FORA de PATH_COLUMNS (nada de <CM_ROOT>). O exporter usa SELECT * +
// PRAGMA table_info, então elas já entram no bundle automaticamente; esta nota
// documenta a decisão e serve de âncora contra alguém portabilizá-las por engano.


// Remove uma única barra final de `p` (mantém intacto se já não tiver). Usado
// para normalizar a raiz antes de comparar/cortar — evita `//` no resultado e
// trata `root` com ou sem `/` final de forma idêntica.
function stripTrailingSlash(p: string): string {
  return p.endsWith('/') ? p.slice(0, -1) : p
}

// Converte um path absoluto em portável (sentinela) SE estiver sob `root`.
//  - NULL → NULL (campos opcionais como worktree_path/vault_path passam intactos).
//  - root vazio/null → retorna `abs` inalterado (máquina sem raiz configurada).
//  - abs === root (path é a própria raiz) → ROOT_SENTINEL.
//  - abs sob root (abs começa com `root/`) → ROOT_SENTINEL + resto (com `/`).
//  - senão → `abs` inalterado (path fora da raiz fica absoluto).
export function portablizePath(abs: unknown, root: string | null | undefined): unknown {
  if (typeof abs !== 'string' || abs.length === 0) return abs
  if (!root) return abs
  const r = stripTrailingSlash(root)
  if (abs === r) return ROOT_SENTINEL
  const prefix = r + '/'
  if (abs.startsWith(prefix)) {
    return ROOT_SENTINEL + abs.slice(r.length) // mantém a `/` inicial do resto
  }
  return abs
}

// Inverte portablizePath usando a raiz LOCAL desta máquina.
//  - NULL → NULL.
//  - começa com ROOT_SENTINEL:
//      * root definido → root (sem barra final) + resto.
//      * root NÃO definido → best-effort: retorna o resto sem o sentinela
//        (path relativo "resto/..."), o que é claramente quebrado mas evita
//        manter o sentinela cru no DB. Sinaliza via `unresolved`.
//  - senão (path absoluto legado) → inalterado.
export function localizePath(
  stored: unknown,
  root: string | null | undefined,
): { value: unknown; unresolved: boolean } {
  if (typeof stored !== 'string' || stored.length === 0) {
    return { value: stored, unresolved: false }
  }
  if (!stored.startsWith(ROOT_SENTINEL)) {
    return { value: stored, unresolved: false }
  }
  const rest = stored.slice(ROOT_SENTINEL.length) // ex: '/repo/x' ou '' (raiz exata)
  if (!root) {
    // Sem raiz local: remove o sentinela (best-effort). `rest` começa com `/`
    // ou é vazio; tiramos a barra inicial pra não virar um absoluto enganoso.
    return { value: rest.startsWith('/') ? rest.slice(1) : rest, unresolved: true }
  }
  return { value: stripTrailingSlash(root) + rest, unresolved: false }
}

// ---- Serialização determinística ----

// JSON com chaves ordenadas alfabeticamente (em qualquer profundidade), sem
// pretty-print. Determinismo é o que mantém o diff git limpo: a mesma row vira
// sempre a mesma linha de texto.
export function stableStringify(value: unknown): string {
  return JSON.stringify(value, sortedReplacer(value))
}

// Replacer que reordena as chaves de cada objeto plano. JSON.stringify chama o
// replacer com o valor JÁ resolvido; reconstruímos cada objeto com chaves
// ordenadas para que a serialização final seja estável.
function sortedReplacer(_root: unknown): (key: string, value: unknown) => unknown {
  return function (this: unknown, _key: string, value: unknown): unknown {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const obj = value as Record<string, unknown>
      const sorted: Record<string, unknown> = {}
      for (const k of Object.keys(obj).sort()) {
        sorted[k] = obj[k]
      }
      return sorted
    }
    return value
  }
}

// ---- Manifest ----

export interface BundleManifest {
  schemaVersion: number
  appVersion: string
  exportedAt: number // ÚNICO campo volátil — isolado aqui para não poluir o diff dos dados
  machineId: string
  hostname: string
}
