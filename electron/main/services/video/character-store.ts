import { randomUUID } from "node:crypto";
import { getDb } from "../db";
import { parseJson } from "./json";
import type {
  CreateVideoCharacterInput,
  SetVideoCharacterRefsInput,
  UpdateVideoCharacterInput,
  VideoCharacter,
  VideoCharacterListFilter,
  VideoCharacterMeta,
  VideoCharacterRef,
  VideoVisualSpec,
} from "../../../../shared/types/ipc";

// Store de personagens. É AQUI que mora a consistência da área: `visual_spec`
// guarda os traços que não podem variar entre cenas (injetados literalmente em
// todo prompt de imagem) e `video_character_refs` guarda as imagens aprovadas
// que vão como referência ao gerador.
//
// Personagem NÃO tem project_id: é reusado entre peças. Só `archived_at` o tira
// da lista — não há delete, porque apagar um personagem invalidaria a
// procedência (`ref_ids`) de todo asset já gerado com ele.

const EMPTY_SPEC: VideoVisualSpec = {
  canonical: "",
  invariants: [],
  negative: [],
};

interface CharacterRow {
  id: string;
  name: string;
  canonical_description: string;
  visual_spec: string;
  voice_id: string | null;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
}

interface CharacterRefRow {
  id: string;
  character_id: string;
  asset_id: string;
  is_approved: number;
  ord: number;
}

function parseSpec(raw: string): VideoVisualSpec {
  const parsed = parseJson<Partial<VideoVisualSpec>>(raw, EMPTY_SPEC);
  const strings = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : [];
  return {
    canonical: typeof parsed.canonical === "string" ? parsed.canonical : "",
    invariants: strings(parsed.invariants),
    negative: strings(parsed.negative),
  };
}

function rowToMeta(row: CharacterRow): VideoCharacterMeta {
  return {
    id: row.id,
    name: row.name,
    canonicalDescription: row.canonical_description,
    visualSpec: parseSpec(row.visual_spec),
    voiceId: row.voice_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
  };
}

function rowToRef(row: CharacterRefRow): VideoCharacterRef {
  return {
    id: row.id,
    characterId: row.character_id,
    assetId: row.asset_id,
    isApproved: row.is_approved === 1,
    ord: row.ord,
  };
}

function getRow(id: string): CharacterRow | undefined {
  return getDb()
    .prepare("SELECT * FROM video_characters WHERE id = ?")
    .get(id) as CharacterRow | undefined;
}

export function listRefs(characterId: string): VideoCharacterRef[] {
  const rows = getDb()
    .prepare(
      "SELECT * FROM video_character_refs WHERE character_id = ? ORDER BY ord ASC",
    )
    .all(characterId) as CharacterRefRow[];
  return rows.map(rowToRef);
}

// Sem as refs: a lista é leve (o molde do `list()` que não carrega a coluna
// pesada). As refs vêm no get().
export function list(filter?: VideoCharacterListFilter): VideoCharacterMeta[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (!filter?.includeArchived) where.push("archived_at IS NULL");
  if (filter?.search?.trim()) {
    where.push("name LIKE ?");
    params.push(`%${filter.search.trim()}%`);
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const rows = getDb()
    .prepare(
      `SELECT * FROM video_characters ${clause} ORDER BY updated_at DESC, name ASC`,
    )
    .all(...params) as CharacterRow[];
  return rows.map(rowToMeta);
}

export function get(id: string): VideoCharacter | null {
  const row = getRow(id);
  if (!row) return null;
  return { ...rowToMeta(row), refs: listRefs(id) };
}

export function create(input: CreateVideoCharacterInput): VideoCharacter {
  const now = Date.now();
  const id = randomUUID();
  getDb()
    .prepare(
      `INSERT INTO video_characters
        (id, name, canonical_description, visual_spec, voice_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.name.trim(),
      input.canonicalDescription ?? "",
      JSON.stringify(input.visualSpec ?? EMPTY_SPEC),
      input.voiceId ?? null,
      now,
      now,
    );
  return get(id)!;
}

export function update(input: UpdateVideoCharacterInput): VideoCharacter {
  const row = getRow(input.id);
  if (!row) throw new Error(`video character not found: ${input.id}`);

  const sets: string[] = [];
  const params: unknown[] = [];
  if (input.name !== undefined) {
    sets.push("name = ?");
    params.push(input.name.trim());
  }
  if (input.canonicalDescription !== undefined) {
    sets.push("canonical_description = ?");
    params.push(input.canonicalDescription);
  }
  if (input.visualSpec !== undefined) {
    sets.push("visual_spec = ?");
    params.push(JSON.stringify(input.visualSpec));
  }
  if (input.voiceId !== undefined) {
    sets.push("voice_id = ?");
    params.push(input.voiceId);
  }
  sets.push("updated_at = ?");
  params.push(Date.now());
  params.push(input.id);

  getDb()
    .prepare(`UPDATE video_characters SET ${sets.join(", ")} WHERE id = ?`)
    .run(...params);
  return get(input.id)!;
}

// Substitui o conjunto INTEIRO de refs numa transação: a ordem do array vira
// `ord`, e é essa ordem que decide quais refs entram primeiro no prompt quando
// o modelo tem teto de referências.
export function setRefs(input: SetVideoCharacterRefsInput): VideoCharacter {
  const row = getRow(input.characterId);
  if (!row) throw new Error(`video character not found: ${input.characterId}`);

  const db = getDb();
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM video_character_refs WHERE character_id = ?").run(
      input.characterId,
    );
    const insert = db.prepare(
      `INSERT INTO video_character_refs (id, character_id, asset_id, is_approved, ord)
       VALUES (?, ?, ?, ?, ?)`,
    );
    input.refs.forEach((ref, index) => {
      insert.run(
        randomUUID(),
        input.characterId,
        ref.assetId,
        ref.isApproved ? 1 : 0,
        index,
      );
    });
    db.prepare("UPDATE video_characters SET updated_at = ? WHERE id = ?").run(
      Date.now(),
      input.characterId,
    );
  });
  tx();
  return get(input.characterId)!;
}

// Só as APROVADAS entram no prompt — o resto é histórico de tentativa. É o
// filtro que separa "a imagem que define o personagem" de "uma imagem que
// geramos com ele".
export function approvedRefAssetIds(characterId: string): string[] {
  const rows = getDb()
    .prepare(
      `SELECT asset_id FROM video_character_refs
       WHERE character_id = ? AND is_approved = 1 ORDER BY ord ASC`,
    )
    .all(characterId) as Array<{ asset_id: string }>;
  return rows.map((r) => r.asset_id);
}

export function archive(id: string): VideoCharacter {
  return setArchived(id, Date.now());
}

export function unarchive(id: string): VideoCharacter {
  return setArchived(id, null);
}

function setArchived(id: string, at: number | null): VideoCharacter {
  const row = getRow(id);
  if (!row) throw new Error(`video character not found: ${id}`);
  getDb()
    .prepare(
      "UPDATE video_characters SET archived_at = ?, updated_at = ? WHERE id = ?",
    )
    .run(at, Date.now(), id);
  return get(id)!;
}
