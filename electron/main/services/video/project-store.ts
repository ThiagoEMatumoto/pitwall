import { randomUUID } from "node:crypto";
import { getDb } from "../db";
import { parseJson } from "./json";
import * as templateStore from "./template-store";
import type {
  CreateVideoProjectInput,
  ReorderVideoScenesInput,
  SetVideoProjectCastInput,
  UpdateVideoProjectInput,
  UpsertVideoSceneInput,
  VideoProject,
  VideoProjectCastEntry,
  VideoProjectListFilter,
  VideoProjectMeta,
  VideoProjectStatus,
  VideoScene,
} from "../../../../shared/types/ipc";

// Store da peça (projeto) e das cenas dela.
//
// O ponto do módulo é `create`: criar peça É INSTANCIAR TEMPLATE. Blueprint →
// cenas, brand kit e elenco default são copiados numa ÚNICA transação, porque
// uma peça que nasceu com as cenas e sem o elenco (ou vice-versa) é um estado
// que a UI não sabe representar. Sem `templateId` a peça nasce vazia — caminho
// de exceção, não o normal.
//
// `status` é a etapa da esteira; arquivar é `archived_at`, coluna separada:
// uma peça pronta pode ser arquivada, e as duas coisas são ortogonais.

interface ProjectRow {
  id: string;
  slug: string;
  title: string;
  description: string;
  kind: string;
  template_id: string | null;
  brand_kit_id: string | null;
  locales: string;
  theme_preset: string | null;
  status: string;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
}

interface SceneRow {
  id: string;
  project_id: string;
  scene_id: string;
  ord: number;
  role: string;
  target_sec: number;
  visual: string;
  created_at: number;
  updated_at: number;
}

interface CastRow {
  project_id: string;
  character_id: string;
  role_in_piece: string;
}

function parseLocales(raw: string): string[] {
  const parsed = parseJson<unknown>(raw, []);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((s): s is string => typeof s === "string");
}

function rowToMeta(row: ProjectRow): VideoProjectMeta {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    description: row.description,
    kind: row.kind,
    templateId: row.template_id,
    brandKitId: row.brand_kit_id,
    locales: parseLocales(row.locales),
    themePreset: row.theme_preset,
    status: row.status as VideoProjectStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
  };
}

function rowToScene(row: SceneRow): VideoScene {
  return {
    id: row.id,
    projectId: row.project_id,
    sceneId: row.scene_id,
    ord: row.ord,
    role: row.role,
    targetSec: row.target_sec,
    visual: row.visual,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToCast(row: CastRow): VideoProjectCastEntry {
  return {
    projectId: row.project_id,
    characterId: row.character_id,
    roleInPiece: row.role_in_piece,
  };
}

function getRow(id: string): ProjectRow | undefined {
  return getDb()
    .prepare("SELECT * FROM video_projects WHERE id = ?")
    .get(id) as ProjectRow | undefined;
}

// ---- peças ----

// Lista leve: sem cenas e sem elenco (que vêm no get()). O roteiro não entra
// nem no get() — é por locale e cresce sem teto, vem por script-store.
export function list(filter?: VideoProjectListFilter): VideoProjectMeta[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (!filter?.includeArchived) where.push("archived_at IS NULL");
  if (filter?.status) {
    where.push("status = ?");
    params.push(filter.status);
  }
  if (filter?.kind) {
    where.push("kind = ?");
    params.push(filter.kind);
  }
  if (filter?.templateId) {
    where.push("template_id = ?");
    params.push(filter.templateId);
  }
  if (filter?.brandKitId) {
    where.push("brand_kit_id = ?");
    params.push(filter.brandKitId);
  }
  if (filter?.search?.trim()) {
    where.push("(title LIKE ? OR slug LIKE ?)");
    params.push(`%${filter.search.trim()}%`, `%${filter.search.trim()}%`);
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const rows = getDb()
    .prepare(
      `SELECT * FROM video_projects ${clause} ORDER BY updated_at DESC, title ASC`,
    )
    .all(...params) as ProjectRow[];
  return rows.map(rowToMeta);
}

export function get(id: string): VideoProject | null {
  const row = getRow(id);
  if (!row) return null;
  return { ...rowToMeta(row), cast: listCast(id), scenes: listScenes(id) };
}

export function create(input: CreateVideoProjectInput): VideoProject {
  const now = Date.now();
  const id = randomUUID();
  const template = input.templateId
    ? templateStore.get(input.templateId)
    : null;
  if (input.templateId && !template) {
    throw new Error(`video template not found: ${input.templateId}`);
  }

  // `kind` é NOT NULL não-vazio no banco. Herda o do template quando o chamador
  // não decide; sem template e sem kind é erro de chamada, não default silencioso.
  const kind = (input.kind ?? template?.kind ?? "").trim();
  if (!kind)
    throw new Error(
      "video project precisa de kind (ou de um template que o forneça)",
    );

  // brandKitId omitido herda o do template; `null` explícito é a peça sem marca.
  const brandKitId =
    input.brandKitId !== undefined
      ? input.brandKitId
      : (template?.brandKitId ?? null);

  const db = getDb();
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO video_projects
        (id, slug, title, description, kind, template_id, brand_kit_id, locales,
         theme_preset, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)`,
    ).run(
      id,
      input.slug.trim(),
      input.title.trim(),
      input.description ?? "",
      kind,
      input.templateId ?? null,
      brandKitId,
      JSON.stringify(input.locales),
      input.themePreset ?? null,
      now,
      now,
    );

    const insertScene = db.prepare(
      `INSERT INTO video_scenes
        (id, project_id, scene_id, ord, role, target_sec, visual, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    (template?.sceneBlueprint ?? []).forEach((bp, index) => {
      insertScene.run(
        randomUUID(),
        id,
        bp.sceneId,
        index,
        bp.role,
        bp.targetSec,
        bp.visualHint ?? "",
        now,
        now,
      );
    });

    const insertCast = db.prepare(
      `INSERT OR IGNORE INTO video_project_cast (project_id, character_id, role_in_piece)
       VALUES (?, ?, ?)`,
    );
    for (const slot of template?.defaultCast ?? []) {
      insertCast.run(id, slot.characterId, slot.roleInPiece);
    }
  });
  tx();
  return get(id)!;
}

export function update(input: UpdateVideoProjectInput): VideoProject {
  const row = getRow(input.id);
  if (!row) throw new Error(`video project not found: ${input.id}`);

  const sets: string[] = [];
  const params: unknown[] = [];
  if (input.title !== undefined) {
    sets.push("title = ?");
    params.push(input.title.trim());
  }
  if (input.description !== undefined) {
    sets.push("description = ?");
    params.push(input.description);
  }
  if (input.kind !== undefined) {
    sets.push("kind = ?");
    params.push(input.kind.trim());
  }
  if (input.brandKitId !== undefined) {
    sets.push("brand_kit_id = ?");
    params.push(input.brandKitId);
  }
  if (input.locales !== undefined) {
    sets.push("locales = ?");
    params.push(JSON.stringify(input.locales));
  }
  if (input.themePreset !== undefined) {
    sets.push("theme_preset = ?");
    params.push(input.themePreset);
  }
  if (input.status !== undefined) {
    sets.push("status = ?");
    params.push(input.status);
  }
  sets.push("updated_at = ?");
  params.push(Date.now());
  params.push(input.id);

  getDb()
    .prepare(`UPDATE video_projects SET ${sets.join(", ")} WHERE id = ?`)
    .run(...params);
  return get(input.id)!;
}

export function archive(id: string): VideoProject {
  return setArchived(id, Date.now());
}

export function unarchive(id: string): VideoProject {
  return setArchived(id, null);
}

function setArchived(id: string, at: number | null): VideoProject {
  const row = getRow(id);
  if (!row) throw new Error(`video project not found: ${id}`);
  getDb()
    .prepare(
      "UPDATE video_projects SET archived_at = ?, updated_at = ? WHERE id = ?",
    )
    .run(at, Date.now(), id);
  return get(id)!;
}

// Cascateia SÓ o que é da peça (cenas, roteiro, elenco escalado, assets com
// project_id, renders). Brand kit, personagem, template e ASSET COMPARTILHADO
// (project_id NULL) sobrevivem — senão apagar a primeira peça tiraria do ar a
// referência visual que mantém o personagem consistente nas outras.
export function remove(id: string): void {
  const row = getRow(id);
  if (!row) throw new Error(`video project not found: ${id}`);
  getDb().prepare("DELETE FROM video_projects WHERE id = ?").run(id);
}

// ---- elenco escalado ----

export function listCast(projectId: string): VideoProjectCastEntry[] {
  const rows = getDb()
    .prepare(
      "SELECT * FROM video_project_cast WHERE project_id = ? ORDER BY character_id ASC",
    )
    .all(projectId) as CastRow[];
  return rows.map(rowToCast);
}

export function setCast(input: SetVideoProjectCastInput): VideoProject {
  const row = getRow(input.projectId);
  if (!row) throw new Error(`video project not found: ${input.projectId}`);

  const db = getDb();
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM video_project_cast WHERE project_id = ?").run(
      input.projectId,
    );
    const insert = db.prepare(
      `INSERT OR IGNORE INTO video_project_cast (project_id, character_id, role_in_piece)
       VALUES (?, ?, ?)`,
    );
    for (const slot of input.cast) {
      insert.run(input.projectId, slot.characterId, slot.roleInPiece);
    }
    db.prepare("UPDATE video_projects SET updated_at = ? WHERE id = ?").run(
      Date.now(),
      input.projectId,
    );
  });
  tx();
  return get(input.projectId)!;
}

// ---- cenas ----

export function listScenes(projectId: string): VideoScene[] {
  const rows = getDb()
    .prepare(
      "SELECT * FROM video_scenes WHERE project_id = ? ORDER BY ord ASC, scene_id ASC",
    )
    .all(projectId) as SceneRow[];
  return rows.map(rowToScene);
}

export function getScene(
  projectId: string,
  sceneId: string,
): VideoScene | null {
  const row = getDb()
    .prepare("SELECT * FROM video_scenes WHERE project_id = ? AND scene_id = ?")
    .get(projectId, sceneId) as SceneRow | undefined;
  return row ? rowToScene(row) : null;
}

// Chave é (projectId, sceneId), não o uuid: é o `scene_id` textual que o
// roteiro, os assets e o motor Remotion citam. Numa cena nova sem `ord`, o
// default é o fim da fila.
export function upsertScene(input: UpsertVideoSceneInput): VideoScene {
  const project = getRow(input.projectId);
  if (!project) throw new Error(`video project not found: ${input.projectId}`);
  const sceneId = input.sceneId.trim();
  if (!sceneId) throw new Error("video scene precisa de sceneId não-vazio");

  const db = getDb();
  const now = Date.now();
  const existing = db
    .prepare("SELECT * FROM video_scenes WHERE project_id = ? AND scene_id = ?")
    .get(input.projectId, sceneId) as SceneRow | undefined;

  if (existing) {
    db.prepare(
      `UPDATE video_scenes
       SET ord = ?, role = ?, target_sec = ?, visual = ?, updated_at = ?
       WHERE project_id = ? AND scene_id = ?`,
    ).run(
      input.ord ?? existing.ord,
      input.role ?? existing.role,
      input.targetSec ?? existing.target_sec,
      input.visual ?? existing.visual,
      now,
      input.projectId,
      sceneId,
    );
    return getScene(input.projectId, sceneId)!;
  }

  const nextOrd =
    input.ord ??
    (
      db
        .prepare(
          "SELECT COALESCE(MAX(ord), -1) AS max_ord FROM video_scenes WHERE project_id = ?",
        )
        .get(input.projectId) as { max_ord: number }
    ).max_ord + 1;
  db.prepare(
    `INSERT INTO video_scenes
      (id, project_id, scene_id, ord, role, target_sec, visual, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    randomUUID(),
    input.projectId,
    sceneId,
    nextOrd,
    input.role ?? "",
    input.targetSec ?? 0,
    input.visual ?? "",
    now,
    now,
  );
  return getScene(input.projectId, sceneId)!;
}

// Reordena numa transação: metade da ordem aplicada é uma peça com duas cenas
// no mesmo `ord`, e aí a ordem do vídeo vira o desempate arbitrário do SQLite.
// Ids não citados vão para o fim, preservando a ordem relativa que já tinham.
export function reorderScenes(input: ReorderVideoScenesInput): VideoScene[] {
  const project = getRow(input.projectId);
  if (!project) throw new Error(`video project not found: ${input.projectId}`);

  const current = listScenes(input.projectId);
  const known = new Set(current.map((s) => s.sceneId));
  for (const sceneId of input.sceneIds) {
    if (!known.has(sceneId)) {
      throw new Error(`video scene not found: ${input.projectId}/${sceneId}`);
    }
  }
  const ordered = [
    ...input.sceneIds,
    ...current
      .map((s) => s.sceneId)
      .filter((id) => !input.sceneIds.includes(id)),
  ];

  const db = getDb();
  const now = Date.now();
  const tx = db.transaction(() => {
    const update = db.prepare(
      "UPDATE video_scenes SET ord = ?, updated_at = ? WHERE project_id = ? AND scene_id = ?",
    );
    ordered.forEach((sceneId, index) =>
      update.run(index, now, input.projectId, sceneId),
    );
    db.prepare("UPDATE video_projects SET updated_at = ? WHERE id = ?").run(
      now,
      input.projectId,
    );
  });
  tx();
  return listScenes(input.projectId);
}

// Apagar a cena leva as linhas de roteiro e os assets dela: a FK COMPOSTA
// (project_id, scene_id) → video_scenes cascateia. É o que impede roteiro
// órfão apontando pra cena que não existe mais.
export function removeScene(projectId: string, sceneId: string): void {
  const scene = getScene(projectId, sceneId);
  if (!scene) throw new Error(`video scene not found: ${projectId}/${sceneId}`);
  getDb()
    .prepare("DELETE FROM video_scenes WHERE project_id = ? AND scene_id = ?")
    .run(projectId, sceneId);
  getDb()
    .prepare("UPDATE video_projects SET updated_at = ? WHERE id = ?")
    .run(Date.now(), projectId);
}
