import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DIAGRAM_LIBRARY_CATALOG } from "../../../shared/diagram-library-catalog";

const api = vi.hoisted(() => ({
  catalog: vi.fn(),
  installCatalog: vi.fn(),
  removeCatalog: vi.fn(),
  onUpdated: vi.fn(() => () => {}),
}));

vi.mock("@/lib/ipc", () => ({
  diagramsApi: { library: api },
}));

const toast = vi.hoisted(() => vi.fn());
vi.mock("@/features/notifications/toast-store", () => ({ showToast: toast }));

const { LibraryCatalogDialog } = await import("./LibraryCatalogDialog");

function renderDialog(onLibraryChanged = vi.fn()) {
  render(
    <LibraryCatalogDialog open onClose={vi.fn()} onLibraryChanged={onLibraryChanged} />,
  );
  return onLibraryChanged;
}

const row = (id: string) => screen.getByTestId(`catalog-entry-${id}`);

describe("LibraryCatalogDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.catalog.mockResolvedValue({
      entries: [...DIAGRAM_LIBRARY_CATALOG],
      installedIds: ["c4-architecture"],
    });
  });

  it("renderiza as entradas agrupadas por categoria e marca as já instaladas", async () => {
    renderDialog();
    await screen.findByText("AWS Architecture Icons");

    for (const label of ["Cloud", "UML/ER", "Fluxo", "Arquitetura"]) {
      expect(screen.getByRole("region", { name: label })).toBeInTheDocument();
    }
    const cloud = screen.getByRole("region", { name: "Cloud" });
    expect(within(cloud).getByText("GCP Icons")).toBeInTheDocument();

    expect(within(row("c4-architecture")).getByText("Instalada")).toBeInTheDocument();
    expect(within(row("gcp-icons")).getByRole("button", { name: "Instalar GCP Icons" })).toBeEnabled();
  });

  it("instalar mostra Instalando…, depois Instalada, e entrega a biblioteca ao editor", async () => {
    let resolve!: (v: unknown) => void;
    api.installCatalog.mockReturnValue(new Promise((r) => (resolve = r)));
    const onLibraryChanged = renderDialog();
    await screen.findByText("AWS Architecture Icons");

    fireEvent.click(screen.getByRole("button", { name: "Instalar AWS Architecture Icons" }));
    expect(api.installCatalog).toHaveBeenCalledWith("aws-architecture");
    expect(within(row("aws-architecture")).getByText("Instalando…")).toBeInTheDocument();

    const items = [{ id: "i1", name: "EC2", status: "published", elements: [], created: 1 }];
    resolve({ added: 1, items });

    await waitFor(() =>
      expect(within(row("aws-architecture")).getByText("Instalada")).toBeInTheDocument(),
    );
    expect(onLibraryChanged).toHaveBeenCalledWith(items);
    expect(toast).toHaveBeenCalled();
  });

  it("falha no download mostra a mensagem, link para o catálogo e permite tentar de novo", async () => {
    api.installCatalog.mockRejectedValue(new Error("falha ao baixar a biblioteca: HTTP 404"));
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    renderDialog();
    await screen.findByText("GCP Icons");

    fireEvent.click(screen.getByRole("button", { name: "Instalar GCP Icons" }));
    const alert = await within(row("gcp-icons")).findByRole("alert");
    expect(alert).toHaveTextContent("HTTP 404");
    expect(within(row("gcp-icons")).getByText("Tentar de novo")).toBeInTheDocument();

    fireEvent.click(within(alert).getByRole("button", { name: "Abrir no catálogo" }));
    expect(open).toHaveBeenCalledWith("https://libraries.excalidraw.com");
    open.mockRestore();
  });

  it("remover chama removeCatalog e volta para Instalar", async () => {
    api.removeCatalog.mockResolvedValue([]);
    const onLibraryChanged = renderDialog();
    await screen.findByText("C4 Architecture");

    fireEvent.click(screen.getByRole("button", { name: "Remover C4 Architecture" }));
    expect(api.removeCatalog).toHaveBeenCalledWith("c4-architecture");
    await waitFor(() =>
      expect(
        within(row("c4-architecture")).getByRole("button", { name: "Instalar C4 Architecture" }),
      ).toBeInTheDocument(),
    );
    expect(onLibraryChanged).toHaveBeenCalledWith([]);
  });
});
