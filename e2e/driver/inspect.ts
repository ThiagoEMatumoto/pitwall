import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import initSqlJs, { type SqlJsStatic } from "sql.js";

// Inspeção read-only do estado do app a partir da CÓPIA do userData.
// Usa sql.js (SQLite em wasm puro): sem dependência de `sqlite3` no sistema e sem
// o conflito de ABI do better-sqlite3 do app (compilado pra Electron, não pro Node
// do driver). Lê o arquivo em memória — nunca escreve no banco.
//
// ⚠️ LÊ SÓ `app.db`, NÃO O `-wal`. O app abre o banco em `journal_mode = WAL`
// (services/db.ts), então tudo que ele acabou de gravar vive em `app.db-wal` até
// o checkpoint — que acontece quando a conexão fecha. Consultar com o app AINDA
// VIVO devolve o estado antigo, e uma escrita recente aparece como `[]`: parece
// bug de gravação e não é.
//
// Padrão: verificar o banco DEPOIS de `await app.close()`. Se precisar conferir
// com o app aberto, leia pela própria API do app —
// `page.evaluate(() => window.api.<ns>.<get>(...))` — que passa pelo
// better-sqlite3 e enxerga o WAL. Exemplo dos dois: scenarios/validate-loop-phase1.ts.
const require = createRequire(import.meta.url);
let sqlPromise: Promise<SqlJsStatic> | null = null;

function getSql(): Promise<SqlJsStatic> {
  if (!sqlPromise) {
    const wasm = require.resolve("sql.js/dist/sql-wasm.wasm");
    sqlPromise = initSqlJs({ locateFile: () => wasm });
  }
  return sqlPromise;
}

export async function queryDb<T = Record<string, unknown>>(
  userDataCopy: string,
  sql: string,
): Promise<T[]> {
  const SQL = await getSql();
  const db = new SQL.Database(readFileSync(join(userDataCopy, "app.db")));
  try {
    const [res] = db.exec(sql);
    if (!res) return [];
    return res.values.map((row) => {
      const obj: Record<string, unknown> = {};
      res.columns.forEach((col, i) => (obj[col] = row[i]));
      return obj as T;
    });
  } finally {
    db.close();
  }
}

// Lista as tabelas — atalho útil pra descobrir o schema ao diagnosticar.
export async function listTables(userDataCopy: string): Promise<string[]> {
  const rows = await queryDb<{ name: string }>(
    userDataCopy,
    "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
  );
  return rows.map((r) => r.name);
}
