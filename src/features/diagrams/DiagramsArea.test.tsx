import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Diagram, DiagramMeta } from "../../../shared/types/ipc";
import { DIAGRAM_LIBRARY_CATALOG } from "../../../shared/diagram-library-catalog";

// A lib real do Excalidraw não roda em jsdom (canvas/fonts) — o smoke valida a
// costura da área, não o canvas.
vi.mock("./excalidraw-lazy", () => ({
  LazyExcalidraw: () => (
    <div data-testid="excalidraw-mock" className="excalidraw" />
  ),
  loadExcalidraw: () => new Promise(() => {}),
  loadExcalidrawUtils: () => new Promise(() => {}),
}));

vi.mock("@/lib/ipc", () => ({
  diagramsApi: {
    list: vi.fn().mockResolvedValue([]),
    get: vi.fn(),
    create: vi.fn(),
    createFromTemplate: vi.fn(),
    updateScene: vi.fn(),
    rename: vi.fn(),
    archive: vi.fn(),
    unarchive: vi.fn(),
    delete: vi.fn(),
    listVersions: vi.fn().mockResolvedValue([]),
    onUpdated: vi.fn(() => () => {}),
    onDeleted: vi.fn(() => () => {}),
    onLinksUpdated: vi.fn(() => () => {}),
    library: {
      get: vi.fn().mockResolvedValue([]),
      replace: vi.fn().mockResolvedValue([]),
      remove: vi.fn().mockResolvedValue([]),
      installUrl: vi.fn(),
      catalog: vi.fn(),
      installCatalog: vi.fn(),
      removeCatalog: vi.fn(),
      onUpdated: vi.fn(() => () => {}),
    },
  },
}));

// Evita puxar appStore/tasksStore/featuresStore (cadeia pesada de IPC) só pra
// renderizar chips de vínculo.
vi.mock("@/lib/nav", () => ({
  navigateToFeature: vi.fn(),
  navigateToTask: vi.fn(),
  navigateToProject: vi.fn(),
  navigateToDiagram: vi.fn(),
}));

const { DiagramsArea } = await import("./DiagramsArea");
const { useDiagramsStore } = await import("@/store/diagramsStore");
const { diagramsApi } = await import("@/lib/ipc");
// O load() do effect recarrega a lista — cada teste aponta o mock pro mesmo
// estado pra não clobberar o setState.
const listMock = diagramsApi.list as ReturnType<typeof vi.fn>;

function makeMeta(over: Partial<DiagramMeta> = {}): DiagramMeta {
  return {
    id: "d1",
    title: "Fluxo IPC",
    kind: "flow",
    status: "active",
    version: 1,
    sourceFormat: "skeleton",
    thumbnail: null,
    createdAt: 1000,
    updatedAt: Date.now(),
    ...over,
  };
}

function makeDiagram(over: Partial<Diagram> = {}): Diagram {
  return {
    ...makeMeta(),
    scene: { elements: [] },
    links: [
      { diagramId: "d1", parentType: "feature", parentId: "feat-123456789" },
    ],
    ...over,
  };
}

describe("DiagramsArea (smoke)", () => {
  it("estado vazio mostra a dica de pedir ao Claude", () => {
    listMock.mockResolvedValue([]);
    useDiagramsStore.setState({
      diagrams: [],
      selected: null,
      loading: false,
      error: null,
    });
    render(<DiagramsArea />);
    expect(screen.getByText("Diagramas")).toBeInTheDocument();
    expect(screen.getAllByText(/peça a? ?o? Claude/i).length).toBeGreaterThan(
      0,
    );
    expect(screen.getByTitle("Novo diagrama")).toBeInTheDocument();
  });

  it("lista mostra título, kind e badge de arquivado", () => {
    const metas = [
      makeMeta(),
      makeMeta({ id: "d2", title: "Velho", status: "archived" }),
    ];
    listMock.mockResolvedValue(metas);
    useDiagramsStore.setState({
      diagrams: metas,
      selected: null,
      showArchived: true,
    });
    render(<DiagramsArea />);
    expect(screen.getByText("Fluxo IPC")).toBeInTheDocument();
    expect(screen.getAllByText("Fluxo").length).toBeGreaterThan(0);
    expect(screen.getByText("Velho")).toBeInTheDocument();
    expect(screen.getByText("Arquivado")).toBeInTheDocument();
    expect(screen.getByLabelText("Mostrar arquivados")).toBeChecked();
  });

  it("com seleção renderiza toolbar (título editável + chips) e o editor mockado", async () => {
    listMock.mockResolvedValue([makeMeta()]);
    useDiagramsStore.setState({
      diagrams: [makeMeta()],
      selected: makeDiagram(),
      remoteScene: null,
    });
    render(<DiagramsArea />);
    expect(screen.getByLabelText("Título do diagrama")).toHaveValue(
      "Fluxo IPC",
    );
    expect(screen.getByText(/Feature · feat-123/)).toBeInTheDocument();
    expect(screen.getByTitle("Mais ações")).toBeInTheDocument();
    expect(await screen.findByTestId("excalidraw-mock")).toBeInTheDocument();
  });

  it("ação \"Novo a partir de modelo\" cria o diagrama pelo IPC e o seleciona", async () => {
    listMock.mockResolvedValue([]);
    useDiagramsStore.setState({ diagrams: [], selected: null, loading: false, error: null });
    const created = makeDiagram({ id: "t1", title: "Pipeline de ML", links: [] });
    const fromTemplate = diagramsApi.createFromTemplate as ReturnType<typeof vi.fn>;
    fromTemplate.mockResolvedValue(created);

    render(<DiagramsArea />);
    fireEvent.click(screen.getByTitle("Novo a partir de modelo"));
    expect(screen.getByTestId("template-software-architecture")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Usar modelo Pipeline de ML"));

    await waitFor(() => expect(useDiagramsStore.getState().selected?.id).toBe("t1"));
    expect(fromTemplate).toHaveBeenCalledWith("ml-pipeline");
    expect(useDiagramsStore.getState().diagrams.map((d) => d.id)).toContain("t1");
  });

  it("botão Bibliotecas abre o catálogo sem diagrama aberto, com arquitetura de software e ML", async () => {
    listMock.mockResolvedValue([]);
    useDiagramsStore.setState({ diagrams: [], selected: null, loading: false, error: null });
    const lib = diagramsApi.library as unknown as Record<string, ReturnType<typeof vi.fn>>;
    lib.catalog.mockResolvedValue({ entries: [...DIAGRAM_LIBRARY_CATALOG], installedIds: [] });
    lib.installCatalog.mockResolvedValue({ added: 24, items: [] });

    render(<DiagramsArea />);
    fireEvent.click(screen.getByLabelText("Bibliotecas"));
    expect(await screen.findByRole("region", { name: "Arquitetura de software" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "ML & dados" })).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Instalar System Design Components"));
    await waitFor(() => expect(lib.installCatalog).toHaveBeenCalledWith("system-design"));
  });
});
