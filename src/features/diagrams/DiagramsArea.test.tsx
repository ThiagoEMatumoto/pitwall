import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Diagram, DiagramFolder, DiagramMeta } from "../../../shared/types/ipc";
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
    move: vi.fn().mockResolvedValue(undefined),
    foldersList: vi.fn().mockResolvedValue([]),
    folderCreate: vi.fn(),
    folderUpdate: vi.fn(),
    folderDelete: vi.fn().mockResolvedValue(undefined),
    setThumbnail: vi.fn(),
    listVersions: vi.fn().mockResolvedValue([]),
    onUpdated: vi.fn(() => () => {}),
    onDeleted: vi.fn(() => () => {}),
    onLinksUpdated: vi.fn(() => () => {}),
    onFoldersUpdated: vi.fn(() => () => {}),
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
// A gaveta "Sessão" tem teste próprio (SessionDrawer.test.tsx).
vi.mock("@/features/sessions/chat/artifacts/SessionDrawer", () => ({
  SessionDrawerButton: () => null,
}));

vi.mock("@/lib/nav", () => ({
  navigateToFeature: vi.fn(),
  navigateToTask: vi.fn(),
  navigateToProject: vi.fn(),
  navigateToDiagram: vi.fn(),
}));

const { DiagramsArea } = await import("./DiagramsArea");
const { useDiagramsStore } = await import("@/store/diagramsStore");
const { diagramsApi } = await import("@/lib/ipc");
const api = diagramsApi as unknown as Record<string, ReturnType<typeof vi.fn>>;

function makeMeta(over: Partial<DiagramMeta> = {}): DiagramMeta {
  return {
    id: "d1",
    title: "Fluxo IPC",
    kind: "flow",
    status: "active",
    version: 1,
    sourceFormat: "skeleton",
    thumbnail: null,
    folderId: null,
    createdAt: 1000,
    updatedAt: Date.now(),
    ...over,
  };
}

function makeFolder(over: Partial<DiagramFolder> = {}): DiagramFolder {
  return {
    id: "f1",
    name: "Infra",
    color: "info",
    sortOrder: 0,
    docCount: 1,
    createdAt: 1,
    updatedAt: 1,
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

// O effect da área recarrega lista e pastas: os mocks devolvem o mesmo
// estado semeado pra não clobberar o setState.
async function renderHub(diagrams: DiagramMeta[], folders: DiagramFolder[] = []) {
  api.list.mockResolvedValue(diagrams);
  api.foldersList.mockResolvedValue(folders);
  useDiagramsStore.setState({
    diagrams,
    archivedDiagrams: [],
    folders,
    selected: null,
    loading: false,
    error: null,
    hubSection: "recent",
    hubQuery: "",
  });
  render(<DiagramsArea />);
  await act(async () => {});
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

describe("DiagramsArea — hub", () => {
  it("estado vazio ensina a pedir ao Claude e oferece criar", async () => {
    await renderHub([]);
    expect(screen.getByRole("heading", { name: "Diagramas" })).toBeInTheDocument();
    expect(screen.getByText("Nenhum diagrama ainda")).toBeInTheDocument();
    expect(screen.getByText(/Peça a uma sessão do Claude/)).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /Novo diagrama/ }).length).toBeGreaterThan(0);
  });

  it("cards mostram thumbnail quando existe e placeholder do kind quando não", async () => {
    await renderHub([
      makeMeta(),
      makeMeta({ id: "d2", title: "Com preview", thumbnail: "data:image/png;base64,AAAA" }),
    ]);
    const cards = screen.getAllByTestId("diagram-card");
    expect(cards).toHaveLength(2);
    const withThumb = cards.find((c) => within(c).queryByText("Com preview"))!;
    expect(withThumb.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,AAAA");
    const without = cards.find((c) => within(c).queryByText("Fluxo IPC"))!;
    expect(within(without).getByTestId("diagram-thumb-placeholder")).toBeInTheDocument();
  });

  it("sidebar lista pastas com contagem e filtra a grade pela pasta e por Sem pasta", async () => {
    await renderHub(
      [makeMeta({ folderId: "f1" }), makeMeta({ id: "d2", title: "Solto" })],
      [makeFolder()],
    );
    // Em Recentes o card mostra o chip da pasta.
    expect(screen.getAllByText("Infra").length).toBeGreaterThan(1);

    fireEvent.click(screen.getByRole("button", { name: /^Infra/ }));
    expect(screen.getByRole("heading", { name: "Infra" })).toBeInTheDocument();
    expect(screen.getAllByTestId("diagram-card")).toHaveLength(1);
    expect(screen.getByText("Fluxo IPC")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^Sem pasta/ }));
    expect(screen.getByText("Solto")).toBeInTheDocument();
    expect(screen.queryByText("Fluxo IPC")).not.toBeInTheDocument();
  });

  it("move um diagrama para uma pasta pelo menu ⋯", async () => {
    await renderHub([makeMeta()], [makeFolder({ docCount: 0 })]);

    // O item "Infra" do menu é o último botão com esse nome (o portal monta
    // depois da sidebar).
    fireEvent.click(screen.getByRole("button", { name: "Opções de Fluxo IPC" }));
    expect(screen.getByRole("button", { name: /^Sem pasta ✓/ })).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getAllByRole("button", { name: /^Infra/ }).at(-1)!);
    });

    expect(api.move).toHaveBeenCalledWith("d1", "f1");
    const s = useDiagramsStore.getState();
    expect(s.diagrams[0].folderId).toBe("f1");
    expect(s.folders[0].docCount).toBe(1);
  });

  it("busca por título sem acento e mostra o estado sem resultado", async () => {
    await renderHub([makeMeta({ title: "Autenticação" }), makeMeta({ id: "d2", title: "Billing" })]);
    const search = screen.getByRole("searchbox", { name: "Buscar diagramas" });
    fireEvent.change(search, { target: { value: "autenticacao" } });
    expect(screen.getAllByTestId("diagram-card")).toHaveLength(1);
    fireEvent.change(search, { target: { value: "zzz" } });
    expect(screen.getByText(/Nenhum diagrama com/)).toBeInTheDocument();
  });

  it("exclui pasta só após confirmar e os diagramas voltam para Sem pasta", async () => {
    await renderHub([makeMeta({ folderId: "f1" })], [makeFolder()]);
    fireEvent.click(screen.getByRole("button", { name: "Opções da pasta Infra" }));
    fireEvent.click(screen.getByRole("button", { name: "Excluir…" }));
    const dialog = screen.getByRole("alertdialog");
    expect(within(dialog).getByText(/diagramas dela vão para Sem pasta/)).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Excluir" }));
    });
    expect(api.folderDelete).toHaveBeenCalledWith("f1");
    expect(useDiagramsStore.getState().diagrams[0].folderId).toBeNull();
  });
});

describe("DiagramsArea — editor", () => {
  it("com seleção renderiza toolbar (voltar + título + chips) e o editor mockado", async () => {
    api.list.mockResolvedValue([makeMeta()]);
    useDiagramsStore.setState({
      diagrams: [makeMeta()],
      selected: makeDiagram(),
      remoteScene: null,
    });
    render(<DiagramsArea />);
    expect(screen.getByLabelText("Título do diagrama")).toHaveValue("Fluxo IPC");
    expect(screen.getByText(/Feature · feat-123/)).toBeInTheDocument();
    expect(screen.getByTitle("Mais ações")).toBeInTheDocument();
    expect(await screen.findByTestId("excalidraw-mock")).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Voltar para diagramas" }));
    });
    expect(useDiagramsStore.getState().selected).toBeNull();
    expect(screen.getByRole("heading", { name: "Diagramas" })).toBeInTheDocument();
  });

  it("ação \"Novo a partir de modelo\" cria o diagrama pelo IPC e o seleciona", async () => {
    const created = makeDiagram({ id: "t1", title: "Pipeline de ML", links: [] });
    api.createFromTemplate.mockResolvedValue(created);

    await renderHub([]);
    fireEvent.click(screen.getByTitle("Novo a partir de modelo"));
    expect(screen.getByTestId("template-software-architecture")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Usar modelo Pipeline de ML"));

    await waitFor(() => expect(useDiagramsStore.getState().selected?.id).toBe("t1"));
    expect(api.createFromTemplate).toHaveBeenCalledWith("ml-pipeline");
    expect(useDiagramsStore.getState().diagrams.map((d) => d.id)).toContain("t1");
  });

  it("botão Bibliotecas abre o catálogo sem diagrama aberto, com arquitetura de software e ML", async () => {
    const lib = diagramsApi.library as unknown as Record<string, ReturnType<typeof vi.fn>>;
    lib.catalog.mockResolvedValue({ entries: [...DIAGRAM_LIBRARY_CATALOG], installedIds: [] });
    lib.installCatalog.mockResolvedValue({ added: 24, items: [] });

    await renderHub([]);
    fireEvent.click(screen.getByLabelText("Bibliotecas"));
    expect(await screen.findByRole("region", { name: "Arquitetura de software" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "ML & dados" })).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Instalar System Design Components"));
    await waitFor(() => expect(lib.installCatalog).toHaveBeenCalledWith("system-design"));
  });
});
