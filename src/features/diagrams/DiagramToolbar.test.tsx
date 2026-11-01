import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Diagram } from "../../../shared/types/ipc";

// A lib real do Excalidraw não roda em jsdom (canvas/fonts). Os utils ficam
// pendentes por padrão; o teste do "Inserir" troca por um restore identidade.
const utilsMock = vi.hoisted(() => ({
  load: (): Promise<unknown> => new Promise(() => {}),
}));
vi.mock("./excalidraw-lazy", () => ({
  loadExcalidraw: () => new Promise(() => {}),
  loadExcalidrawUtils: () => utilsMock.load(),
}));

vi.mock("@/lib/ipc", () => ({
  diagramsApi: {
    list: vi.fn().mockResolvedValue([]),
    get: vi.fn(),
    create: vi.fn(),
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
      catalog: vi.fn().mockResolvedValue({ entries: [], installedIds: [] }),
      installCatalog: vi.fn(),
      removeCatalog: vi.fn(),
      onUpdated: vi.fn(() => () => {}),
    },
  },
}));

// Evita puxar appStore/tasksStore/featuresStore (cadeia pesada de IPC).
// A gaveta "Sessão" tem teste próprio (SessionDrawer.test.tsx).
vi.mock("@/features/sessions/chat/artifacts/SessionDrawer", () => ({
  SessionDrawerButton: () => null,
  SessionDrawerDock: () => null,
}));

vi.mock("@/lib/nav", () => ({
  navigateToFeature: vi.fn(),
  navigateToTask: vi.fn(),
  navigateToProject: vi.fn(),
  navigateToDiagram: vi.fn(),
}));

const { DiagramToolbar } = await import("./DiagramToolbar");
type SyncState = import("./DiagramToolbar").DiagramSyncState;

function makeDiagram(over: Partial<Diagram> = {}): Diagram {
  return {
    id: "d1",
    title: "Fluxo IPC",
    kind: "flow",
    status: "active",
    version: 3,
    sourceFormat: "skeleton",
    thumbnail: null,
    createdAt: 1000,
    updatedAt: 2000,
    scene: { elements: [] },
    links: [],
    ...over,
  };
}

function renderToolbar(syncState: SyncState, onSaveNow = vi.fn()) {
  render(
    <DiagramToolbar
      diagram={makeDiagram()}
      excalidrawAPI={null}
      syncState={syncState}
      onSaveNow={onSaveNow}
    />,
  );
  return onSaveNow;
}

describe("DiagramToolbar — chip de sync + botão Salvar", () => {
  it("saving → chip Salvando…", () => {
    renderToolbar({ status: "saving", lastRemoteAt: null, version: 3 });
    expect(screen.getByText("Salvando…")).toBeInTheDocument();
  });

  it("dirty → chip Não salvo e botão habilitado", () => {
    renderToolbar({ status: "dirty", lastRemoteAt: null, version: 3 });
    expect(screen.getByText("Não salvo")).toBeInTheDocument();
    expect(screen.getByTitle("Salvar (Ctrl+S)")).toBeEnabled();
  });

  it("saved → chip Salvo · v{version} e botão desabilitado", () => {
    renderToolbar({ status: "saved", lastRemoteAt: null, version: 3 });
    expect(screen.getByText("Salvo · v3")).toBeInTheDocument();
    expect(screen.getByTitle("Salvar (Ctrl+S)")).toBeDisabled();
  });

  it("saved com remoto recente → Atualizado pelo Claude · v{version}", () => {
    renderToolbar({
      status: "saved",
      lastRemoteAt: Date.now() - 1000,
      version: 3,
    });
    expect(screen.getByText("Atualizado pelo Claude · v3")).toBeInTheDocument();
  });

  it("saved com remoto antigo (>8s) → chip Salvo normal", () => {
    renderToolbar({
      status: "saved",
      lastRemoteAt: Date.now() - 9000,
      version: 3,
    });
    expect(screen.getByText("Salvo · v3")).toBeInTheDocument();
  });

  it("clicar em Salvar chama onSaveNow", () => {
    const onSaveNow = renderToolbar({
      status: "dirty",
      lastRemoteAt: null,
      version: 3,
    });
    fireEvent.click(screen.getByTitle("Salvar (Ctrl+S)"));
    expect(onSaveNow).toHaveBeenCalledTimes(1);
  });
});

describe("DiagramToolbar — Inserir", () => {
  function fakeApi(existing: unknown[] = [{ id: "old", type: "rectangle" }]) {
    return {
      getAppState: () => ({
        scrollX: -100,
        scrollY: -50,
        width: 1000,
        height: 600,
        zoom: { value: 2 },
      }),
      getSceneElementsIncludingDeleted: () => existing,
      updateScene: vi.fn(),
    };
  }

  async function insert(label: string) {
    const restoreElements = vi.fn((els: unknown[]) => els);
    utilsMock.load = async () => ({
      restoreElements,
      CaptureUpdateAction: { IMMEDIATELY: "IMMEDIATELY" },
    });
    const api = fakeApi();
    render(
      <DiagramToolbar
        diagram={makeDiagram()}
        excalidrawAPI={api as never}
        syncState={{ status: "saved", lastRemoteAt: null, version: 3 }}
        onSaveNow={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTitle("Inserir"));
    fireEvent.click(screen.getByText(label));
    await waitFor(() => expect(api.updateScene).toHaveBeenCalledTimes(1));
    return { api, restoreElements };
  }

  it("Nova entidade insere o bloco no centro do viewport, pinado e selecionado", async () => {
    const { api, restoreElements } = await insert("Nova entidade");
    // Sem refreshDimensions (ver restore-scene.ts).
    expect(restoreElements.mock.calls[0][2]).toEqual({ repairBindings: true });
    const call = api.updateScene.mock.calls[0][0];
    const els = call.elements as Array<Record<string, any>>;
    expect(els[0].id).toBe("old");
    const owner = els[1];
    expect(owner.customData.pitwall).toMatchObject({
      kind: "entity",
      auto: false,
    });
    // Centro do viewport em coordenadas de cena: -scroll + tamanho/2/zoom.
    expect(owner.x + owner.width / 2).toBeCloseTo(100 + 250, 5);
    expect(owner.y + owner.height / 2).toBeCloseTo(50 + 150, 5);
    const added = els.slice(1);
    expect(added.every((e) => e.groupIds[0] === owner.id)).toBe(true);
    expect(added.some((e) => e.text === "PK id: uuid")).toBe(true);
    expect(added.every((e) => e.index === null)).toBe(true);
    expect(call.appState.selectedGroupIds).toEqual({ [owner.id]: true });
    expect(call.captureUpdate).toBe("IMMEDIATELY");
  });

  it("Nova classe insere 3 compartimentos", async () => {
    const { api } = await insert("Nova classe");
    const els = api.updateScene.mock.calls[0][0].elements as Array<
      Record<string, any>
    >;
    const owner = els[1];
    expect(owner.customData.pitwall.kind).toBe("class");
    expect(
      els.filter((e) => /__(header|attrs|methods)$/.test(e.id)),
    ).toHaveLength(3);
  });

  it("sem editor carregado os itens ficam desabilitados", () => {
    renderToolbar({ status: "saved", lastRemoteAt: null, version: 3 });
    fireEvent.click(screen.getByTitle("Inserir"));
    expect(screen.getByText("Nova entidade").closest("button")).toBeDisabled();
  });
});

describe("DiagramToolbar — catálogo de bibliotecas", () => {
  it("o item do menu abre o dialog do catálogo", async () => {
    renderToolbar({ status: "saved", lastRemoteAt: null, version: 3 });
    fireEvent.click(screen.getByTitle("Mais ações"));
    fireEvent.click(screen.getByText("Catálogo de bibliotecas…"));
    expect(
      await screen.findByRole("heading", { name: "Catálogo de bibliotecas" }),
    ).toBeInTheDocument();
  });
});
