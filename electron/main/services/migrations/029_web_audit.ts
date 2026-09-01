import type Database from 'better-sqlite3'

export const version = 29
export const name = '029_web_audit'

// LEGADO — a feature de jobs agendados foi removida (ver 044_drop_removed_features).
// Esta migration é mantida por ser histórica: o schema descrito abaixo já não existe
// e os símbolos citados (resolveJobAllowedTools, runner) foram deletados do código.
//
// Web-audit jobs (Fase 1). Um 2º kind de job além de 'critique': em vez de criticar
// código/texto, dirige um browser (Playwright) contra uma URL e mede desempenho +
// usabilidade. Retrocompatível: rows existentes viram 'critique' (o default).
//
// - scheduled_jobs.kind: discriminador 'critique' | 'web-audit'. NOT NULL DEFAULT
//   'critique' → jobs já criados continuam válidos sem backfill. O runner usa o kind
//   para liberar as browser tools (resolveJobAllowedTools) só no web-audit.
// - scheduled_jobs.target_url: URL auditada (nullable — só web-audit preenche).
// - job_runs.metrics_json: métricas estruturadas capturadas do relatório
//   (LCP/TTFB/console/network) como JSON. Nullable — a Fase 2 parseia e grava; por
//   ora a coluna existe para o round-trip do store.
export function up(db: Database.Database): void {
  db.exec(`
    ALTER TABLE scheduled_jobs ADD COLUMN kind TEXT NOT NULL DEFAULT 'critique';
    ALTER TABLE scheduled_jobs ADD COLUMN target_url TEXT;
    ALTER TABLE job_runs ADD COLUMN metrics_json TEXT;
  `)
}
