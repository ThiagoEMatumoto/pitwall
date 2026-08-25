import { randomUUID } from "node:crypto";
import { getDb } from "../db";
import { asStringRecord, isPlainObject, parseJson, parseJsonRecord } from "./json";
import type {
  CreateVideoBrandKitInput,
  UpdateVideoBrandKitInput,
  VideoBrandDoDont,
  VideoBrandKit,
  VideoBrandTokens,
} from "../../../../shared/types/ipc";

// Store do brand kit. Molde de diagram-store: funções soltas, getDb() por
// chamada, rows snake_case ⇄ entidades camelCase, JSON.parse sempre defensivo.
//
// Brand kit NÃO pertence a peça nenhuma (não tem project_id): é o objeto
// reusável que faz a segunda peça já nascer com a marca certa. Por isso o
// `logoAssetId` aponta pra um asset COMPARTILHADO (project_id NULL) — se o logo
// fosse asset de peça, apagar a peça apagaria o logo da marca.

const EMPTY_TOKENS: VideoBrandTokens = { palette: {}, typography: {} };
const EMPTY_DO_DONT: VideoBrandDoDont = { do: [], dont: [] };

interface BrandKitRow {
  id: string;
  name: string;
  tokens: string;
  tone_of_voice: string;
  do_dont: string;
  logo_asset_id: string | null;
  tts_voices: string;
  created_at: number;
  updated_at: number;
}

function parseTokens(raw: string): VideoBrandTokens {
  const parsed = parseJson<Partial<VideoBrandTokens>>(raw, EMPTY_TOKENS);
  const palette = parsed.palette;
  const typography = parsed.typography;
  return {
    palette: isPlainObject(palette) ? asStringRecord(palette) : {},
    typography: isPlainObject(typography) ? typography : {},
  };
}

function parseDoDont(raw: string): VideoBrandDoDont {
  const parsed = parseJson<Partial<VideoBrandDoDont>>(raw, EMPTY_DO_DONT);
  return {
    do: Array.isArray(parsed.do)
      ? parsed.do.filter((s) => typeof s === "string")
      : [],
    dont: Array.isArray(parsed.dont)
      ? parsed.dont.filter((s) => typeof s === "string")
      : [],
  };
}

function rowToBrandKit(row: BrandKitRow): VideoBrandKit {
  return {
    id: row.id,
    name: row.name,
    tokens: parseTokens(row.tokens),
    toneOfVoice: row.tone_of_voice,
    doDont: parseDoDont(row.do_dont),
    logoAssetId: row.logo_asset_id,
    ttsVoices: parseJsonRecord(row.tts_voices),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function getRow(id: string): BrandKitRow | undefined {
  return getDb()
    .prepare("SELECT * FROM video_brand_kits WHERE id = ?")
    .get(id) as BrandKitRow | undefined;
}

export function list(): VideoBrandKit[] {
  const rows = getDb()
    .prepare(
      "SELECT * FROM video_brand_kits ORDER BY updated_at DESC, name ASC",
    )
    .all() as BrandKitRow[];
  return rows.map(rowToBrandKit);
}

export function get(id: string): VideoBrandKit | null {
  const row = getRow(id);
  return row ? rowToBrandKit(row) : null;
}

export function create(input: CreateVideoBrandKitInput): VideoBrandKit {
  const now = Date.now();
  const id = randomUUID();
  getDb()
    .prepare(
      `INSERT INTO video_brand_kits
        (id, name, tokens, tone_of_voice, do_dont, logo_asset_id, tts_voices,
         created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.name.trim(),
      JSON.stringify(input.tokens ?? EMPTY_TOKENS),
      input.toneOfVoice ?? "",
      JSON.stringify(input.doDont ?? EMPTY_DO_DONT),
      input.logoAssetId ?? null,
      JSON.stringify(input.ttsVoices ?? {}),
      now,
      now,
    );
  return get(id)!;
}

// PATCH: campo ausente no input fica como está. `logoAssetId: null` explícito
// SOLTA o logo — é diferente de omitir, e a distinção importa porque a UI
// precisa poder tirar o logo sem apagar o brand kit.
export function update(input: UpdateVideoBrandKitInput): VideoBrandKit {
  const row = getRow(input.id);
  if (!row) throw new Error(`video brand kit not found: ${input.id}`);

  const sets: string[] = [];
  const params: unknown[] = [];
  if (input.name !== undefined) {
    sets.push("name = ?");
    params.push(input.name.trim());
  }
  if (input.tokens !== undefined) {
    sets.push("tokens = ?");
    params.push(JSON.stringify(input.tokens));
  }
  if (input.toneOfVoice !== undefined) {
    sets.push("tone_of_voice = ?");
    params.push(input.toneOfVoice);
  }
  if (input.doDont !== undefined) {
    sets.push("do_dont = ?");
    params.push(JSON.stringify(input.doDont));
  }
  if (input.logoAssetId !== undefined) {
    sets.push("logo_asset_id = ?");
    params.push(input.logoAssetId);
  }
  if (input.ttsVoices !== undefined) {
    sets.push("tts_voices = ?");
    params.push(JSON.stringify(input.ttsVoices));
  }
  sets.push("updated_at = ?");
  params.push(Date.now());
  params.push(input.id);

  getDb()
    .prepare(`UPDATE video_brand_kits SET ${sets.join(", ")} WHERE id = ?`)
    .run(...params);
  return get(input.id)!;
}

// Templates e peças que apontavam pra este kit ficam com brand_kit_id NULL
// (ON DELETE SET NULL no schema) — apagar a marca não pode destruir a peça.
export function remove(id: string): void {
  const row = getRow(id);
  if (!row) throw new Error(`video brand kit not found: ${id}`);
  getDb().prepare("DELETE FROM video_brand_kits WHERE id = ?").run(id);
}

// A voz de TTS preferida da marca para um locale. É o default de
// generateAudio quando o chamador não passa voiceId — sem isto cada peça
// escolheria uma voz e a marca soaria diferente em cada vídeo.
export function voiceForLocale(
  brandKitId: string | null,
  locale: string,
): string | null {
  if (!brandKitId) return null;
  const kit = get(brandKitId);
  if (!kit) return null;
  return kit.ttsVoices[locale] ?? null;
}

// Ids de assets referenciados por algum brand kit — o que NÃO pode ser apagado
// junto com uma peça. Usado pelos testes e pela varredura de órfãos.
export function referencedAssetIds(): string[] {
  const rows = getDb()
    .prepare(
      "SELECT logo_asset_id FROM video_brand_kits WHERE logo_asset_id IS NOT NULL",
    )
    .all() as Array<{ logo_asset_id: string }>;
  return rows.map((r) => r.logo_asset_id);
}
