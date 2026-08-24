import type Database from 'better-sqlite3'

export const version = 38
export const name = '038_diagrams'

// Diagramas (canvas Excalidraw). Molde de 035_content_contracts: persistência
// SQLite-only, cena como JSON em TEXT, enums garantidos por CHECK no banco
// porque a regra não pode depender de quem escreve (IPC, MCP ou teste).
//
// INVARIANTES declaradas aqui porque é o schema que as sustenta:
//
// 1. `diagrams` é a CABEÇA MUTÁVEL (a cena vigente); `diagram_versions` é
//    APPEND-ONLY — um snapshot íntegro da cena por versão. Nada reescreve
//    versão já gravada: restaurar copia o snapshot pra cabeça e grava versão
//    NOVA (git-revert, nunca reset).
// 2. `version` na cabeça é monotônico e só sobe quando o store grava snapshot
//    (updateScene com snapshot=true ou restore). Salvamentos intermediários
//    mutam a cabeça sem bump — senão o histórico infla de rascunho.
// 3. O store mantém no máximo 30 snapshots por diagrama (apaga `version <=
//    head.version - 30` no bump). O cap mora no store, não no schema: é
//    política de retenção, não integridade.
// 4. Apagar a cabeça cascateia versões e links (FK ON DELETE CASCADE) — não
//    existe versão órfã nem link pendurado.
// 5. `diagram_links` liga um diagrama a N parents (PK composta impede
//    duplicata); o índice invertido (parent_type, parent_id) é o que torna
//    barato "quais diagramas desta feature".
export function up(db: Database.Database): void {
  db.exec(`
    CREATE TABLE diagrams (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL CHECK (TRIM(title) <> ''),
      kind TEXT NOT NULL DEFAULT 'other'
        CHECK (kind IN ('architecture', 'flow', 'sequence', 'er', 'mindmap', 'other')),
      status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'archived')),
      scene TEXT NOT NULL DEFAULT '{"elements":[]}',
      source_format TEXT
        CHECK (source_format IN ('skeleton', 'mermaid', 'scene')),
      source TEXT,
      thumbnail TEXT,
      version INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX idx_diagrams_status ON diagrams(status, updated_at DESC);

    CREATE TABLE diagram_versions (
      id TEXT PRIMARY KEY,
      diagram_id TEXT NOT NULL REFERENCES diagrams(id) ON DELETE CASCADE,
      version INTEGER NOT NULL,
      author TEXT NOT NULL CHECK (author IN ('claude', 'human')),
      summary TEXT NOT NULL,
      scene TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE (diagram_id, version)
    );
    CREATE INDEX idx_diagram_versions_diagram
      ON diagram_versions(diagram_id, version DESC);

    CREATE TABLE diagram_links (
      diagram_id TEXT NOT NULL REFERENCES diagrams(id) ON DELETE CASCADE,
      parent_type TEXT NOT NULL CHECK (parent_type IN (
        'project', 'repo', 'feature', 'task', 'objective', 'key_result',
        'dossier', 'meeting', 'content_contract', 'session', 'handoff'
      )),
      parent_id TEXT NOT NULL,
      PRIMARY KEY (diagram_id, parent_type, parent_id)
    );
    CREATE INDEX idx_diagram_links_parent ON diagram_links(parent_type, parent_id);
  `)
}
