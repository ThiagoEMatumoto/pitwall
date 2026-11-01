import { normalize } from "@/features/design/hub/hub-filter";
import type { DiagramFolder, DiagramMeta } from "../../../../shared/types/ipc";

// Seções do hub de diagramas: as fixas + o id de uma pasta (mesmo modelo do
// hub do Design).
export type DiagramHubSection = "recent" | "unfiled" | "archived" | (string & {});
export type DiagramHubSort = "recent" | "name";

const FIXED_SECTIONS: readonly string[] = ["recent", "unfiled", "archived"];
const PREFS_KEY = "pitwall.diagrams.hub";

export function isFolderSection(section: DiagramHubSection): boolean {
  return !FIXED_SECTIONS.includes(section);
}

export interface DiagramHubPrefs {
  hubSection: DiagramHubSection;
  hubSort: DiagramHubSort;
}

export function loadDiagramHubPrefs(): DiagramHubPrefs {
  const fallback: DiagramHubPrefs = { hubSection: "recent", hubSort: "recent" };
  try {
    const raw = globalThis.localStorage?.getItem(PREFS_KEY);
    const parsed = raw ? (JSON.parse(raw) as Partial<DiagramHubPrefs>) : null;
    if (!parsed || typeof parsed !== "object") return fallback;
    return {
      hubSection:
        typeof parsed.hubSection === "string" ? parsed.hubSection : fallback.hubSection,
      hubSort: parsed.hubSort === "name" ? "name" : "recent",
    };
  } catch {
    return fallback;
  }
}

export function persistDiagramHubPrefs(prefs: DiagramHubPrefs): void {
  try {
    globalThis.localStorage?.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // Storage desligado: o hub só abre em Recentes da próxima vez.
  }
}

export function sectionDiagrams(
  section: DiagramHubSection,
  diagrams: DiagramMeta[],
  archived: DiagramMeta[],
): DiagramMeta[] {
  if (section === "archived") return archived;
  if (section === "recent") return diagrams;
  if (section === "unfiled") return diagrams.filter((d) => d.folderId === null);
  return diagrams.filter((d) => d.folderId === section);
}

export function visibleDiagrams(
  list: DiagramMeta[],
  query: string,
  sort: DiagramHubSort,
): DiagramMeta[] {
  const q = normalize(query);
  const filtered = q ? list.filter((d) => normalize(d.title).includes(q)) : list;
  return [...filtered].sort((a, b) =>
    sort === "name"
      ? a.title.localeCompare(b.title, "pt-BR", { sensitivity: "base" })
      : b.updatedAt - a.updatedAt,
  );
}

export function sectionTitle(section: DiagramHubSection, folders: DiagramFolder[]): string {
  if (section === "recent") return "Recentes";
  if (section === "unfiled") return "Sem pasta";
  if (section === "archived") return "Arquivados";
  return folders.find((f) => f.id === section)?.name ?? "Pasta";
}

export function sortFolders(list: DiagramFolder[]): DiagramFolder[] {
  return [...list].sort(
    (a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, "pt-BR"),
  );
}

export function replaceFolder(list: DiagramFolder[], folder: DiagramFolder): DiagramFolder[] {
  return sortFolders([...list.filter((f) => f.id !== folder.id), folder]);
}

export function withFolder(
  list: DiagramMeta[],
  id: string,
  folderId: string | null,
): DiagramMeta[] {
  return list.map((d) => (d.id === id ? { ...d, folderId } : d));
}

// Contagem otimista: arquivados não contam (DiagramFolder.docCount).
export function shiftCount(
  folders: DiagramFolder[],
  from: string | null,
  to: string | null,
): DiagramFolder[] {
  return folders.map((f) =>
    f.id === from
      ? { ...f, docCount: Math.max(0, f.docCount - 1) }
      : f.id === to
        ? { ...f, docCount: f.docCount + 1 }
        : f,
  );
}

// Pasta apagada fora daqui (ex.: Claude via MCP): o folderId que sobrou na
// lista aponta pro nada e o item deve contar como "sem pasta".
export function unfileMissing(list: DiagramMeta[], folders: DiagramFolder[]): DiagramMeta[] {
  const known = new Set(folders.map((f) => f.id));
  return list.some((d) => d.folderId && !known.has(d.folderId))
    ? list.map((d) => (d.folderId && !known.has(d.folderId) ? { ...d, folderId: null } : d))
    : list;
}
