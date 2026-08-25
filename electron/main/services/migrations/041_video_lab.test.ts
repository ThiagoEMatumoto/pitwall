import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrations } from "./index";
import { up as up041 } from "./041_video_lab";

// Aplica 001-040 (igual ao runner real, respeitando disableForeignKeys) p/
// deixar o schema pronto ANTES da 041.
function applyUpTo040(db: Database.Database): void {
  for (const m of migrations.filter((m) => m.version < 41)) {
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

const NOW = 1_700_000_000_000;

function seedReusables(db: Database.Database): void {
  db.prepare(
    `INSERT INTO video_brand_kits (id, name, tokens, tone_of_voice, tts_voices, created_at, updated_at)
     VALUES ('bk1', 'Pitwall', '{"accent":"#f5b"}', 'seco', '{"pt-BR":"x6uR"}', ?, ?)`,
  ).run(NOW, NOW);
  db.prepare(
    `INSERT INTO video_characters (id, name, canonical_description, visual_spec, voice_id, created_at, updated_at)
     VALUES ('c1', 'Nina', 'engenheira', '{"hair":"curto preto"}', 'v1', ?, ?)`,
  ).run(NOW, NOW);
  db.prepare(
    `INSERT INTO video_templates (id, kind, name, scene_blueprint, brand_kit_id, default_cast, created_at, updated_at)
     VALUES ('t1', 'promo', 'Promo 60s', '[{"role":"tensão","targetSec":7}]', 'bk1', '["c1"]', ?, ?)`,
  ).run(NOW, NOW);
}

function seedPiece(db: Database.Database): void {
  db.prepare(
    `INSERT INTO video_projects (id, slug, title, kind, template_id, brand_kit_id, locales, theme_preset, created_at, updated_at)
     VALUES ('p1', 'pitwall-promo', 'Promo Pitwall', 'promo', 't1', 'bk1', '["pt-BR","en"]', 'slate', ?, ?)`,
  ).run(NOW, NOW);
  db.prepare(
    `INSERT INTO video_project_cast (project_id, character_id, role_in_piece)
     VALUES ('p1', 'c1', 'protagonista')`,
  ).run();
  db.prepare(
    `INSERT INTO video_scenes (id, project_id, scene_id, ord, role, target_sec, visual, created_at, updated_at)
     VALUES ('s1', 'p1', 'cold-open', 0, 'tensão', 7, 'Escuro absoluto.', ?, ?)`,
  ).run(NOW, NOW);
  db.prepare(
    `INSERT INTO video_script_lines (id, project_id, scene_id, locale, kind, text, text_hash, ord)
     VALUES ('l1', 'p1', 'cold-open', 'pt-BR', 'narration', 'Você não roda mais um agente.', 'h-cold', 0)`,
  ).run();
  db.prepare(
    `INSERT INTO video_assets (id, project_id, scene_id, kind, locale, path, hash, provider, model, created_at)
     VALUES ('a1', 'p1', 'cold-open', 'audio', 'pt-BR', 'audio/pt-BR/cold-open.mp3', 'h-cold', 'elevenlabs', 'eleven_multilingual_v2', ?)`,
  ).run(NOW);
  db.prepare(
    `INSERT INTO video_renders (id, project_id, locale, status, created_at) VALUES ('rd1', 'p1', 'pt-BR', 'queued', ?)`,
  ).run(NOW);
}

// Asset COMPARTILHADO: project_id NULL. É a imagem de referência que mantém o
// personagem consistente entre peças.
function seedSharedRef(db: Database.Database): void {
  db.prepare(
    `INSERT INTO video_assets (id, project_id, scene_id, kind, path, hash, provider, model, prompt, created_at)
     VALUES ('a2', NULL, NULL, 'character', 'refs/nina-01.png', 'h-nina', 'gemini', 'imagen', 'Nina, cabelo curto preto', ?)`,
  ).run(NOW);
  db.prepare(
    `INSERT INTO video_character_refs (id, character_id, asset_id, is_approved, ord)
     VALUES ('r1', 'c1', 'a2', 1, 0)`,
  ).run();
}

describe("migration 041_video_lab", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applyUpTo040(db);
    up041(db);
  });

  afterEach(() => {
    db.close();
  });

  it("cria video_projects com as colunas esperadas e defaults", () => {
    seedReusables(db);
    seedPiece(db);
    const row = db
      .prepare(`SELECT * FROM video_projects WHERE id = 'p1'`)
      .get() as Record<string, unknown>;
    expect(row.status).toBe("draft");
    expect(row.description).toBe("");
    expect(row.archived_at).toBeNull();
    expect(row.locales).toBe('["pt-BR","en"]');
  });

  it("CHECK rejeita enums fora da lista (asset, script line, projeto, render)", () => {
    seedReusables(db);
    seedPiece(db);
    expect(() =>
      db
        .prepare(
          `INSERT INTO video_assets (id, kind, path, created_at) VALUES ('x', 'video', 'p', 1)`,
        )
        .run(),
    ).toThrow();
    expect(() =>
      db
        .prepare(
          `INSERT INTO video_script_lines (id, project_id, scene_id, locale, kind, text, text_hash)
           VALUES ('x', 'p1', 'cold-open', 'pt-BR', 'caption', 't', 'h')`,
        )
        .run(),
    ).toThrow();
    expect(() =>
      db
        .prepare(
          `INSERT INTO video_projects (id, slug, title, kind, status, created_at, updated_at)
           VALUES ('x', 'y', 't', 'promo', 'wip', 1, 1)`,
        )
        .run(),
    ).toThrow();
    expect(() =>
      db
        .prepare(
          `INSERT INTO video_renders (id, project_id, locale, status, created_at)
           VALUES ('x', 'p1', 'pt-BR', 'pausado', 1)`,
        )
        .run(),
    ).toThrow();
  });

  it("kind de template e de projeto é coluna aberta: categoria nova não exige migration", () => {
    for (const [i, kind] of [
      "promo",
      "character-story",
      "tutorial-longo",
    ].entries()) {
      db.prepare(
        `INSERT INTO video_templates (id, kind, name, created_at, updated_at) VALUES (?, ?, 'x', ?, ?)`,
      ).run(`t-${i}`, kind, NOW, NOW);
    }
    const count = db
      .prepare("SELECT COUNT(*) AS n FROM video_templates")
      .get() as { n: number };
    expect(count.n).toBe(3);
    // ...mas continua barrando vazio.
    expect(() =>
      db
        .prepare(
          `INSERT INTO video_templates (id, kind, name, created_at, updated_at) VALUES ('x', '  ', 'n', 1, 1)`,
        )
        .run(),
    ).toThrow();
  });

  it("FK composta impede linha de roteiro em cena inexistente", () => {
    seedReusables(db);
    seedPiece(db);
    expect(() =>
      db
        .prepare(
          `INSERT INTO video_script_lines (id, project_id, scene_id, locale, kind, text, text_hash)
           VALUES ('x', 'p1', 'fantasma', 'pt-BR', 'narration', 't', 'h')`,
        )
        .run(),
    ).toThrow();
  });

  it("índice único parcial dedupa asset por (project_id, kind, hash)", () => {
    seedReusables(db);
    seedPiece(db);
    expect(() =>
      db
        .prepare(
          `INSERT INTO video_assets (id, project_id, kind, path, hash, created_at)
           VALUES ('x', 'p1', 'audio', 'outro.mp3', 'h-cold', 1)`,
        )
        .run(),
    ).toThrow();
    // hash NULL = sem chave de reuso: nada é deduplicado.
    db.prepare(
      `INSERT INTO video_assets (id, project_id, kind, path, created_at) VALUES ('n1', 'p1', 'audio', 'a.mp3', 1)`,
    ).run();
    db.prepare(
      `INSERT INTO video_assets (id, project_id, kind, path, created_at) VALUES ('n2', 'p1', 'audio', 'b.mp3', 1)`,
    ).run();
    const count = db
      .prepare(`SELECT COUNT(*) AS n FROM video_assets WHERE hash IS NULL`)
      .get() as { n: number };
    expect(count.n).toBe(2);
  });

  it("apagar a peça cascateia o que é dela — e NÃO toca o que é reusável", () => {
    seedReusables(db);
    seedPiece(db);
    seedSharedRef(db);

    db.prepare(`DELETE FROM video_projects WHERE id = 'p1'`).run();

    const n = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
    // O que é da peça morre com ela.
    expect(n("SELECT COUNT(*) AS n FROM video_scenes")).toBe(0);
    expect(n("SELECT COUNT(*) AS n FROM video_script_lines")).toBe(0);
    expect(n("SELECT COUNT(*) AS n FROM video_project_cast")).toBe(0);
    expect(n("SELECT COUNT(*) AS n FROM video_renders")).toBe(0);
    expect(
      n("SELECT COUNT(*) AS n FROM video_assets WHERE project_id IS NOT NULL"),
    ).toBe(0);
    // O que é reusável sobrevive — inclusive o asset compartilhado e o ref que
    // mantém o personagem consistente.
    expect(
      n("SELECT COUNT(*) AS n FROM video_assets WHERE project_id IS NULL"),
    ).toBe(1);
    expect(n("SELECT COUNT(*) AS n FROM video_character_refs")).toBe(1);
    expect(n("SELECT COUNT(*) AS n FROM video_characters")).toBe(1);
    expect(n("SELECT COUNT(*) AS n FROM video_brand_kits")).toBe(1);
    expect(n("SELECT COUNT(*) AS n FROM video_templates")).toBe(1);
    expect(db.pragma("foreign_key_check") as unknown[]).toEqual([]);
  });

  it("apagar o brand kit não apaga template nem peça (SET NULL)", () => {
    seedReusables(db);
    seedPiece(db);

    db.prepare(`DELETE FROM video_brand_kits WHERE id = 'bk1'`).run();

    const template = db
      .prepare(`SELECT brand_kit_id FROM video_templates WHERE id = 't1'`)
      .get() as {
      brand_kit_id: string | null;
    };
    const project = db
      .prepare(`SELECT brand_kit_id FROM video_projects WHERE id = 'p1'`)
      .get() as {
      brand_kit_id: string | null;
    };
    expect(template.brand_kit_id).toBeNull();
    expect(project.brand_kit_id).toBeNull();
    expect(db.pragma("foreign_key_check") as unknown[]).toEqual([]);
  });

  it("UNIQUE(project_id, scene_id) e PK do elenco rejeitam duplicata", () => {
    seedReusables(db);
    seedPiece(db);
    expect(() =>
      db
        .prepare(
          `INSERT INTO video_scenes (id, project_id, scene_id, created_at, updated_at)
           VALUES ('s2', 'p1', 'cold-open', 1, 1)`,
        )
        .run(),
    ).toThrow();
    expect(() =>
      db
        .prepare(
          `INSERT INTO video_project_cast (project_id, character_id) VALUES ('p1', 'c1')`,
        )
        .run(),
    ).toThrow();
  });

  it("is_approved aceita só 0/1 e o ref exige personagem e asset existentes", () => {
    seedReusables(db);
    seedSharedRef(db);
    expect(() =>
      db
        .prepare(
          `INSERT INTO video_character_refs (id, character_id, asset_id, is_approved) VALUES ('x', 'c1', 'a2', 2)`,
        )
        .run(),
    ).toThrow();
    expect(() =>
      db
        .prepare(
          `INSERT INTO video_character_refs (id, character_id, asset_id) VALUES ('x', 'fantasma', 'a2')`,
        )
        .run(),
    ).toThrow();
  });
});
