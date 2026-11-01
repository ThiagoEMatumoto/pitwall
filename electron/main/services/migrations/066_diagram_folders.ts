import type Database from 'better-sqlite3'

export const version = 66
export const name = '066_diagram_folders'

// Pastas do hub de diagramas: mesmo shape de design_folders (065), um nível só.
// O ON DELETE SET NULL é do schema: apagar a pasta devolve os diagramas para
// "sem pasta" sem a store precisar lembrar.
export function up(db: Database.Database): void {
  db.exec(`
    CREATE TABLE diagram_folders (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL CHECK (TRIM(name) <> ''),
      color TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    ALTER TABLE diagrams
      ADD COLUMN folder_id TEXT REFERENCES diagram_folders(id) ON DELETE SET NULL;

    CREATE INDEX idx_diagrams_folder ON diagrams(folder_id);
  `)
}
