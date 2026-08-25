import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyAllMigrations } from "./test-support";

let testDb: Database.Database;
vi.mock("../db", () => ({
  getDb: () => testDb,
}));

import * as store from "./script-store";
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
    locales: ["pt-BR", "en"],
  });
  projectId = project.id;
  projectStore.upsertScene({ projectId, sceneId: "cold-open", ord: 0 });
  projectStore.upsertScene({ projectId, sceneId: "logo", ord: 1 });
});

afterEach(() => {
  testDb.close();
});

describe("script-store", () => {
  it("grava o roteiro do locale e calcula o textHash do texto puro", () => {
    const lines = store.set({
      projectId,
      locale: "pt-BR",
      lines: [
        {
          sceneId: "cold-open",
          kind: "narration",
          text: "Você roda uma equipe.",
        },
      ],
    });
    expect(lines).toHaveLength(1);
    expect(lines[0].textHash).toBe(
      createHash("sha256").update("Você roda uma equipe.").digest("hex"),
    );
  });

  it("set substitui só o locale gravado — o outro idioma não é tocado", () => {
    store.set({
      projectId,
      locale: "pt-BR",
      lines: [{ sceneId: "cold-open", kind: "narration", text: "pt um" }],
    });
    store.set({
      projectId,
      locale: "en",
      lines: [{ sceneId: "cold-open", kind: "narration", text: "en one" }],
    });
    store.set({
      projectId,
      locale: "pt-BR",
      lines: [{ sceneId: "cold-open", kind: "narration", text: "pt dois" }],
    });
    expect(store.list(projectId, "pt-BR").map((l) => l.text)).toEqual([
      "pt dois",
    ]);
    expect(store.list(projectId, "en").map((l) => l.text)).toEqual(["en one"]);
  });

  it("ord automático é por (cena, tipo): duas falas na mesma cena não colidem", () => {
    const lines = store.set({
      projectId,
      locale: "pt-BR",
      lines: [
        { sceneId: "cold-open", kind: "narration", text: "primeira" },
        { sceneId: "cold-open", kind: "narration", text: "segunda" },
        { sceneId: "cold-open", kind: "on_screen", text: "um agente" },
        { sceneId: "logo", kind: "narration", text: "outra cena" },
      ],
    });
    const narracao = lines.filter(
      (l) => l.sceneId === "cold-open" && l.kind === "narration",
    );
    expect(narracao.map((l) => l.ord)).toEqual([0, 1]);
    expect(
      lines.filter((l) => l.kind === "on_screen").map((l) => l.ord),
    ).toEqual([0]);
  });

  it("list ordena pela ordem das CENAS, não pela de inserção", () => {
    store.set({
      projectId,
      locale: "pt-BR",
      lines: [
        { sceneId: "logo", kind: "narration", text: "da segunda cena" },
        { sceneId: "cold-open", kind: "narration", text: "da primeira cena" },
      ],
    });
    expect(store.list(projectId, "pt-BR").map((l) => l.sceneId)).toEqual([
      "cold-open",
      "logo",
    ]);
  });

  it("narrationForScene concatena as falas da cena na ordem e ignora on_screen", () => {
    store.set({
      projectId,
      locale: "pt-BR",
      lines: [
        {
          sceneId: "cold-open",
          kind: "narration",
          text: "Você roda uma equipe.",
        },
        {
          sceneId: "cold-open",
          kind: "narration",
          text: "E equipe sem cockpit vira ruído.",
        },
        { sceneId: "cold-open", kind: "on_screen", text: "ruído" },
      ],
    });
    expect(store.narrationForScene(projectId, "pt-BR", "cold-open")).toBe(
      "Você roda uma equipe. E equipe sem cockpit vira ruído.",
    );
    expect(store.narrationForScene(projectId, "pt-BR", "logo")).toBe("");
  });

  it("linha apontando pra cena inexistente é rejeitada pelo banco (FK composta)", () => {
    expect(() =>
      store.set({
        projectId,
        locale: "pt-BR",
        lines: [{ sceneId: "cena-fantasma", kind: "narration", text: "oi" }],
      }),
    ).toThrow();
  });

  it("lote que falha não deixa o roteiro meio-substituído", () => {
    store.set({
      projectId,
      locale: "pt-BR",
      lines: [{ sceneId: "cold-open", kind: "narration", text: "original" }],
    });
    expect(() =>
      store.set({
        projectId,
        locale: "pt-BR",
        lines: [
          { sceneId: "cold-open", kind: "narration", text: "novo" },
          { sceneId: "cena-fantasma", kind: "narration", text: "quebra" },
        ],
      }),
    ).toThrow();
    expect(store.list(projectId, "pt-BR").map((l) => l.text)).toEqual([
      "original",
    ]);
  });

  it("audioHashOf muda com a voz e com o modelo, não só com o texto", () => {
    const a = store.audioHashOf("oi", "voz1", "m1");
    expect(store.audioHashOf("oi", "voz1", "m1")).toBe(a);
    expect(store.audioHashOf("oi", "voz2", "m1")).not.toBe(a);
    expect(store.audioHashOf("oi", "voz1", "m2")).not.toBe(a);
    expect(store.audioHashOf("olá", "voz1", "m1")).not.toBe(a);
  });

  it("localesWithScript devolve só o que tem linha gravada", () => {
    store.set({
      projectId,
      locale: "pt-BR",
      lines: [{ sceneId: "cold-open", kind: "narration", text: "oi" }],
    });
    expect(store.localesWithScript(projectId)).toEqual(["pt-BR"]);
  });

  it("kind fora do enum é rejeitado pelo CHECK do banco", () => {
    expect(() =>
      store.set({
        projectId,
        locale: "pt-BR",
        lines: [{ sceneId: "cold-open", kind: "legenda" as never, text: "oi" }],
      }),
    ).toThrow();
  });
});
