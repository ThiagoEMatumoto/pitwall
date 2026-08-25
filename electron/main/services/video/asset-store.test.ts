import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyAllMigrations } from "./test-support";

let testDb: Database.Database;
vi.mock("../db", () => ({
  getDb: () => testDb,
}));

import * as store from "./asset-store";
import * as projectStore from "./project-store";

let projectId: string;

beforeEach(() => {
  testDb = new Database(":memory:");
  testDb.pragma("foreign_keys = ON");
  applyAllMigrations(testDb);
  const project = projectStore.create({
    slug: "lancamento",
    title: "Lançamento",
    kind: "promo",
    locales: ["pt-BR"],
  });
  projectId = project.id;
  projectStore.upsertScene({ projectId, sceneId: "cold-open" });
});

afterEach(() => {
  testDb.close();
});

describe("asset-store", () => {
  it("registra com a procedência que reproduz o asset", () => {
    const asset = store.register({
      projectId,
      sceneId: "cold-open",
      kind: "keyvisual",
      path: "/tmp/kv.png",
      hash: "h1",
      provider: "gemini",
      model: "gemini-3.1-flash-image",
      prompt: "escuro absoluto, cursor mono",
      refIds: ["r1", "r2"],
      costCents: 7,
    });
    expect(asset.refIds).toEqual(["r1", "r2"]);
    expect(store.get(asset.id)).toEqual(asset);
  });

  it("registerOrReuse não paga duas vezes pelo mesmo hash", () => {
    const first = store.registerOrReuse({
      projectId,
      kind: "audio",
      path: "/tmp/a.mp3",
      hash: "h1",
      costCents: 3,
    });
    const second = store.registerOrReuse({
      projectId,
      kind: "audio",
      path: "/tmp/a.mp3",
      hash: "h1",
      costCents: 3,
    });
    expect(first.reused).toBe(false);
    expect(second.reused).toBe(true);
    expect(second.asset.id).toBe(first.asset.id);
    expect(store.spentCents(projectId)).toBe(3);
  });

  it("hash null não deduplica: sem chave de reuso, cada import é um asset", () => {
    store.register({ projectId, kind: "texture", path: "/tmp/1.png" });
    store.register({ projectId, kind: "texture", path: "/tmp/2.png" });
    expect(store.list({ projectId, kind: "texture" })).toHaveLength(2);
  });

  it("mesmo hash em kinds diferentes são assets diferentes", () => {
    store.registerOrReuse({
      projectId,
      kind: "audio",
      path: "/tmp/a",
      hash: "h",
    });
    const outro = store.registerOrReuse({
      projectId,
      kind: "sfx",
      path: "/tmp/b",
      hash: "h",
    });
    expect(outro.reused).toBe(false);
  });

  it("findByHash separa o compartilhado (projectId null) do da peça", () => {
    store.register({
      projectId: null,
      kind: "character",
      path: "/tmp/ref.png",
      hash: "h",
    });
    store.register({
      projectId,
      kind: "character",
      path: "/tmp/cena.png",
      hash: "h",
    });

    expect(store.findByHash(null, "character", "h")?.path).toBe("/tmp/ref.png");
    expect(store.findByHash(projectId, "character", "h")?.path).toBe(
      "/tmp/cena.png",
    );
  });

  it("registerOrReuse reusa também o compartilhado, que o índice único não cobre", () => {
    // NULLs são distintos num índice único do SQLite: o banco NÃO impede dois
    // compartilhados com o mesmo hash — quem impede é o lookup do store.
    const first = store.registerOrReuse({
      projectId: null,
      kind: "sfx",
      path: "/tmp/whoosh.wav",
      hash: "receita",
    });
    const second = store.registerOrReuse({
      projectId: null,
      kind: "sfx",
      path: "/tmp/whoosh.wav",
      hash: "receita",
    });
    expect(second.reused).toBe(true);
    expect(second.asset.id).toBe(first.asset.id);
  });

  it("list com projectId null explícito devolve SÓ os compartilhados", () => {
    store.register({ projectId, kind: "audio", path: "/tmp/a.mp3" });
    store.register({
      projectId: null,
      kind: "character",
      path: "/tmp/ref.png",
    });

    expect(store.list({ projectId: null }).map((a) => a.path)).toEqual([
      "/tmp/ref.png",
    ]);
    expect(store.list()).toHaveLength(2);
    expect(store.list({ projectId }).map((a) => a.path)).toEqual([
      "/tmp/a.mp3",
    ]);
  });

  it("refIds corrompido no banco não derruba o get()", () => {
    const asset = store.register({
      projectId,
      kind: "keyvisual",
      path: "/tmp/kv.png",
    });
    testDb
      .prepare("UPDATE video_assets SET ref_ids = ? WHERE id = ?")
      .run("{}", asset.id);
    expect(store.get(asset.id)?.refIds).toEqual([]);
  });

  it("kind fora do enum é rejeitado pelo CHECK do banco", () => {
    expect(() =>
      store.register({ projectId, kind: "video" as never, path: "/tmp/x.mp4" }),
    ).toThrow();
  });

  it("remove tira a linha; asset inexistente lança", () => {
    const asset = store.register({
      projectId,
      kind: "audio",
      path: "/tmp/a.mp3",
    });
    store.remove(asset.id);
    expect(store.get(asset.id)).toBeNull();
    expect(() => store.remove(asset.id)).toThrow(/not found/);
  });

  it("spentCents soma só o que é da peça", () => {
    store.register({ projectId, kind: "audio", path: "/tmp/a", costCents: 5 });
    store.register({
      projectId,
      kind: "keyvisual",
      path: "/tmp/b",
      costCents: 7,
    });
    store.register({
      projectId: null,
      kind: "character",
      path: "/tmp/c",
      costCents: 100,
    });
    expect(store.spentCents(projectId)).toBe(12);
  });
});
