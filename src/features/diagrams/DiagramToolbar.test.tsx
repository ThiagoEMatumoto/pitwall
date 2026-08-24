import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Diagram } from "../../../shared/types/ipc";

// A lib real do Excalidraw não roda em jsdom (canvas/fonts).
vi.mock("./excalidraw-lazy", () => ({
  loadExcalidraw: () => new Promise(() => {}),
  loadExcalidrawUtils: () => new Promise(() => {}),
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
      onUpdated: vi.fn(() => () => {}),
    },
  },
}));

// Evita puxar appStore/tasksStore/featuresStore (cadeia pesada de IPC).
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
