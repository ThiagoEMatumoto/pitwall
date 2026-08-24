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
  library: {
    get: vi.fn().mockResolvedValue([]),
    replace: vi.fn().mockResolvedValue([]),
    remove: vi.fn().mockResolvedValue([]),
    installUrl: vi.fn(),
    onUpdated: vi.fn(() => () => {}),
  },
};

vi.mock("@/lib/ipc", () => ({ diagramsApi: mockApi }));

const { showToastMock, navigateToDiagramMock } = vi.hoisted(() => ({
  showToastMock: vi.fn(),
  navigateToDiagramMock: vi.fn(),
}));
vi.mock("@/features/notifications/toast-store", () => ({
  showToast: showToastMock,
}));
vi.mock("@/lib/nav", () => ({ navigateToDiagram: navigateToDiagramMock }));

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

  it("descarta resultado obsoleto quando outro select chega antes (corrida)", async () => {
    let resolveD1!: (d: Diagram) => void;
    const d2 = makeDiagram({ id: "d2", title: "Outro" });
    mockApi.get.mockImplementation((id: string) =>
      id === "d1"
        ? new Promise<Diagram>((r) => {
            resolveD1 = r;
          })
        : Promise.resolve(d2),
    );

    const p1 = useDiagramsStore.getState().select("d1");
    await useDiagramsStore.getState().select("d2");
    expect(useDiagramsStore.getState().selected?.id).toBe("d2");

    // O get("d1") resolve DEPOIS do select("d2"): resultado obsoleto, descarta.
    resolveD1(makeDiagram({ id: "d1" }));
    await p1;
    expect(useDiagramsStore.getState().selected?.id).toBe("d2");
  });

  it("select(null) durante get em voo invalida o resultado pendente", async () => {
    let resolveD1!: (d: Diagram) => void;
    mockApi.get.mockImplementation(
      () =>
        new Promise<Diagram>((r) => {
          resolveD1 = r;
        }),
    );

    const p1 = useDiagramsStore.getState().select("d1");
    await useDiagramsStore.getState().select(null);

    resolveD1(makeDiagram({ id: "d1" }));
    await p1;
    expect(useDiagramsStore.getState().selected).toBeNull();
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

describe("toast de atualização remota (diagrama não aberto)", () => {
  // O throttle é módulo-level e sobrevive entre testes — cada teste usa um id
  // próprio pra não colidir com a janela de 5s de outro teste.

  it("dispara toast com ação Abrir quando version cresce e id ≠ selecionado", () => {
    useDiagramsStore.setState({
      selected: makeDiagram(),
      diagrams: [makeMeta(), makeMeta({ id: "t1", version: 1 })],
    });
    useDiagramsStore.getState().startWatch();
    updatedHandler!(makeDiagram({ id: "t1", title: "Arch", version: 2 }));

    expect(showToastMock).toHaveBeenCalledTimes(1);
    const toast = showToastMock.mock.calls[0][0] as {
      title: string;
      actionLabel: string;
      onAction: () => void;
    };
    expect(toast.title).toBe('Claude atualizou "Arch"');
    expect(toast.actionLabel).toBe("Abrir");
    toast.onAction();
    expect(navigateToDiagramMock).toHaveBeenCalledWith("t1");
  });

  it("não dispara pro diagrama selecionado (fluxo remoteScene cobre)", () => {
    useDiagramsStore.setState({
      selected: makeDiagram(),
      diagrams: [makeMeta()],
    });
    useDiagramsStore.getState().startWatch();
    updatedHandler!(makeDiagram({ version: 2 }));
    expect(showToastMock).not.toHaveBeenCalled();
  });

  it("não dispara quando a version não cresce (rename/archive)", () => {
    useDiagramsStore.setState({
      selected: makeDiagram(),
      diagrams: [makeMeta(), makeMeta({ id: "t2", version: 3 })],
    });
    useDiagramsStore.getState().startWatch();
    updatedHandler!(makeDiagram({ id: "t2", title: "Renomeado", version: 3 }));
    expect(showToastMock).not.toHaveBeenCalled();
  });

  it("não dispara pra diagrama desconhecido na lista (sem version anterior)", () => {
    useDiagramsStore.setState({ selected: makeDiagram(), diagrams: [] });
    useDiagramsStore.getState().startWatch();
    updatedHandler!(makeDiagram({ id: "t3", version: 5 }));
    expect(showToastMock).not.toHaveBeenCalled();
  });

  it("anti-spam: no máximo 1 toast por diagrama a cada 5s", () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(100_000);
    try {
      useDiagramsStore.setState({
        selected: makeDiagram(),
        diagrams: [makeMeta({ id: "t4", version: 1 })],
      });
      useDiagramsStore.getState().startWatch();

      updatedHandler!(makeDiagram({ id: "t4", version: 2 }));
      updatedHandler!(makeDiagram({ id: "t4", version: 3 }));
      expect(showToastMock).toHaveBeenCalledTimes(1);

      // Passada a janela de 5s, o próximo bump volta a avisar.
      nowSpy.mockReturnValue(105_100);
      updatedHandler!(makeDiagram({ id: "t4", version: 4 }));
      expect(showToastMock).toHaveBeenCalledTimes(2);
    } finally {
      nowSpy.mockRestore();
    }
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
