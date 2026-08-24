import React from "react";
import type {
  CaptureUpdateAction,
  restoreElements,
} from "@excalidraw/excalidraw";

// O Excalidraw resolve as fontes em runtime a partir deste global — precisa
// estar setado ANTES do primeiro import (mesmo dinâmico) da lib. As fontes
// vivem em src/public/excalidraw/fonts (servidas em /excalidraw/fonts).
declare global {
  interface Window {
    EXCALIDRAW_ASSET_PATH?: string;
  }
}
window.EXCALIDRAW_ASSET_PATH = new URL("excalidraw/", document.baseURI).href;

// Import dinâmico único e compartilhado (componente + utils + CSS): a lib pesa
// megabytes e só carrega quando a área Diagramas monta um editor.
let modPromise: Promise<typeof import("@excalidraw/excalidraw")> | null = null;

export function loadExcalidraw(): Promise<
  typeof import("@excalidraw/excalidraw")
> {
  if (!modPromise) {
    modPromise = Promise.all([
      import("@excalidraw/excalidraw"),
      // CSS junto do módulo lazy, não no entry: sem editor aberto, sem CSS.
      import("@excalidraw/excalidraw/index.css"),
    ]).then(([m]) => m);
  }
  return modPromise;
}

export const LazyExcalidraw = React.lazy(() =>
  loadExcalidraw().then((m) => ({ default: m.Excalidraw })),
);

export interface ExcalidrawUtils {
  exportToBlob: (typeof import("@excalidraw/excalidraw"))["exportToBlob"];
  exportToSvg: (typeof import("@excalidraw/excalidraw"))["exportToSvg"];
  restoreElements: typeof restoreElements;
  CaptureUpdateAction: typeof CaptureUpdateAction;
  mergeLibraryItems: (typeof import("@excalidraw/excalidraw"))["mergeLibraryItems"];
  loadLibraryFromBlob: (typeof import("@excalidraw/excalidraw"))["loadLibraryFromBlob"];
  getLibraryItemsHash: (typeof import("@excalidraw/excalidraw"))["getLibraryItemsHash"];
}

export async function loadExcalidrawUtils(): Promise<ExcalidrawUtils> {
  const m = await loadExcalidraw();
  return {
    exportToBlob: m.exportToBlob,
    exportToSvg: m.exportToSvg,
    restoreElements: m.restoreElements,
    CaptureUpdateAction: m.CaptureUpdateAction,
    mergeLibraryItems: m.mergeLibraryItems,
    loadLibraryFromBlob: m.loadLibraryFromBlob,
    getLibraryItemsHash: m.getLibraryItemsHash,
  };
}
