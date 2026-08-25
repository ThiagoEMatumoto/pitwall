import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyAllMigrations } from "./test-support";

let testDb: Database.Database;
vi.mock("../db", () => ({
  getDb: () => testDb,
}));

import * as store from "./project-store";
import * as templateStore from "./template-store";

function seedReusables(): string {
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
  const template = templateStore.create({
    kind: "promo",
    name: "Promo 60s",
    sceneBlueprint: [
      {
        sceneId: "cold-open",
        role: "tensão",
        targetSec: 7,
        visualHint: "escuro",
      },
      { sceneId: "logo", role: "marca", targetSec: 4 },
    ],
    brandKitId: "bk1",
    defaultCast: [{ characterId: "c1", roleInPiece: "protagonista" }],
  });
  return template.id;
}

beforeEach(() => {
  testDb = new Database(":memory:");
  testDb.pragma("foreign_keys = ON");
  applyAllMigrations(testDb);
});

afterEach(() => {
  testDb.close();
});

describe("project-store", () => {
  it("criar peça É instanciar template: cenas, elenco e brand kit vêm juntos", () => {
    const templateId = seedReusables();
    const project = store.create({
      slug: "lancamento",
      title: "Lançamento",
      templateId,
      locales: ["pt-BR", "en"],
    });

    expect(project.kind).toBe("promo");
    expect(project.brandKitId).toBe("bk1");
    expect(project.status).toBe("draft");
    expect(project.scenes.map((s) => [s.sceneId, s.ord, s.visual])).toEqual([
      ["cold-open", 0, "escuro"],
      ["logo", 1, ""],
    ]);
    expect(project.cast).toEqual([
      { projectId: project.id, characterId: "c1", roleInPiece: "protagonista" },
    ]);
  });

  it("brandKitId null explícito é peça sem marca; omitido herda o do template", () => {
    const templateId = seedReusables();
    const herdado = store.create({
      slug: "a",
      title: "A",
      templateId,
      locales: ["pt-BR"],
    });
    const semMarca = store.create({
      slug: "b",
      title: "B",
      templateId,
      brandKitId: null,
      locales: ["pt-BR"],
    });
    expect(herdado.brandKitId).toBe("bk1");
    expect(semMarca.brandKitId).toBeNull();
  });

  it("sem template e sem kind é erro de chamada, não default silencioso", () => {
    expect(() =>
      store.create({ slug: "x", title: "X", locales: ["pt-BR"] }),
    ).toThrow(/kind/);
  });

  it("template inexistente lança em vez de criar peça vazia", () => {
    expect(() =>
      store.create({
        slug: "x",
        title: "X",
        templateId: "nope",
        locales: ["pt-BR"],
      }),
    ).toThrow(/not found/);
  });

  it("slug é único", () => {
    store.create({
      slug: "dup",
      title: "A",
      kind: "promo",
      locales: ["pt-BR"],
    });
    expect(() =>
      store.create({
        slug: "dup",
        title: "B",
        kind: "promo",
        locales: ["pt-BR"],
      }),
    ).toThrow();
  });

  it("upsertScene cria no fim da fila e atualiza pela chave (projectId, sceneId)", () => {
    const project = store.create({
      slug: "p",
      title: "P",
      kind: "promo",
      locales: ["pt-BR"],
    });
    store.upsertScene({ projectId: project.id, sceneId: "a", role: "um" });
    store.upsertScene({ projectId: project.id, sceneId: "b", role: "dois" });
    expect(store.listScenes(project.id).map((s) => [s.sceneId, s.ord])).toEqual(
      [
        ["a", 0],
        ["b", 1],
      ],
    );

    store.upsertScene({
      projectId: project.id,
      sceneId: "a",
      role: "um revisado",
    });
    const scenes = store.listScenes(project.id);
    expect(scenes).toHaveLength(2);
    expect(scenes[0].role).toBe("um revisado");
    expect(scenes[0].ord).toBe(0);
  });

  it("reorderScenes renumera; ids não citados vão pro fim", () => {
    const project = store.create({
      slug: "p",
      title: "P",
      kind: "promo",
      locales: ["pt-BR"],
    });
    for (const sceneId of ["a", "b", "c"]) {
      store.upsertScene({ projectId: project.id, sceneId });
    }
    const scenes = store.reorderScenes({
      projectId: project.id,
      sceneIds: ["c", "a"],
    });
    expect(scenes.map((s) => [s.sceneId, s.ord])).toEqual([
      ["c", 0],
      ["a", 1],
      ["b", 2],
    ]);
  });

  it("reorderScenes com cena desconhecida lança sem aplicar nada", () => {
    const project = store.create({
      slug: "p",
      title: "P",
      kind: "promo",
      locales: ["pt-BR"],
    });
    store.upsertScene({ projectId: project.id, sceneId: "a" });
    store.upsertScene({ projectId: project.id, sceneId: "b" });
    expect(() =>
      store.reorderScenes({ projectId: project.id, sceneIds: ["b", "z"] }),
    ).toThrow(/not found/);
    expect(store.listScenes(project.id).map((s) => s.sceneId)).toEqual([
      "a",
      "b",
    ]);
  });

  it("apagar cena leva roteiro e assets dela pela FK composta", () => {
    const project = store.create({
      slug: "p",
      title: "P",
      kind: "promo",
      locales: ["pt-BR"],
    });
    store.upsertScene({ projectId: project.id, sceneId: "a" });
    testDb
      .prepare(
        `INSERT INTO video_script_lines
          (id, project_id, scene_id, locale, kind, text, text_hash, ord)
         VALUES ('l1', ?, 'a', 'pt-BR', 'narration', 'oi', 'h', 0)`,
      )
      .run(project.id);
    testDb
      .prepare(
        `INSERT INTO video_assets (id, project_id, scene_id, kind, path, ref_ids, cost_cents, created_at)
         VALUES ('as1', ?, 'a', 'audio', '/tmp/a.mp3', '[]', 0, 1)`,
      )
      .run(project.id);

    store.removeScene(project.id, "a");

    expect(
      testDb.prepare("SELECT COUNT(*) AS n FROM video_script_lines").get(),
    ).toEqual({ n: 0 });
    expect(
      testDb.prepare("SELECT COUNT(*) AS n FROM video_assets").get(),
    ).toEqual({ n: 0 });
  });

  it("apagar a peça cascateia só o que é dela; o reuso sobrevive", () => {
    const templateId = seedReusables();
    const project = store.create({
      slug: "lancamento",
      title: "Lançamento",
      templateId,
      locales: ["pt-BR"],
    });
    // asset da peça vs asset COMPARTILHADO (project_id NULL)
    testDb
      .prepare(
        `INSERT INTO video_assets (id, project_id, kind, path, ref_ids, cost_cents, created_at)
         VALUES ('daPeca', ?, 'audio', '/tmp/a.mp3', '[]', 0, 1)`,
      )
      .run(project.id);
    testDb
      .prepare(
        `INSERT INTO video_assets (id, project_id, kind, path, ref_ids, cost_cents, created_at)
         VALUES ('compartilhado', NULL, 'character', '/tmp/ref.png', '[]', 0, 1)`,
      )
      .run();

    store.remove(project.id);

    const count = (sql: string): number =>
      (testDb.prepare(sql).get() as { n: number }).n;
    expect(count("SELECT COUNT(*) AS n FROM video_projects")).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM video_scenes")).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM video_project_cast")).toBe(0);
    expect(
      count("SELECT COUNT(*) AS n FROM video_assets WHERE id = 'daPeca'"),
    ).toBe(0);
    expect(
      count(
        "SELECT COUNT(*) AS n FROM video_assets WHERE id = 'compartilhado'",
      ),
    ).toBe(1);
    expect(count("SELECT COUNT(*) AS n FROM video_characters")).toBe(1);
    expect(count("SELECT COUNT(*) AS n FROM video_brand_kits")).toBe(1);
    expect(count("SELECT COUNT(*) AS n FROM video_templates")).toBe(1);
  });

  it("status e archivedAt são ortogonais: peça pronta pode ser arquivada", () => {
    const project = store.create({
      slug: "p",
      title: "P",
      kind: "promo",
      locales: ["pt-BR"],
    });
    store.update({ id: project.id, status: "done" });
    const archived = store.archive(project.id);
    expect(archived.status).toBe("done");
    expect(archived.archivedAt).not.toBeNull();
    expect(store.list().map((p) => p.id)).not.toContain(project.id);
    expect(
      store.list({ includeArchived: true, status: "done" }).map((p) => p.id),
    ).toContain(project.id);
  });

  it("status inválido é rejeitado pelo CHECK do banco", () => {
    const project = store.create({
      slug: "p",
      title: "P",
      kind: "promo",
      locales: ["pt-BR"],
    });
    expect(() =>
      store.update({
        id: project.id,
        status: "publicado" as never,
      }),
    ).toThrow();
  });

  it("setCast substitui o elenco inteiro", () => {
    const templateId = seedReusables();
    testDb
      .prepare(
        `INSERT INTO video_characters (id, name, canonical_description, visual_spec, created_at, updated_at)
         VALUES ('c2', 'Rafa', '', '{}', 1, 1)`,
      )
      .run();
    const project = store.create({
      slug: "p",
      title: "P",
      templateId,
      locales: ["pt-BR"],
    });
    const updated = store.setCast({
      projectId: project.id,
      cast: [{ characterId: "c2", roleInPiece: "coadjuvante" }],
    });
    expect(updated.cast.map((c) => c.characterId)).toEqual(["c2"]);
  });
});
