import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyAllMigrations } from "./test-support";

let testDb: Database.Database;
vi.mock("../db", () => ({
  getDb: () => testDb,
}));

import * as store from "./render-store";
import * as projectStore from "./project-store";

let projectId: string;

beforeEach(() => {
  testDb = new Database(":memory:");
  testDb.pragma("foreign_keys = ON");
  applyAllMigrations(testDb);
  projectId = projectStore.create({
    slug: "lancamento",
    title: "Lançamento",
    kind: "promo",
    locales: ["pt-BR"],
  }).id;
});

afterEach(() => {
  testDb.close();
});

describe("render-store", () => {
  it("enfileira em 'queued' com created_at — é por ele que a fila ordena", () => {
    const render = store.enqueue(projectId, "pt-BR");
    expect(render.status).toBe("queued");
    expect(render.createdAt).toBeGreaterThan(0);
    expect(render.startedAt).toBeNull();
    expect(render.finishedAt).toBeNull();
  });

  it("enqueue de peça inexistente lança", () => {
    expect(() => store.enqueue("nope", "pt-BR")).toThrow(/not found/);
  });

  it("list NÃO carrega o log; get carrega", () => {
    const render = store.enqueue(projectId, "pt-BR");
    store.appendLog(render.id, "linha de saída do Remotion\n");

    const [meta] = store.list({ projectId });
    expect(meta).not.toHaveProperty("log");
    expect(store.get(render.id)?.log).toContain("Remotion");
  });

  it("appendLog acumula e corta o COMEÇO quando estoura o teto", () => {
    const render = store.enqueue(projectId, "pt-BR");
    store.appendLog(render.id, "INICIO");
    store.appendLog(render.id, "x".repeat(200_000));
    store.appendLog(render.id, "FIM");

    const log = store.get(render.id)?.log ?? "";
    expect(log.length).toBe(200_000);
    expect(log.startsWith("INICIO")).toBe(false);
    expect(log.endsWith("FIM")).toBe(true);
  });

  it("update é PATCH e devolve o meta atualizado", () => {
    const render = store.enqueue(projectId, "pt-BR");
    store.update({ id: render.id, status: "running", startedAt: 100 });
    const done = store.update({
      id: render.id,
      status: "done",
      outPath: "/tmp/out.mp4",
      bytes: 4242,
      finishedAt: 200,
    });
    expect(done.status).toBe("done");
    expect(done.startedAt).toBe(100);
    expect(done.outPath).toBe("/tmp/out.mp4");
    expect(done.bytes).toBe(4242);
  });

  it("status fora do enum é rejeitado pelo CHECK do banco", () => {
    const render = store.enqueue(projectId, "pt-BR");
    expect(() =>
      store.update({ id: render.id, status: "cancelado" as never }),
    ).toThrow();
  });

  it("reconcileOrphans fecha os in-flight de um boot anterior e não toca nos terminais", () => {
    const queued = store.enqueue(projectId, "pt-BR");
    const running = store.enqueue(projectId, "pt-BR");
    store.update({ id: running.id, status: "running" });
    const done = store.enqueue(projectId, "pt-BR");
    store.update({ id: done.id, status: "done" });

    expect(store.reconcileOrphans()).toBe(2);
    expect(store.get(queued.id)?.status).toBe("failed");
    expect(store.get(running.id)?.status).toBe("failed");
    expect(store.get(running.id)?.finishedAt).not.toBeNull();
    expect(store.get(done.id)?.status).toBe("done");
  });

  it("apagar a peça leva os renders dela", () => {
    store.enqueue(projectId, "pt-BR");
    projectStore.remove(projectId);
    expect(store.list()).toEqual([]);
  });

  it("filtra por locale e status", () => {
    const a = store.enqueue(projectId, "pt-BR");
    store.update({ id: a.id, status: "done" });
    store.enqueue(projectId, "pt-BR");
    expect(store.list({ status: "done" }).map((r) => r.id)).toEqual([a.id]);
    expect(store.list({ locale: "en" })).toEqual([]);
  });
});
