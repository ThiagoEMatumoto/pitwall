import type Database from "better-sqlite3";
import * as init from "./001_init";
import * as vault from "./002_vault";
import * as workspacePanes from "./003_workspace_panes";
import * as dockLayout from "./004_dock_layout";
import * as metrics from "./005_metrics";
import * as metricsCwd from "./006_metrics_cwd";
import * as features from "./007_features";
import * as metricsOrchestration from "./008_metrics_orchestration";
import * as projectPosition from "./009_project_position";
import * as featureSessionRecords from "./010_feature_session_records";
import * as objectives from "./011_objectives";
import * as tasks from "./012_tasks";
import * as featureLinks from "./013_feature_links";
import * as sessionsRepoNullable from "./014_sessions_repo_nullable";
import * as featureOrigin from "./015_feature_origin";
import * as metricsSubagentTurns from "./016_metrics_subagent_turns";
import * as repoDepsCanvas from "./017_repo_deps_canvas";
import * as handoffs from "./018_handoffs";
import * as repoHub from "./019_repo_hub";
import * as handoffModeProgress from "./020_handoff_mode_progress";
import * as handoffPendingQuestion from "./021_handoff_pending_question";
import * as meetings from "./022_meetings";
import * as meetingsCaptureStatus from "./023_meetings_capture_status";
import * as meetingsFts from "./024_meetings_fts";
import * as dossiers from "./025_dossiers";
import * as handoffInstrumentation from "./026_handoff_instrumentation";
import * as repoRemote from "./027_repo_remote";
import * as scheduledJobs from "./028_scheduled_jobs";
import * as webAudit from "./029_web_audit";
import * as sessionsTitleSource from "./030_sessions_title_source";
import * as taskOrigin from "./031_task_origin";
import * as featureAppDev from "./032_feature_app_dev";
import * as repoPullRuns from "./033_repo_pull_runs";
import * as resetRepoDefaultBranch from "./034_reset_repo_default_branch";
import * as contentContracts from "./035_content_contracts";
import * as handoffDismissed from "./036_handoff_dismissed";
import * as handoffPredecessor from "./037_handoff_predecessor";
import * as diagrams from "./038_diagrams";
import * as diagramLibrary from "./039_diagram_library";
import * as serviceProxyCalls from "./040_service_proxy_calls";

interface Migration {
  version: number;
  name: string;
  up(db: Database.Database): void;
  // Migrations que recriam tabela referenciada por FK (DROP+RENAME) precisam de
  // foreign_keys OFF. SQLite ignora o pragma dentro de transação, então o runner
  // o aplica ANTES da transação e valida com foreign_key_check ao religar.
  disableForeignKeys?: boolean;
}

// Exportada pra testes: permite aplicar um prefixo da cadeia (ex: 001-014),
// seedar dados e só então aplicar a migration sob teste.
export const migrations: Migration[] = [
  init,
  vault,
  workspacePanes,
  dockLayout,
  metrics,
  metricsCwd,
  features,
  metricsOrchestration,
  projectPosition,
  featureSessionRecords,
  objectives,
  tasks,
  featureLinks,
  sessionsRepoNullable,
  featureOrigin,
  metricsSubagentTurns,
  repoDepsCanvas,
  handoffs,
  repoHub,
  handoffModeProgress,
  handoffPendingQuestion,
  meetings,
  meetingsCaptureStatus,
  meetingsFts,
  dossiers,
  handoffInstrumentation,
  repoRemote,
  scheduledJobs,
  webAudit,
  sessionsTitleSource,
  taskOrigin,
  featureAppDev,
  repoPullRuns,
  resetRepoDefaultBranch,
  contentContracts,
  handoffDismissed,
  handoffPredecessor,
  diagrams,
  diagramLibrary,
  serviceProxyCalls,
];

export function runMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    )
  `);

  const appliedRows = db
    .prepare("SELECT version FROM _migrations ORDER BY version ASC")
    .all() as Array<{ version: number }>;
  const applied = new Set(appliedRows.map((r) => r.version));

  const pending = migrations
    .filter((m) => !applied.has(m.version))
    .sort((a, b) => a.version - b.version);

  if (pending.length === 0) return;

  const insert = db.prepare(
    "INSERT INTO _migrations (version, name, applied_at) VALUES (?, ?, ?)",
  );

  for (const m of pending) {
    const tx = db.transaction(() => {
      m.up(db);
      insert.run(m.version, m.name, Date.now());
    });
    if (m.disableForeignKeys) {
      db.pragma("foreign_keys = OFF");
      try {
        tx();
      } finally {
        db.pragma("foreign_keys = ON");
      }
      const violations = db.pragma("foreign_key_check") as unknown[];
      if (violations.length > 0) {
        throw new Error(
          `[db] migration ${m.name} left ${violations.length} foreign key violation(s): ` +
            JSON.stringify(violations.slice(0, 5)),
        );
      }
    } else {
      tx();
    }
    console.log(`[db] migration applied: ${m.name}`);
  }
}
