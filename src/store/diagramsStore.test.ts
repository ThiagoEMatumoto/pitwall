import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Diagram, DiagramMeta } from "../../shared/types/ipc";

// Handlers capturados pelas assinaturas do watch — o teste emite broadcasts
// chamando-os direto.
let updatedHandler: ((payload: unknown) => void) | null = null;
let deletedHandler: ((payload: unknown) => void) | null = null;
let linksHandler: ((payload: unknown) => void) | null = null;
let subscribeCount = 0;

const mockApi = {
  list: vi.fn(),
  get: vi.fn(),
  create: vi.fn(),
  updateScene: vi.fn(),
  rename: vi.fn(),
  archive: vi.fn(),
  unarchive: vi.fn(),
  delete: vi.fn(),
  listVersions: vi.fn(),
  onUpdated: vi.fn((h: (payload: unknown) => void) => {
    subscribeCount++;
    updatedHandler = h;
    return () => {
      updatedHandler = null;
    };
  }),
  onDeleted: vi.fn((h: (payload: unknown) => void) => {
    deletedHandler = h;
    return () => {
      deletedHandler = null;
    };
  }),
  onLinksUpdated: vi.fn((h: (payload: unknown) => void) => {
    linksHandler = h;
    return () => {
      linksHandler = null;
    };
  }),
};

vi.mock("@/lib/ipc", () => ({ diagramsApi: mockApi }));

const { useDiagramsStore } = await import("./diagramsStore");

function makeMeta(over: Partial<DiagramMeta> = {}): DiagramMeta {
  return {
    id: "d1",
    title: "Fluxo",
    kind: "flow",
    status: "active",
    version: 1,
    sourceFormat: "skeleton",
    thumbnail: null,
    createdAt: 1000,
    updatedAt: 2000,
    ...over,
  };
}

function makeDiagram(over: Partial<Diagram> = {}): Diagram {
  return {
    ...makeMeta(),
    scene: { elements: [{ id: "a", version: 1 }] },
    links: [],
    ...over,
  };
}

beforeEach(() => {
  useDiagramsStore.getState().stopWatch();
  useDiagramsStore.setState({
    diagrams: [],
    selected: null,
    showArchived: false,
    loading: false,
    error: null,
    remoteScene: null,
  });
  vi.clearAllMocks();
  subscribeCount = 0;
  updatedHandler = null;
  deletedHandler = null;
  linksHandler = null;
});

describe("load", () => {
  it("carrega a lista com filtro active por default", async () => {
    mockApi.list.mockResolvedValue([makeMeta()]);
    await useDiagramsStore.getState().load();
    expect(mockApi.list).toHaveBeenCalledWith({ status: "active" });
    expect(useDiagramsStore.getState().diagrams).toHaveLength(1);
    expect(useDiagramsStore.getState().loading).toBe(false);
  });

  it("showArchived → filtro all", async () => {
    mockApi.list.mockResolvedValue([]);
    await useDiagramsStore.getState().setShowArchived(true);
    expect(mockApi.list).toHaveBeenCalledWith({ status: "all" });
  });

  it("erro vira state.error, sem lançar", async () => {
    mockApi.list.mockRejectedValue(new Error("boom"));
    await useDiagramsStore.getState().load();
    expect(useDiagramsStore.getState().error).toBe("boom");
    expect(useDiagramsStore.getState().loading).toBe(false);
  });
});

describe("select", () => {
  it("busca o diagrama completo e seleciona", async () => {
    const d = makeDiagram();
    mockApi.get.mockResolvedValue(d);
    await useDiagramsStore.getState().select("d1");
    expect(useDiagramsStore.getState().selected?.id).toBe("d1");
    expect(useDiagramsStore.getState().selected?.scene.elements).toHaveLength(
      1,
    );
  });

  it("select(null) limpa seleção e remoteScene", async () => {
    useDiagramsStore.setState({
      selected: makeDiagram(),
      remoteScene: { scene: { elements: [] }, nonce: 1 },
    });
    await useDiagramsStore.getState().select(null);
    expect(useDiagramsStore.getState().selected).toBeNull();
    expect(useDiagramsStore.getState().remoteScene).toBeNull();
  });
});

describe("watch", () => {
  it("startWatch duas vezes assina só uma vez (guard StrictMode)", () => {
    useDiagramsStore.getState().startWatch();
    useDiagramsStore.getState().startWatch();
    expect(subscribeCount).toBe(1);
  });

  it("stopWatch permite reassinar (guard resetado)", () => {
    useDiagramsStore.getState().startWatch();
    useDiagramsStore.getState().stopWatch();
    useDiagramsStore.getState().startWatch();
    expect(subscribeCount).toBe(2);
  });

  it("onUpdated upserta na lista e repassa cena pro editor quando é o selecionado", () => {
    useDiagramsStore.setState({
      selected: makeDiagram(),
      diagrams: [makeMeta()],
    });
    useDiagramsStore.getState().startWatch();

    const incoming = makeDiagram({
      title: "Fluxo v2",
      version: 2,
      updatedAt: 3000,
      scene: { elements: [{ id: "a", version: 2 }] },
    });
    updatedHandler!(incoming);

    const s = useDiagramsStore.getState();
    expect(s.diagrams).toHaveLength(1);
    expect(s.diagrams[0].title).toBe("Fluxo v2");
    expect(s.selected?.title).toBe("Fluxo v2");
    // A cena do selected NÃO é sobrescrita (o editor é a fonte da verdade)…
    expect(s.selected?.scene.elements).toEqual([{ id: "a", version: 1 }]);
    // …a cena nova viaja pelo remoteScene, com nonce.
    expect(s.remoteScene?.scene.elements).toEqual([{ id: "a", version: 2 }]);
    const firstNonce = s.remoteScene!.nonce;

    updatedHandler!(makeDiagram({ version: 3 }));
    expect(useDiagramsStore.getState().remoteScene!.nonce).toBe(firstNonce + 1);
  });

  it("onUpdated de outro diagrama não mexe na seleção", () => {
    useDiagramsStore.setState({
      selected: makeDiagram(),
      diagrams: [makeMeta()],
    });
    useDiagramsStore.getState().startWatch();
    updatedHandler!(makeDiagram({ id: "d2", title: "Outro" }));
    const s = useDiagramsStore.getState();
    expect(s.diagrams).toHaveLength(2);
    expect(s.selected?.id).toBe("d1");
    expect(s.remoteScene).toBeNull();
  });

  it("diagrama arquivado some da lista quando showArchived está desligado", () => {
    useDiagramsStore.setState({ diagrams: [makeMeta()] });
    useDiagramsStore.getState().startWatch();
    updatedHandler!(makeDiagram({ status: "archived" }));
    expect(useDiagramsStore.getState().diagrams).toHaveLength(0);
  });

  it("onDeleted remove da lista e limpa seleção", () => {
    useDiagramsStore.setState({
      selected: makeDiagram(),
      diagrams: [makeMeta()],
    });
    useDiagramsStore.getState().startWatch();
    deletedHandler!({ id: "d1" });
    const s = useDiagramsStore.getState();
    expect(s.diagrams).toHaveLength(0);
    expect(s.selected).toBeNull();
  });

  it("onLinksUpdated atualiza links do selecionado", () => {
    useDiagramsStore.setState({ selected: makeDiagram() });
    useDiagramsStore.getState().startWatch();
    linksHandler!({
      diagramId: "d1",
      links: [{ diagramId: "d1", parentType: "feature", parentId: "f1" }],
    });
    expect(useDiagramsStore.getState().selected?.links).toHaveLength(1);
  });
});

describe("saveScene", () => {
  it("atualiza meta na lista mas preserva a cena local do selecionado", async () => {
    useDiagramsStore.setState({
      selected: makeDiagram(),
      diagrams: [makeMeta()],
    });
    mockApi.updateScene.mockResolvedValue(
      makeDiagram({
        version: 2,
        scene: { elements: [{ id: "a", version: 9 }] },
      }),
    );
    await useDiagramsStore.getState().saveScene({
      id: "d1",
      scene: { elements: [{ id: "a", version: 9 }] },
      snapshot: false,
    });
    const s = useDiagramsStore.getState();
    expect(s.diagrams[0].version).toBe(2);
    expect(s.selected?.scene.elements).toEqual([{ id: "a", version: 1 }]);
  });
});
