import { describe, expect, it, vi } from "vitest";
import {
  MAX_THUMBNAIL_DATAURL_BYTES,
  THUMBNAIL_MAX_PX,
  renderThumbnail,
} from "./diagram-thumbnail";

function utilsReturning(blob: Blob) {
  return { exportToBlob: vi.fn().mockResolvedValue(blob) };
}

describe("renderThumbnail", () => {
  it("exporta PNG limitado a THUMBNAIL_MAX_PX, sem os deletados, e devolve data URL", async () => {
    const utils = utilsReturning(new Blob(["png"], { type: "image/png" }));
    const live = { id: "a", type: "rectangle" };

    const out = await renderThumbnail(
      utils as never,
      [live, { id: "b", type: "rectangle", isDeleted: true }],
      null,
    );

    expect(out).toMatch(/^data:image\/png;base64,/);
    expect(utils.exportToBlob).toHaveBeenCalledWith(
      expect.objectContaining({
        elements: [live],
        mimeType: "image/png",
        maxWidthOrHeight: THUMBNAIL_MAX_PX,
        files: null,
      }),
    );
  });

  it("exporta no modo escuro do editor e sem fundo branco fixo (o card põe o papel do tema)", async () => {
    const utils = utilsReturning(new Blob(["png"], { type: "image/png" }));
    await renderThumbnail(utils as never, [{ id: "a" }], null);
    const { appState } = utils.exportToBlob.mock.calls[0][0];
    expect(appState).toMatchObject({ exportWithDarkMode: true, exportBackground: false });
  });

  it("cena vazia (ou só deletados) não exporta", async () => {
    const utils = utilsReturning(new Blob([]));
    expect(await renderThumbnail(utils as never, [{ id: "x", isDeleted: true }], null)).toBeNull();
    expect(utils.exportToBlob).not.toHaveBeenCalled();
  });

  it("PNG acima do teto do IPC vira null em vez de estourar o set-thumbnail", async () => {
    const big = new Blob([new Uint8Array(MAX_THUMBNAIL_DATAURL_BYTES)], { type: "image/png" });
    const out = await renderThumbnail(utilsReturning(big) as never, [{ id: "a" }], null);
    expect(out).toBeNull();
  });
});
