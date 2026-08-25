import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyAllMigrations } from "./test-support";

let testDb: Database.Database;
vi.mock("../db", () => ({
  getDb: () => testDb,
}));

import * as store from "./character-store";

function seedAsset(id: string): void {
  testDb
    .prepare(
      `INSERT INTO video_assets (id, kind, path, ref_ids, cost_cents, created_at)
       VALUES (?, 'character', ?, '[]', 0, 1)`,
    )
    .run(id, `/tmp/${id}.png`);
}

beforeEach(() => {
  testDb = new Database(":memory:");
  testDb.pragma("foreign_keys = ON");
  applyAllMigrations(testDb);
  seedAsset("a1");
  seedAsset("a2");
  seedAsset("a3");
});

afterEach(() => {
  testDb.close();
});

describe("character-store", () => {
  it("cria com visualSpec vazia e devolve refs vazias", () => {
    const c = store.create({ name: "Nina" });
    expect(c.visualSpec).toEqual({
      canonical: "",
      invariants: [],
      negative: [],
    });
    expect(c.refs).toEqual([]);
    expect(c.archivedAt).toBeNull();
  });

  it("guarda o visualSpec inteiro — é ele que sustenta a consistência", () => {
    const c = store.create({
      name: "Nina",
      visualSpec: {
        canonical: "engenheira de 30 anos, cabelo curto preto",
        invariants: ["cabelo curto preto", "jaqueta de corrida azul"],
        negative: ["óculos", "barba"],
      },
    });
    expect(store.get(c.id)?.visualSpec.invariants).toEqual([
      "cabelo curto preto",
      "jaqueta de corrida azul",
    ]);
    expect(store.get(c.id)?.visualSpec.negative).toEqual(["óculos", "barba"]);
  });

  it("setRefs substitui o conjunto inteiro e usa a ordem do array como ord", () => {
    const c = store.create({ name: "Nina" });
    store.setRefs({
      characterId: c.id,
      refs: [
        { assetId: "a1", isApproved: true },
        { assetId: "a2", isApproved: false },
      ],
    });
    const replaced = store.setRefs({
      characterId: c.id,
      refs: [
        { assetId: "a3", isApproved: true },
        { assetId: "a1", isApproved: true },
      ],
    });
    expect(replaced.refs.map((r) => [r.assetId, r.ord])).toEqual([
      ["a3", 0],
      ["a1", 1],
    ]);
    expect(replaced.refs.some((r) => r.assetId === "a2")).toBe(false);
  });

  it("approvedRefAssetIds só devolve as aprovadas, na ordem", () => {
    const c = store.create({ name: "Nina" });
    store.setRefs({
      characterId: c.id,
      refs: [
        { assetId: "a1", isApproved: false },
        { assetId: "a2", isApproved: true },
        { assetId: "a3", isApproved: true },
      ],
    });
    expect(store.approvedRefAssetIds(c.id)).toEqual(["a2", "a3"]);
  });

  it("apagar o asset leva a ref junto (CASCADE), sem levar o personagem", () => {
    const c = store.create({ name: "Nina" });
    store.setRefs({
      characterId: c.id,
      refs: [{ assetId: "a1", isApproved: true }],
    });
    testDb.prepare("DELETE FROM video_assets WHERE id = 'a1'").run();
    expect(store.get(c.id)?.refs).toEqual([]);
    expect(store.get(c.id)?.name).toBe("Nina");
  });

  it("archive tira da lista default e unarchive traz de volta", () => {
    const c = store.create({ name: "Nina" });
    store.archive(c.id);
    expect(store.list().map((x) => x.id)).not.toContain(c.id);
    expect(store.list({ includeArchived: true }).map((x) => x.id)).toContain(
      c.id,
    );
    store.unarchive(c.id);
    expect(store.list().map((x) => x.id)).toContain(c.id);
  });

  it("list filtra por busca no nome", () => {
    store.create({ name: "Nina" });
    store.create({ name: "Rafa" });
    expect(store.list({ search: "ni" }).map((c) => c.name)).toEqual(["Nina"]);
  });

  it("update de personagem inexistente lança", () => {
    expect(() => store.update({ id: "nope", name: "X" })).toThrow(/not found/);
  });
});
