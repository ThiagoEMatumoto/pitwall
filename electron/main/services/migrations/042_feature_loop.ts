import type Database from 'better-sqlite3'

export const version = 42
export const name = '042_feature_loop'

// Loop da feature: pulso (o que está vivo agora), ledger (o que já mudou) e
// métricas (o que a mudança moveu). Puramente aditiva — nenhuma tabela
// existente é reconstruída, então não precisa de disableForeignKeys.
//
// Decisões que o schema sustenta:
//
// 1. `features.cadence_days` é NULLABLE de propósito: NULL = "usa o default"
//    (14 dias), resolvido em código. Materializar o 14 aqui congelaria o valor
//    nas rows antigas se o default mudar — a feature ficaria com uma cadência
//    que ninguém escolheu.
// 2. `feature_pulses` é APPEND-ONLY e o pulso vigente é derivado por
//    MAX(created_at). NÃO existe coluna `is_current`: flag exige escrita em duas
//    linhas por pulso novo (apagar a antiga, marcar a nova), e qualquer escritor
//    que falhe no meio (IPC, MCP, seed) deixa zero ou dois vigentes. Derivar não
//    tem esse estado inconsistente possível. O índice (feature_id, created_at
//    DESC) é o que torna o MAX barato.
// 3. `feature_pulses.session_id` é nullable e SEM FK: sessões são efêmeras e
//    somem; o pulso que uma delas escreveu permanece como registro histórico.
//    Uma FK aqui apagaria (ou anularia) memória que ainda vale.
// 4. `feature_ledger` tem PK COMPOSTA (feature_id, entry_id): o índice e o corpo
//    da entrada vivem na mesma linha. `entry_id` é o id textual estável escolhido
//    por quem escreve; o CHECK aqui só limita comprimento — a validação de
//    FORMATO (^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$) fica no store, porque regex em
//    CHECK do SQLite exigiria a extensão REGEXP.
// 5. `feature_metric_points` referencia `feature_metrics` por FK COMPOSTA
//    (feature_id, column_key): é o que impede ponto de série órfão, sem coluna
//    declarada. A PK composta de `feature_metrics` é o índice único que essa FK
//    exige. O cascade de `features` chega aqui em dois saltos (features →
//    feature_metrics → feature_metric_points), que o SQLite propaga.
export function up(db: Database.Database): void {
  db.exec(`
    ALTER TABLE features ADD COLUMN cadence_days INTEGER;
    ALTER TABLE features ADD COLUMN loop_export INTEGER NOT NULL DEFAULT 1;

    CREATE TABLE feature_pulses (
      id         TEXT PRIMARY KEY,
      feature_id TEXT NOT NULL REFERENCES features(id) ON DELETE CASCADE,
      body       TEXT NOT NULL CHECK (TRIM(body) <> ''),
      source     TEXT NOT NULL CHECK (source IN ('human', 'session', 'mcp', 'seed')),
      session_id TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX idx_feature_pulses_feature_created
      ON feature_pulses(feature_id, created_at DESC);

    CREATE TABLE feature_ledger (
      feature_id  TEXT NOT NULL REFERENCES features(id) ON DELETE CASCADE,
      entry_id    TEXT NOT NULL CHECK (length(entry_id) BETWEEN 1 AND 80),
      kind        TEXT,
      title       TEXT NOT NULL,
      body        TEXT CHECK (body IS NULL OR length(body) <= 81920),
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL,
      archived_at INTEGER,
      PRIMARY KEY (feature_id, entry_id)
    );
    CREATE INDEX idx_feature_ledger_feature_created
      ON feature_ledger(feature_id, created_at DESC);

    CREATE TABLE feature_metrics (
      feature_id  TEXT NOT NULL REFERENCES features(id) ON DELETE CASCADE,
      column_key  TEXT NOT NULL,
      label       TEXT,
      unit        TEXT,
      target      REAL,
      floor       REAL,
      baseline    REAL,
      direction   TEXT CHECK (direction IS NULL OR direction IN ('increase', 'decrease', 'maintain')),
      is_headline INTEGER NOT NULL DEFAULT 0,
      alarm       INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (feature_id, column_key)
    );

    CREATE TABLE feature_metric_points (
      id         TEXT PRIMARY KEY,
      feature_id TEXT NOT NULL,
      column_key TEXT NOT NULL,
      at         INTEGER NOT NULL,
      value      REAL,
      note       TEXT,
      UNIQUE (feature_id, column_key, at),
      FOREIGN KEY (feature_id, column_key)
        REFERENCES feature_metrics(feature_id, column_key) ON DELETE CASCADE
    );
  `)
}
