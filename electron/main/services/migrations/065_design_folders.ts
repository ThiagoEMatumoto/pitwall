import type Database from 'better-sqlite3'

export const version = 65
export const name = '065_design_folders'

// Pastas do hub de designs: um nível só, sem aninhamento.
//
// 1. SQLite aceita REFERENCES em ADD COLUMN desde que o default seja NULL, então
//    o ON DELETE SET NULL é do próprio schema: apagar a pasta devolve os docs
//    para "sem pasta" sem a store precisar lembrar.
// 2. `thumbnail_at` marca quando a thumb foi gerada. É a versão que a UI põe na
//    URL (?v=) — separada de updated_at porque gerar thumb não é editar.
export function up(db: Database.Database): void {
  db.exec(`
    CREATE TABLE design_folders (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL CHECK (TRIM(name) <> ''),
      color TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    ALTER TABLE design_documents
      ADD COLUMN folder_id TEXT REFERENCES design_folders(id) ON DELETE SET NULL;
    ALTER TABLE design_documents ADD COLUMN thumbnail_at INTEGER;

    CREATE INDEX idx_design_documents_folder ON design_documents(folder_id);
  `)
}
