import { describe, expect, it } from "vitest";
import type { DiagramFolder, DiagramMeta } from "../../../../shared/types/ipc";
import {
  sectionDiagrams,
  sectionTitle,
  shiftCount,
  unfileMissing,
  visibleDiagrams,
} from "./diagram-hub";

const meta = (id: string, over: Partial<DiagramMeta> = {}): DiagramMeta => ({
  id,
  title: id,
  kind: "flow",
  status: "active",
  version: 1,
  sourceFormat: "scene",
  thumbnail: null,
  folderId: null,
  createdAt: 1,
  updatedAt: 1,
  ...over,
});
const folder = (id: string, docCount = 0): DiagramFolder => ({
  id,
  name: id.toUpperCase(),
  color: null,
  sortOrder: 0,
  docCount,
  createdAt: 1,
  updatedAt: 1,
});

describe("diagram-hub", () => {
  const list = [meta("a", { folderId: "f1" }), meta("b")];

  it("sectionDiagrams separa recentes, sem pasta, pasta e arquivados", () => {
    const archived = [meta("z", { status: "archived" })];
    expect(sectionDiagrams("recent", list, archived)).toHaveLength(2);
    expect(sectionDiagrams("unfiled", list, archived).map((d) => d.id)).toEqual(["b"]);
    expect(sectionDiagrams("f1", list, archived).map((d) => d.id)).toEqual(["a"]);
    expect(sectionDiagrams("archived", list, archived)).toBe(archived);
  });

  it("visibleDiagrams busca sem acento/caixa e ordena por nome ou recência", () => {
    const items = [
      meta("1", { title: "Fluxo de Autenticação", updatedAt: 1 }),
      meta("2", { title: "Arquitetura", updatedAt: 5 }),
    ];
    expect(visibleDiagrams(items, "autenticacao", "recent").map((d) => d.id)).toEqual(["1"]);
    expect(visibleDiagrams(items, "", "recent").map((d) => d.id)).toEqual(["2", "1"]);
    expect(visibleDiagrams(items, "", "name").map((d) => d.id)).toEqual(["2", "1"]);
  });

  it("sectionTitle usa o nome da pasta", () => {
    expect(sectionTitle("f1", [folder("f1")])).toBe("F1");
    expect(sectionTitle("unfiled", [])).toBe("Sem pasta");
  });

  it("shiftCount move uma unidade entre pastas sem ficar negativo", () => {
    const out = shiftCount([folder("f1", 0), folder("f2", 1)], "f1", "f2");
    expect(out.map((f) => f.docCount)).toEqual([0, 2]);
  });

  it("unfileMissing zera folderId de pasta que sumiu e preserva a referência quando nada muda", () => {
    expect(unfileMissing(list, []).map((d) => d.folderId)).toEqual([null, null]);
    expect(unfileMissing(list, [folder("f1")])).toBe(list);
  });
});
