import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyAllMigrations } from "./test-support";

let testDb: Database.Database;
vi.mock("../db", () => ({
  getDb: () => testDb,
}));

import * as store from "./brand-kit-store";

beforeEach(() => {
  testDb = new Database(":memory:");
  testDb.pragma("foreign_keys = ON");
  applyAllMigrations(testDb);
});

afterEach(() => {
  testDb.close();
});

describe("brand-kit-store", () => {
  it("cria com defaults e devolve as entidades em camelCase", () => {
    const kit = store.create({ name: "  Pitwall  " });
    expect(kit.name).toBe("Pitwall");
    expect(kit.tokens).toEqual({ palette: {}, typography: {} });
    expect(kit.doDont).toEqual({ do: [], dont: [] });
    expect(kit.logoAssetId).toBeNull();
    expect(kit.ttsVoices).toEqual({});
    expect(store.get(kit.id)).toEqual(kit);
  });

  it("update é PATCH: campo omitido não é apagado", () => {
    const kit = store.create({
      name: "Pitwall",
      toneOfVoice: "seco",
      ttsVoices: { "pt-BR": "voz1" },
    });
    const updated = store.update({ id: kit.id, name: "Pitwall F1" });
    expect(updated.name).toBe("Pitwall F1");
    expect(updated.toneOfVoice).toBe("seco");
    expect(updated.ttsVoices).toEqual({ "pt-BR": "voz1" });
  });

  it("logoAssetId null explícito solta o logo; omitido preserva", () => {
    testDb
      .prepare(
        `INSERT INTO video_assets (id, kind, path, ref_ids, cost_cents, created_at)
         VALUES ('a1', 'keyvisual', '/tmp/logo.png', '[]', 0, 1)`,
      )
      .run();
    const kit = store.create({ name: "Pitwall", logoAssetId: "a1" });
    expect(store.update({ id: kit.id, name: "X" }).logoAssetId).toBe("a1");
    expect(
      store.update({ id: kit.id, logoAssetId: null }).logoAssetId,
    ).toBeNull();
  });

  it("row com JSON corrompido não derruba o get()", () => {
    const kit = store.create({ name: "Pitwall" });
    testDb
      .prepare(
        "UPDATE video_brand_kits SET tokens = ?, do_dont = ?, tts_voices = ? WHERE id = ?",
      )
      .run("{nao é json", "[]", "isto também não", kit.id);
    const read = store.get(kit.id);
    expect(read?.tokens).toEqual({ palette: {}, typography: {} });
    expect(read?.doDont).toEqual({ do: [], dont: [] });
    expect(read?.ttsVoices).toEqual({});
  });

  it("descarta valores não-string da paleta e do mapa de vozes", () => {
    const kit = store.create({ name: "Pitwall" });
    testDb
      .prepare(
        "UPDATE video_brand_kits SET tokens = ?, tts_voices = ? WHERE id = ?",
      )
      .run(
        '{"palette":{"accent":"#f5b","bad":7}}',
        '{"pt-BR":"voz1","en":42}',
        kit.id,
      );
    const read = store.get(kit.id);
    expect(read?.tokens.palette).toEqual({ accent: "#f5b" });
    expect(read?.ttsVoices).toEqual({ "pt-BR": "voz1" });
  });

  it("voiceForLocale devolve a voz da marca, ou null quando não há", () => {
    const kit = store.create({
      name: "Pitwall",
      ttsVoices: { "pt-BR": "voz1" },
    });
    expect(store.voiceForLocale(kit.id, "pt-BR")).toBe("voz1");
    expect(store.voiceForLocale(kit.id, "en")).toBeNull();
    expect(store.voiceForLocale(null, "pt-BR")).toBeNull();
  });

  it("remove solta o brand kit dos templates em vez de apagá-los", () => {
    const kit = store.create({ name: "Pitwall" });
    testDb
      .prepare(
        `INSERT INTO video_templates
          (id, kind, name, description, scene_blueprint, brand_kit_id, default_cast, created_at, updated_at)
         VALUES ('t1', 'promo', 'Promo', '', '[]', ?, '[]', 1, 1)`,
      )
      .run(kit.id);

    store.remove(kit.id);

    const row = testDb
      .prepare("SELECT brand_kit_id FROM video_templates WHERE id = 't1'")
      .get() as {
      brand_kit_id: string | null;
    };
    expect(row.brand_kit_id).toBeNull();
    expect(store.get(kit.id)).toBeNull();
  });

  it("get de id inexistente devolve null; remove lança", () => {
    expect(store.get("nope")).toBeNull();
    expect(() => store.remove("nope")).toThrow(/not found/);
  });
});
