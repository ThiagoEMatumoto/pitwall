import type { BinaryFiles } from "@excalidraw/excalidraw/types";
import type { ExcalidrawUtils } from "./excalidraw-lazy";

// Preview do card do hub. PNG pequeno em data URL (a coluna diagrams.thumbnail
// é TEXT e o IPC recusa acima de 512 KB): 480 px no lado maior basta pra um
// card de ~220 px em tela 2x.
export const THUMBNAIL_MAX_PX = 480;
export const MAX_THUMBNAIL_DATAURL_BYTES = 512 * 1024;

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("FileReader falhou"));
    reader.readAsDataURL(blob);
  });
}

// null = nada a gravar (cena vazia ou PNG acima do teto).
export async function renderThumbnail(
  utils: Pick<ExcalidrawUtils, "exportToBlob">,
  elements: readonly unknown[],
  files: BinaryFiles | null,
): Promise<string | null> {
  const visible = elements.filter((e) => !(e as { isDeleted?: boolean }).isDeleted);
  if (visible.length === 0) return null;
  const blob = await utils.exportToBlob({
    elements: visible as never,
    // Fundo branco fixo: o canvas usa os defaults claros da lib (o tema dark
    // do editor só inverte na tela), e o card mostra o PNG como está.
    appState: { exportBackground: true, viewBackgroundColor: "#ffffff" },
    files,
    mimeType: "image/png",
    maxWidthOrHeight: THUMBNAIL_MAX_PX,
  });
  const dataUrl = await blobToDataUrl(blob);
  return dataUrl.length > MAX_THUMBNAIL_DATAURL_BYTES ? null : dataUrl;
}
