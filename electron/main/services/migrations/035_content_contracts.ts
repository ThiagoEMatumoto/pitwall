import type Database from 'better-sqlite3'

export const version = 35
export const name = '035_content_contracts'

// Content Contract (Fase 1). Molde de 028_scheduled_jobs: persistência
// SQLite-only, lista-de-objetos como JSON em TEXT (igual a `schedule` e
// `disallowed_tools`).
//
// INVARIANTES declaradas aqui porque é o schema que as sustenta:
//
// 1. `content_contracts` é a CABEÇA MUTÁVEL (o contrato vigente);
//    `content_contract_versions` é APPEND-ONLY — um snapshot íntegro por versão.
//    Nada reescreve versão já gravada: emenda gera versão nova.
// 2. `version` é monotônico e só sobe com diff real de campo (o store compara
//    campo a campo antes de bumpar). Sem diff nada acontece — senão o changelog
//    infla de "salvei de novo" e deixa de ser legível.
// 3. Gate run só existe contra uma versão JÁ snapshotada — daí a FK COMPOSTA
//    (contract_id, contract_version) → content_contract_versions(contract_id,
//    version). É o que impede evidência órfã do texto que valia quando o gate
//    rodou; sem isso a evidência vira alegação sem lastro.
// 4. `output_label` é NOT NULL e não-vazio: o rótulo obrigatório de saída é o
//    invariante que barra material entregue sem identificação. CHECK no banco
//    porque a regra não pode depender de quem chama (MCP, IPC ou teste).
// 5. Não existe coluna `changelog`: o changelog É a tabela de versões.
export function up(db: Database.Database): void {
  db.exec(`
    CREATE TABLE content_contracts (
      id TEXT PRIMARY KEY,
      slug TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft', 'active', 'archived')),
      version INTEGER NOT NULL DEFAULT 1,
      output_label TEXT NOT NULL CHECK (TRIM(output_label) <> ''),
      audience TEXT NOT NULL DEFAULT '{}',
      ethical_line TEXT NOT NULL DEFAULT '[]',
      allowed_facts TEXT NOT NULL DEFAULT '[]',
      forbidden_facts TEXT NOT NULL DEFAULT '[]',
      out_of_scope TEXT NOT NULL DEFAULT '[]',
      tone TEXT NOT NULL DEFAULT '{}',
      delivery_limits TEXT NOT NULL DEFAULT '[]',
      source_precedence TEXT NOT NULL DEFAULT '[]',
      production_invariants TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX idx_content_contracts_status ON content_contracts(status, updated_at DESC);

    CREATE TABLE content_contract_versions (
      id TEXT PRIMARY KEY,
      contract_id TEXT NOT NULL REFERENCES content_contracts(id) ON DELETE CASCADE,
      version INTEGER NOT NULL,
      summary TEXT NOT NULL,
      reason TEXT NOT NULL,
      changed_fields TEXT NOT NULL DEFAULT '[]',
      snapshot_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE (contract_id, version)
    );
    CREATE INDEX idx_content_contract_versions_contract
      ON content_contract_versions(contract_id, created_at DESC);

    CREATE TABLE content_gate_runs (
      id TEXT PRIMARY KEY,
      contract_id TEXT NOT NULL,
      contract_version INTEGER NOT NULL,
      gate TEXT NOT NULL CHECK (gate IN (
        'tone-lint', 'forbidden-facts', 'scope',
        'scope-checklist', 'delivery-limit', 'positive-evidence'
      )),
      status TEXT NOT NULL CHECK (status IN ('passed', 'failed', 'skipped', 'error')),
      material_ref TEXT,
      material_hash TEXT,
      findings TEXT NOT NULL DEFAULT '{"findings":[],"truncated":false}',
      evidence TEXT,
      blocking_count INTEGER NOT NULL DEFAULT 0,
      warning_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (contract_id, contract_version)
        REFERENCES content_contract_versions(contract_id, version) ON DELETE CASCADE
    );
    CREATE INDEX idx_content_gate_runs_contract
      ON content_gate_runs(contract_id, created_at DESC);
  `)
}
