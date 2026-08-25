import type Database from "better-sqlite3";
import { migrations } from "../migrations/index";

// Apoio dos testes dos stores do Video Lab. Aplica as migrations do MESMO jeito
// que o runner real (respeitando `disableForeignKeys`) num SQLite in-memory —
// os testes exercitam o schema de verdade, incluindo os CHECK e as FK
// compostas, que são metade das invariantes da área.

export function applyAllMigrations(db: Database.Database): void {
  for (const m of migrations) {
    if (m.disableForeignKeys) {
      db.pragma("foreign_keys = OFF");
      try {
        m.up(db);
      } finally {
        db.pragma("foreign_keys = ON");
      }
    } else {
      m.up(db);
    }
  }
}
