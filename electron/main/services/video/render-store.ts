import { randomUUID } from "node:crypto";
import { getDb } from "../db";
import type {
  VideoRender,
  VideoRenderListFilter,
  VideoRenderMeta,
  VideoRenderStatus,
} from "../../../../shared/types/ipc";

// Store de renders. A row É o resultado do render: o processo do Remotion é
// fire-and-forget e nunca lança pro chamador — quem quer saber se deu certo lê
// `status` aqui (invariante copiada do job-runner do app).
//
// `log` é a saída do Remotion e cresce; por isso `list()` NÃO o carrega
// (VideoRenderMeta existe pra isso) e o append tem teto — um render que falha
// em loop não pode engordar o banco sem limite.

// Teto do log guardado por render. O que interessa depois é o FIM (a mensagem
// de erro), então o corte é no começo.
const MAX_LOG_CHARS = 200_000;

interface RenderRow {
  id: string;
  project_id: string;
  locale: string;
  status: string;
  out_path: string | null;
  bytes: number | null;
  duration_sec: number | null;
  log: string | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
}

function rowToMeta(row: RenderRow): VideoRenderMeta {
  return {
    id: row.id,
    projectId: row.project_id,
    locale: row.locale,
    status: row.status as VideoRenderStatus,
    outPath: row.out_path,
    bytes: row.bytes,
    durationSec: row.duration_sec,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

function rowToRender(row: RenderRow): VideoRender {
  return { ...rowToMeta(row), log: row.log };
}

function getRow(id: string): RenderRow | undefined {
  return getDb().prepare("SELECT * FROM video_renders WHERE id = ?").get(id) as
    RenderRow | undefined;
}

// Sem `log` no SELECT: a fila de renders não carrega megabytes de saída do
// Remotion (mesmo molde do `list()` de diagramas).
export function list(filter?: VideoRenderListFilter): VideoRenderMeta[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter?.projectId) {
    where.push("project_id = ?");
    params.push(filter.projectId);
  }
  if (filter?.locale) {
    where.push("locale = ?");
    params.push(filter.locale);
  }
  if (filter?.status) {
    where.push("status = ?");
    params.push(filter.status);
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const rows = getDb()
    .prepare(
      `SELECT id, project_id, locale, status, out_path, bytes, duration_sec,
              created_at, started_at, finished_at, NULL AS log
       FROM video_renders ${clause} ORDER BY created_at DESC`,
    )
    .all(...params) as RenderRow[];
  return rows.map(rowToMeta);
}

export function get(id: string): VideoRender | null {
  const row = getRow(id);
  return row ? rowToRender(row) : null;
}

// Nasce 'queued' com `created_at`: sem ele um render enfileirado (ainda sem
// `started_at`) não teria por onde ser ordenado na fila.
export function enqueue(projectId: string, locale: string): VideoRenderMeta {
  const project = getDb()
    .prepare("SELECT id FROM video_projects WHERE id = ?")
    .get(projectId) as { id: string } | undefined;
  if (!project) throw new Error(`video project not found: ${projectId}`);

  const id = randomUUID();
  getDb()
    .prepare(
      `INSERT INTO video_renders (id, project_id, locale, status, created_at)
       VALUES (?, ?, ?, 'queued', ?)`,
    )
    .run(id, projectId, locale, Date.now());
  return rowToMeta(getRow(id)!);
}

export interface UpdateRenderInput {
  id: string;
  status?: VideoRenderStatus;
  outPath?: string | null;
  bytes?: number | null;
  durationSec?: number | null;
  startedAt?: number | null;
  finishedAt?: number | null;
}

export function update(input: UpdateRenderInput): VideoRenderMeta {
  const row = getRow(input.id);
  if (!row) throw new Error(`video render not found: ${input.id}`);

  const sets: string[] = [];
  const params: unknown[] = [];
  if (input.status !== undefined) {
    sets.push("status = ?");
    params.push(input.status);
  }
  if (input.outPath !== undefined) {
    sets.push("out_path = ?");
    params.push(input.outPath);
  }
  if (input.bytes !== undefined) {
    sets.push("bytes = ?");
    params.push(input.bytes);
  }
  if (input.durationSec !== undefined) {
    sets.push("duration_sec = ?");
    params.push(input.durationSec);
  }
  if (input.startedAt !== undefined) {
    sets.push("started_at = ?");
    params.push(input.startedAt);
  }
  if (input.finishedAt !== undefined) {
    sets.push("finished_at = ?");
    params.push(input.finishedAt);
  }
  if (sets.length === 0) return rowToMeta(row);

  params.push(input.id);
  getDb()
    .prepare(`UPDATE video_renders SET ${sets.join(", ")} WHERE id = ?`)
    .run(...params);
  return rowToMeta(getRow(input.id)!);
}

// Append com teto: passando de MAX_LOG_CHARS, corta o COMEÇO. Quem investiga
// um render quebrado quer as últimas linhas.
export function appendLog(id: string, chunk: string): void {
  const row = getRow(id);
  if (!row) return;
  const merged = (row.log ?? "") + chunk;
  const trimmed =
    merged.length > MAX_LOG_CHARS
      ? merged.slice(merged.length - MAX_LOG_CHARS)
      : merged;
  getDb()
    .prepare("UPDATE video_renders SET log = ? WHERE id = ?")
    .run(trimmed, id);
}

// Renders 'queued'/'running' de um boot anterior são órfãos: o processo do
// Remotion morre junto com o app e o evento 'exit' que reconciliaria nunca
// dispara. Sem isto a fila mostra pra sempre um render que não existe.
// Chamado no boot por registerVideoIpc, espelhando o que db.ts já faz com
// sessões e handoffs.
export function reconcileOrphans(): number {
  const info = getDb()
    .prepare(
      `UPDATE video_renders SET status = 'failed', finished_at = ?
       WHERE status IN ('queued', 'running')`,
    )
    .run(Date.now());
  return info.changes;
}
