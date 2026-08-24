import type { LibraryItem, LibraryItems } from "@excalidraw/excalidraw/types";
import type { DiagramLibraryItem } from "../../../shared/types/ipc";

// Conversão banco ⇄ Excalidraw. O banco guarda `name` como null (SQL não tem
// undefined); o LibraryItem usa name? opcional. `elements` é o mesmo array cru
// dos dois lados — só o tipo nominal muda.

export function toExcalidrawLibraryItems(
  items: DiagramLibraryItem[],
): LibraryItem[] {
  return items.map((i) => ({
    id: i.id,
    status: i.status,
    created: i.created,
    elements: i.elements as unknown as LibraryItem["elements"],
    ...(i.name === null ? {} : { name: i.name }),
  }));
}

export function fromExcalidrawLibraryItems(
  items: LibraryItems,
): DiagramLibraryItem[] {
  return items.map((i) => ({
    id: i.id,
    name: i.name ?? null,
    status: i.status,
    elements: i.elements as unknown as unknown[],
    created: i.created,
  }));
}
