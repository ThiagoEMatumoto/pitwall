import type Database from 'better-sqlite3'

export const version = 46
export const name = '046_design_studio'

// Design Studio: documentos → páginas → artboards, cada artboard com a árvore
// JSON canônica em TEXT (HTML é projeção, não fonte). Molde de 038_diagrams.
//
// INVARIANTES declaradas aqui porque é o schema que as sustenta:
//
// 1. `design_artboards.tree` é a CABEÇA MUTÁVEL; `design_versions` é
//    APPEND-ONLY — um snapshot íntegro da árvore por linha. Restaurar copia o
//    snapshot pra cabeça e grava versão NOVA (git-revert, nunca reset).
// 2. `version` na cabeça é monotônico e sobe em TODA mutação da árvore (o
//    cliente manda baseVersion e divergência é resync). Só mutações com
//    snapshot=true geram linha em design_versions — logo versions têm lacunas.
// 3. O store retém no máximo 30 snapshots por artboard (apaga os mais
//    antigos no bump). Política de retenção mora no store, não no schema.
// 4. Apagar documento cascateia páginas → artboards → versões, e também
//    assets e links (FK ON DELETE CASCADE). Não existe órfão.
// 5. `design_assets.document_id` NULL = asset compartilhado entre documentos.
//    Dedupe por sha256 é por escopo (doc ou pool compartilhado), daí o índice
//    único sobre COALESCE(document_id, '').
// 6. `design_links` liga um documento a N parents (PK composta impede
//    duplicata); o índice invertido torna barato "quais designs desta feature".
export function up(db: Database.Database): void {
  db.exec(`
    CREATE TABLE design_documents (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL CHECK (TRIM(title) <> ''),
      status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'archived')),
      tokens TEXT NOT NULL DEFAULT '{}',
      fonts TEXT NOT NULL DEFAULT '[]',
      global_css TEXT NOT NULL DEFAULT '',
      thumbnail TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX idx_design_documents_status ON design_documents(status, updated_at DESC);

    CREATE TABLE design_pages (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL REFERENCES design_documents(id) ON DELETE CASCADE,
      name TEXT NOT NULL CHECK (TRIM(name) <> ''),
      position INTEGER NOT NULL DEFAULT 0,
      viewport TEXT NOT NULL DEFAULT '{"x":0,"y":0,"zoom":1}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX idx_design_pages_doc ON design_pages(document_id, position);

    CREATE TABLE design_artboards (
      id TEXT PRIMARY KEY,
      page_id TEXT NOT NULL REFERENCES design_pages(id) ON DELETE CASCADE,
      name TEXT NOT NULL CHECK (TRIM(name) <> ''),
      x REAL NOT NULL DEFAULT 0,
      y REAL NOT NULL DEFAULT 0,
      width INTEGER NOT NULL CHECK (width > 0),
      height INTEGER NOT NULL CHECK (height > 0),
      tree TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      position INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX idx_design_artboards_page ON design_artboards(page_id, position);

    CREATE TABLE design_versions (
      id TEXT PRIMARY KEY,
      artboard_id TEXT NOT NULL REFERENCES design_artboards(id) ON DELETE CASCADE,
      version INTEGER NOT NULL,
      author TEXT NOT NULL CHECK (author IN ('claude', 'human')),
      summary TEXT NOT NULL,
      tree TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE (artboard_id, version)
    );
    CREATE INDEX idx_design_versions_artboard
      ON design_versions(artboard_id, version DESC);

    CREATE TABLE design_assets (
      id TEXT PRIMARY KEY,
      document_id TEXT REFERENCES design_documents(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      mime TEXT NOT NULL CHECK (mime IN (
        'image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/svg+xml'
      )),
      bytes BLOB NOT NULL,
      size INTEGER NOT NULL,
      width INTEGER,
      height INTEGER,
      sha256 TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX idx_design_assets_sha
      ON design_assets(sha256, COALESCE(document_id, ''));
    CREATE INDEX idx_design_assets_doc ON design_assets(document_id, created_at DESC);

    CREATE TABLE design_links (
      document_id TEXT NOT NULL REFERENCES design_documents(id) ON DELETE CASCADE,
      parent_type TEXT NOT NULL CHECK (parent_type IN (
        'project', 'repo', 'feature', 'task', 'objective', 'key_result',
        'session', 'handoff'
      )),
      parent_id TEXT NOT NULL,
      PRIMARY KEY (document_id, parent_type, parent_id)
    );
    CREATE INDEX idx_design_links_parent ON design_links(parent_type, parent_id);
  `)
}
