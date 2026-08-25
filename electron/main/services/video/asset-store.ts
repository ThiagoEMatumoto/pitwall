import { randomUUID } from "node:crypto";
import { getDb } from "../db";
import { parseJson } from "./json";
import type {
  RegisterVideoAssetInput,
  VideoAsset,
  VideoAssetKind,
  VideoAssetListFilter,
} from "../../../../shared/types/ipc";

// Store de assets: arquivo no disco + a PROCEDÊNCIA que o gerou
// (provider/model/prompt/refIds). Sem a procedência a peça não é reproduzível,
// só sorteada de novo — que é exatamente o problema que a área existe pra
// resolver.
//
// `projectId` NULL = asset COMPARTILHADO (logo do brand kit, ref de
// personagem): não morre quando uma peça é apagada.
//
// `path` viaja como CAMINHO, nunca data-url: payload de mídia não passa por
// IPC (o precedente do app é cap com throw pra thumbnail de 512 KB; um mp4 ou
// um png 2K não têm o que fazer num canal de IPC).

interface AssetRow {
  id: string;
  project_id: string | null;
  scene_id: string | null;
  kind: string;
  locale: string | null;
  path: string;
  hash: string | null;
  provider: string | null;
  model: string | null;
  prompt: string | null;
  ref_ids: string;
  cost_cents: number;
  bytes: number | null;
  duration_sec: number | null;
  created_at: number;
}

function parseRefIds(raw: string): string[] {
  const parsed = parseJson<unknown>(raw, []);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((s): s is string => typeof s === "string");
}

function rowToAsset(row: AssetRow): VideoAsset {
  return {
    id: row.id,
    projectId: row.project_id,
    sceneId: row.scene_id,
    kind: row.kind as VideoAssetKind,
    locale: row.locale,
    path: row.path,
    hash: row.hash,
    provider: row.provider,
    model: row.model,
    prompt: row.prompt,
    refIds: parseRefIds(row.ref_ids),
    costCents: row.cost_cents,
    bytes: row.bytes,
    durationSec: row.duration_sec,
    createdAt: row.created_at,
  };
}

function getRow(id: string): AssetRow | undefined {
  return getDb().prepare("SELECT * FROM video_assets WHERE id = ?").get(id) as
    AssetRow | undefined;
}

export function list(filter?: VideoAssetListFilter): VideoAsset[] {
  const where: string[] = [];
  const params: unknown[] = [];
  // `projectId: null` EXPLÍCITO significa "só os compartilhados"; omitido
  // significa "todos". A distinção some se testarmos por falsy.
  if (filter && "projectId" in filter) {
    if (filter.projectId === null) {
      where.push("project_id IS NULL");
    } else if (filter.projectId !== undefined) {
      where.push("project_id = ?");
      params.push(filter.projectId);
    }
  }
  if (filter?.sceneId) {
    where.push("scene_id = ?");
    params.push(filter.sceneId);
  }
  if (filter?.kind) {
    where.push("kind = ?");
    params.push(filter.kind);
  }
  if (filter?.locale) {
    where.push("locale = ?");
    params.push(filter.locale);
  }
  if (filter?.hash) {
    where.push("hash = ?");
    params.push(filter.hash);
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  // Sem cap na coluna `prompt`: ela é texto de prompt (KB), não mídia — a
  // mídia mora no disco e só o `path` trafega.
  const rows = getDb()
    .prepare(`SELECT * FROM video_assets ${clause} ORDER BY created_at DESC`)
    .all(...params) as AssetRow[];
  return rows.map(rowToAsset);
}

export function get(id: string): VideoAsset | null {
  const row = getRow(id);
  return row ? rowToAsset(row) : null;
}

// Lookup de idempotência: é ISTO que os geradores chamam ANTES de ir na API.
// Espelha o índice único parcial (project_id, kind, hash) WHERE hash IS NOT
// NULL. Atenção: em SQLite NULLs são distintos num índice único, então assets
// COMPARTILHADOS (project_id NULL) não são deduplicados pelo banco — a
// comparação com IS NULL aqui é o que faz o reuso deles funcionar mesmo assim.
export function findByHash(
  projectId: string | null,
  kind: VideoAssetKind,
  hash: string,
): VideoAsset | null {
  const row = getDb()
    .prepare(
      `SELECT * FROM video_assets
       WHERE kind = ? AND hash = ?
         AND (project_id = ? OR (project_id IS NULL AND ? IS NULL))
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(kind, hash, projectId, projectId) as AssetRow | undefined;
  return row ? rowToAsset(row) : null;
}

export function register(input: RegisterVideoAssetInput): VideoAsset {
  const id = randomUUID();
  getDb()
    .prepare(
      `INSERT INTO video_assets
        (id, project_id, scene_id, kind, locale, path, hash, provider, model, prompt,
         ref_ids, cost_cents, bytes, duration_sec, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.projectId ?? null,
      input.sceneId ?? null,
      input.kind,
      input.locale ?? null,
      input.path,
      input.hash ?? null,
      input.provider ?? null,
      input.model ?? null,
      input.prompt ?? null,
      JSON.stringify(input.refIds ?? []),
      input.costCents ?? 0,
      input.bytes ?? null,
      input.durationSec ?? null,
      Date.now(),
    );
  return get(id)!;
}

// Registra OU reusa: se já existe asset com o mesmo (projectId, kind, hash), a
// linha existente volta em vez de uma nova. Caminho único de escrita dos
// geradores — é o que impede duas chamadas concorrentes furarem o índice único.
export function registerOrReuse(input: RegisterVideoAssetInput): {
  asset: VideoAsset;
  reused: boolean;
} {
  if (input.hash) {
    const existing = findByHash(
      input.projectId ?? null,
      input.kind,
      input.hash,
    );
    if (existing) return { asset: existing, reused: true };
  }
  return { asset: register(input), reused: false };
}

// Só a linha do banco. O ARQUIVO no disco é do serviço que o criou — a UI não
// decide apagar bytes, e um asset referenciado por outra peça ainda aponta pro
// mesmo caminho.
export function remove(id: string): void {
  const row = getRow(id);
  if (!row) throw new Error(`video asset not found: ${id}`);
  getDb().prepare("DELETE FROM video_assets WHERE id = ?").run(id);
}

// Soma do que a peça já custou em API, em centavos. É o número que o teto de
// orçamento da geração de imagem compara antes de gastar mais.
export function spentCents(projectId: string): number {
  const row = getDb()
    .prepare(
      "SELECT COALESCE(SUM(cost_cents), 0) AS total FROM video_assets WHERE project_id = ?",
    )
    .get(projectId) as { total: number };
  return row.total;
}
