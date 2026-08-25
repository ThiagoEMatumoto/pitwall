import { randomUUID } from "node:crypto";
import { getDb } from "../db";
import { isPlainObject, parseJson } from "./json";
import type {
  CreateVideoTemplateInput,
  UpdateVideoTemplateInput,
  VideoCastSlot,
  VideoSceneBlueprint,
  VideoTemplate,
  VideoTemplateListFilter,
} from "../../../../shared/types/ipc";

// Store de templates — o objeto que faz uma peça nunca nascer do zero. Um
// template é (categoria + blueprint de cenas + brand kit + elenco default);
// instanciá-lo é trabalho do project-store, que copia tudo numa transação.
//
// `kind` é coluna ABERTA no schema (só CHECK de não-vazio): categoria nova
// ('promo', 'character-story', o que vier) não pode exigir migration.
//
// `saveFromProject` é o caminho inverso e o que fecha o ciclo de reuso: uma
// peça que ficou boa vira molde da próxima. Lê as rows de cena/elenco DIRETO
// (sem importar project-store) porque o project-store importa este módulo pra
// instanciar — o import nas duas direções seria ciclo.

interface TemplateRow {
  id: string;
  kind: string;
  name: string;
  description: string;
  scene_blueprint: string;
  brand_kit_id: string | null;
  default_cast: string;
  created_at: number;
  updated_at: number;
}

// Blueprint vindo de coluna TEXT: além do parse, cada item é normalizado. Um
// item sem `sceneId` viraria cena sem chave na instanciação (o UNIQUE do banco
// rejeitaria a peça inteira), então itens inválidos são descartados aqui.
function parseBlueprint(raw: string): VideoSceneBlueprint[] {
  const parsed = parseJson<unknown>(raw, []);
  if (!Array.isArray(parsed)) return [];
  const out: VideoSceneBlueprint[] = [];
  for (const item of parsed) {
    if (!isPlainObject(item)) continue;
    const sceneId = typeof item.sceneId === "string" ? item.sceneId.trim() : "";
    if (!sceneId) continue;
    out.push({
      sceneId,
      role: typeof item.role === "string" ? item.role : "",
      targetSec: typeof item.targetSec === "number" ? item.targetSec : 0,
      visualHint:
        typeof item.visualHint === "string" ? item.visualHint : undefined,
    });
  }
  return out;
}

function parseCast(raw: string): VideoCastSlot[] {
  const parsed = parseJson<unknown>(raw, []);
  if (!Array.isArray(parsed)) return [];
  const out: VideoCastSlot[] = [];
  for (const item of parsed) {
    if (!isPlainObject(item)) continue;
    const characterId =
      typeof item.characterId === "string" ? item.characterId.trim() : "";
    if (!characterId) continue;
    out.push({
      characterId,
      roleInPiece: typeof item.roleInPiece === "string" ? item.roleInPiece : "",
    });
  }
  return out;
}

function rowToTemplate(row: TemplateRow): VideoTemplate {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    description: row.description,
    sceneBlueprint: parseBlueprint(row.scene_blueprint),
    brandKitId: row.brand_kit_id,
    defaultCast: parseCast(row.default_cast),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function getRow(id: string): TemplateRow | undefined {
  return getDb()
    .prepare("SELECT * FROM video_templates WHERE id = ?")
    .get(id) as TemplateRow | undefined;
}

export function list(filter?: VideoTemplateListFilter): VideoTemplate[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter?.kind) {
    where.push("kind = ?");
    params.push(filter.kind);
  }
  if (filter?.search?.trim()) {
    where.push("(name LIKE ? OR description LIKE ?)");
    params.push(`%${filter.search.trim()}%`, `%${filter.search.trim()}%`);
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const rows = getDb()
    .prepare(
      `SELECT * FROM video_templates ${clause} ORDER BY updated_at DESC, name ASC`,
    )
    .all(...params) as TemplateRow[];
  return rows.map(rowToTemplate);
}

export function get(id: string): VideoTemplate | null {
  const row = getRow(id);
  return row ? rowToTemplate(row) : null;
}

export function create(input: CreateVideoTemplateInput): VideoTemplate {
  const now = Date.now();
  const id = randomUUID();
  getDb()
    .prepare(
      `INSERT INTO video_templates
        (id, kind, name, description, scene_blueprint, brand_kit_id, default_cast,
         created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.kind.trim(),
      input.name.trim(),
      input.description ?? "",
      JSON.stringify(input.sceneBlueprint ?? []),
      input.brandKitId ?? null,
      JSON.stringify(input.defaultCast ?? []),
      now,
      now,
    );
  return get(id)!;
}

export function update(input: UpdateVideoTemplateInput): VideoTemplate {
  const row = getRow(input.id);
  if (!row) throw new Error(`video template not found: ${input.id}`);

  const sets: string[] = [];
  const params: unknown[] = [];
  if (input.kind !== undefined) {
    sets.push("kind = ?");
    params.push(input.kind.trim());
  }
  if (input.name !== undefined) {
    sets.push("name = ?");
    params.push(input.name.trim());
  }
  if (input.description !== undefined) {
    sets.push("description = ?");
    params.push(input.description);
  }
  if (input.sceneBlueprint !== undefined) {
    sets.push("scene_blueprint = ?");
    params.push(JSON.stringify(input.sceneBlueprint));
  }
  if (input.brandKitId !== undefined) {
    sets.push("brand_kit_id = ?");
    params.push(input.brandKitId);
  }
  if (input.defaultCast !== undefined) {
    sets.push("default_cast = ?");
    params.push(JSON.stringify(input.defaultCast));
  }
  sets.push("updated_at = ?");
  params.push(Date.now());
  params.push(input.id);

  getDb()
    .prepare(`UPDATE video_templates SET ${sets.join(", ")} WHERE id = ?`)
    .run(...params);
  return get(input.id)!;
}

// Peças criadas a partir deste template ficam com template_id NULL (ON DELETE
// SET NULL) — apagar o molde não pode apagar o que já foi produzido com ele.
export function remove(id: string): void {
  const row = getRow(id);
  if (!row) throw new Error(`video template not found: ${id}`);
  getDb().prepare("DELETE FROM video_templates WHERE id = ?").run(id);
}

interface SceneShapeRow {
  scene_id: string;
  ord: number;
  role: string;
  target_sec: number;
  visual: string;
}

interface CastShapeRow {
  character_id: string;
  role_in_piece: string;
}

interface ProjectShapeRow {
  kind: string;
  brand_kit_id: string | null;
}

export interface SaveTemplateFromProjectInput {
  projectId: string;
  name: string;
  /** Omitido: herda a categoria da própria peça. */
  kind?: string;
  description?: string;
}

// "Salvar peça como template": promove a ESTRUTURA da peça a molde — cenas
// (papel + duração + direção de arte), brand kit e elenco. O ROTEIRO fica de
// fora de propósito: narração é da peça, não do molde; é justamente o que
// permite o mesmo blueprint gerar peças diferentes.
export function saveFromProject(
  input: SaveTemplateFromProjectInput,
): VideoTemplate {
  const db = getDb();
  const project = db
    .prepare("SELECT kind, brand_kit_id FROM video_projects WHERE id = ?")
    .get(input.projectId) as ProjectShapeRow | undefined;
  if (!project) throw new Error(`video project not found: ${input.projectId}`);

  const scenes = db
    .prepare(
      `SELECT scene_id, ord, role, target_sec, visual FROM video_scenes
       WHERE project_id = ? ORDER BY ord ASC`,
    )
    .all(input.projectId) as SceneShapeRow[];
  const cast = db
    .prepare(
      `SELECT character_id, role_in_piece FROM video_project_cast
       WHERE project_id = ? ORDER BY character_id ASC`,
    )
    .all(input.projectId) as CastShapeRow[];

  return create({
    kind: input.kind?.trim() || project.kind,
    name: input.name,
    description: input.description ?? "",
    sceneBlueprint: scenes.map((s) => ({
      sceneId: s.scene_id,
      role: s.role,
      targetSec: s.target_sec,
      visualHint: s.visual || undefined,
    })),
    brandKitId: project.brand_kit_id,
    defaultCast: cast.map((c) => ({
      characterId: c.character_id,
      roleInPiece: c.role_in_piece,
    })),
  });
}
