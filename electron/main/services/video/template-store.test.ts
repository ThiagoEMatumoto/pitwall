import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyAllMigrations } from "./test-support";

let testDb: Database.Database;
vi.mock("../db", () => ({
  getDb: () => testDb,
}));

import * as store from "./template-store";
import * as projectStore from "./project-store";
import * as scriptStore from "./script-store";

beforeEach(() => {
  testDb = new Database(":memory:");
  testDb.pragma("foreign_keys = ON");
  applyAllMigrations(testDb);
  testDb
    .prepare(
      `INSERT INTO video_brand_kits (id, name, tokens, tone_of_voice, do_dont, tts_voices, created_at, updated_at)
       VALUES ('bk1', 'Pitwall', '{}', '', '{"do":[],"dont":[]}', '{}', 1, 1)`,
    )
    .run();
  testDb
    .prepare(
      `INSERT INTO video_characters (id, name, canonical_description, visual_spec, created_at, updated_at)
       VALUES ('c1', 'Nina', '', '{}', 1, 1)`,
    )
    .run();
});

afterEach(() => {
  testDb.close();
});

describe("template-store", () => {
  it("cria com blueprint e elenco default", () => {
    const t = store.create({
      kind: "promo",
      name: "Promo 60s",
      sceneBlueprint: [{ sceneId: "cold-open", role: "tensão", targetSec: 7 }],
      brandKitId: "bk1",
      defaultCast: [{ characterId: "c1", roleInPiece: "protagonista" }],
    });
    expect(t.sceneBlueprint).toHaveLength(1);
    expect(t.defaultCast).toEqual([
      { characterId: "c1", roleInPiece: "protagonista" },
    ]);
    expect(store.get(t.id)).toEqual(t);
  });

  it("descarta item de blueprint sem sceneId — cena sem chave quebraria a instanciação", () => {
    const t = store.create({ kind: "promo", name: "Promo" });
    testDb
      .prepare("UPDATE video_templates SET scene_blueprint = ? WHERE id = ?")
      .run(
        '[{"role":"tensão"},{"sceneId":"logo","role":"marca","targetSec":4}]',
        t.id,
      );
    expect(store.get(t.id)?.sceneBlueprint).toEqual([
      { sceneId: "logo", role: "marca", targetSec: 4, visualHint: undefined },
    ]);
  });

  it("kind é aberto: categoria nova não exige migration", () => {
    const t = store.create({ kind: "character-story", name: "História" });
    expect(store.list({ kind: "character-story" }).map((x) => x.id)).toEqual([
      t.id,
    ]);
  });

  it("list filtra por busca em nome e descrição", () => {
    store.create({ kind: "promo", name: "Promo 60s" });
    store.create({
      kind: "promo",
      name: "Teaser",
      description: "corte de 15s",
    });
    expect(store.list({ search: "15s" }).map((t) => t.name)).toEqual([
      "Teaser",
    ]);
  });

  it("saveFromProject promove cenas, brand kit e elenco — e NÃO o roteiro", () => {
    const project = projectStore.create({
      slug: "lancamento",
      title: "Lançamento",
      kind: "promo",
      brandKitId: "bk1",
      locales: ["pt-BR"],
    });
    projectStore.upsertScene({
      projectId: project.id,
      sceneId: "cold-open",
      role: "tensão",
      targetSec: 7,
      visual: "escuro absoluto",
    });
    projectStore.upsertScene({
      projectId: project.id,
      sceneId: "logo",
      role: "marca",
      targetSec: 4,
    });
    projectStore.setCast({
      projectId: project.id,
      cast: [{ characterId: "c1", roleInPiece: "protagonista" }],
    });
    scriptStore.set({
      projectId: project.id,
      locale: "pt-BR",
      lines: [
        {
          sceneId: "cold-open",
          kind: "narration",
          text: "Você não roda mais um agente.",
        },
      ],
    });

    const template = store.saveFromProject({
      projectId: project.id,
      name: "Molde do lançamento",
    });

    expect(template.kind).toBe("promo");
    expect(template.brandKitId).toBe("bk1");
    expect(template.sceneBlueprint).toEqual([
      {
        sceneId: "cold-open",
        role: "tensão",
        targetSec: 7,
        visualHint: "escuro absoluto",
      },
      { sceneId: "logo", role: "marca", targetSec: 4, visualHint: undefined },
    ]);
    expect(template.defaultCast).toEqual([
      { characterId: "c1", roleInPiece: "protagonista" },
    ]);
    // O roteiro é da PEÇA: o molde não pode carregar a narração da anterior.
    expect(JSON.stringify(template)).not.toContain(
      "Você não roda mais um agente",
    );
  });

  it("saveFromProject herda o kind da peça quando não é declarado", () => {
    const project = projectStore.create({
      slug: "story",
      title: "História",
      kind: "character-story",
      locales: ["pt-BR"],
    });
    expect(
      store.saveFromProject({ projectId: project.id, name: "Molde" }).kind,
    ).toBe("character-story");
  });

  it("saveFromProject de peça inexistente lança", () => {
    expect(() =>
      store.saveFromProject({ projectId: "nope", name: "X" }),
    ).toThrow(/not found/);
  });

  it("remove solta o template das peças em vez de apagá-las", () => {
    const t = store.create({ kind: "promo", name: "Promo" });
    const project = projectStore.create({
      slug: "peca",
      title: "Peça",
      templateId: t.id,
      locales: ["pt-BR"],
    });
    store.remove(t.id);
    expect(projectStore.get(project.id)?.templateId).toBeNull();
  });
});
