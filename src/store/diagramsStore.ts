import { create } from "zustand";
import { diagramsApi } from "@/lib/ipc";
import { navigateToDiagram } from "@/lib/nav";
import { showToast } from "@/features/notifications/toast-store";
import {
  isFolderSection,
  loadDiagramHubPrefs,
  persistDiagramHubPrefs,
  replaceFolder,
  shiftCount,
  unfileMissing,
  withFolder,
  type DiagramHubSection,
  type DiagramHubSort,
} from "@/features/diagrams/hub/diagram-hub";
import type {
  Diagram,
  DiagramFolder,
  DiagramLibraryItem,
  DiagramLink,
  DiagramMeta,
  DiagramScene,
  UpdateDiagramSceneInput,
} from "../../shared/types/ipc";

// Donos únicos das assinaturas (StrictMode-safe):
// `watchStarted` guarda contra o duplo-mount do effect — a 2ª chamada é no-op.
let offUpdated: (() => void) | null = null;
let offDeleted: (() => void) | null = null;
let offLinksUpdated: (() => void) | null = null;
let offLibraryUpdated: (() => void) | null = null;
let offFoldersUpdated: (() => void) | null = null;
let watchStarted = false;

// Cena vinda de broadcast (ex.: Claude editou via MCP) endereçada ao editor
// aberto. O nonce muda a cada broadcast — é o que o effect do editor observa
// (a cena em si pode ser deep-equal e mesmo assim precisar reaplicar).
export interface RemoteScene {
  scene: DiagramScene;
  nonce: number;
}

let remoteNonce = 0;

// Biblioteca de shapes vinda de broadcast (install via MCP/URL, replace de
// outra janela). Mesmo padrão do RemoteScene: o nonce bumpa a cada broadcast e
// é o que o effect do editor observa.
export interface RemoteLibrary {
  items: DiagramLibraryItem[];
  nonce: number;
}

let libraryNonce = 0;

// Token da seleção em voo: cada select() bumpa; um get() que resolve depois
// de outro select() (ou de um select(null)) descarta o resultado obsoleto.
let selectSeq = 0;

// Anti-spam do toast "Claude atualizou": patches em sequência no mesmo
// diagrama viram no máximo 1 toast por janela.
const REMOTE_TOAST_THROTTLE_MS = 5000;
const lastRemoteToastAt = new Map<string, number>();

function maybeToastRemoteUpdate(diagram: Diagram): void {
  const now = Date.now();
  if (
    now - (lastRemoteToastAt.get(diagram.id) ?? 0) <
    REMOTE_TOAST_THROTTLE_MS
  ) {
    return;
  }
  lastRemoteToastAt.set(diagram.id, now);
  showToast({
    title: `Claude atualizou "${diagram.title}"`,
    actionLabel: "Abrir",
    onAction: () => navigateToDiagram(diagram.id),
  });
}

function toMeta(d: Diagram): DiagramMeta {
  const { scene: _scene, links: _links, ...meta } = d;
  return meta;
}

// Insere/atualiza mantendo ordem por updatedAt desc (ordem do list()).
function upsertMeta(list: DiagramMeta[], meta: DiagramMeta): DiagramMeta[] {
  const rest = list.filter((m) => m.id !== meta.id);
  return [...rest, meta].sort((a, b) => b.updatedAt - a.updatedAt);
}

const errorText = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

// Cada diagrama mora numa lista só, conforme o status: arquivar tira dos
// ativos e põe nos arquivados (e vice-versa).
function placeByStatus(
  s: { diagrams: DiagramMeta[]; archivedDiagrams: DiagramMeta[] },
  meta: DiagramMeta,
): { diagrams: DiagramMeta[]; archivedDiagrams: DiagramMeta[] } {
  const without = (list: DiagramMeta[]) => list.filter((m) => m.id !== meta.id);
  return meta.status === "active"
    ? { diagrams: upsertMeta(s.diagrams, meta), archivedDiagrams: without(s.archivedDiagrams) }
    : { diagrams: without(s.diagrams), archivedDiagrams: upsertMeta(s.archivedDiagrams, meta) };
}

interface DiagramsState {
  // Ativos. Os arquivados ficam à parte e só carregam na seção "Arquivados".
  diagrams: DiagramMeta[];
  archivedDiagrams: DiagramMeta[];
  folders: DiagramFolder[];
  hubSection: DiagramHubSection;
  hubQuery: string;
  hubSort: DiagramHubSort;
  selected: Diagram | null;
  loading: boolean;
  error: string | null;
  remoteScene: RemoteScene | null;
  remoteLibrary: RemoteLibrary | null;

  load: () => Promise<void>;
  select: (id: string | null) => Promise<void>;
  loadArchived: () => Promise<void>;
  loadFolders: () => Promise<void>;
  // Sem folderId explícito, cria na pasta da seção aberta do hub.
  create: (folderId?: string | null) => Promise<void>;
  createFolder: (name: string, color?: string | null) => Promise<DiagramFolder | null>;
  renameFolder: (id: string, name: string) => Promise<void>;
  recolorFolder: (id: string, color: string | null) => Promise<void>;
  deleteFolder: (id: string) => Promise<void>;
  move: (id: string, folderId: string | null) => Promise<void>;
  setHubSection: (section: DiagramHubSection) => void;
  setHubQuery: (query: string) => void;
  setHubSort: (sort: DiagramHubSort) => void;
  rename: (id: string, title: string) => Promise<void>;
  archive: (id: string) => Promise<void>;
  unarchive: (id: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  // Debounce fica no editor; aqui é o write direto (head e/ou snapshot).
  saveScene: (input: UpdateDiagramSceneInput) => Promise<void>;
  startWatch: () => void;
  stopWatch: () => void;
}

const hubPrefs = loadDiagramHubPrefs();

export const useDiagramsStore = create<DiagramsState>((set, get) => {
  const savePrefs = () =>
    persistDiagramHubPrefs({ hubSection: get().hubSection, hubSort: get().hubSort });
  const updateFolder = async (
    id: string,
    input: { name?: string; color?: string | null },
  ) => {
    try {
      const folder = await diagramsApi.folderUpdate(id, input);
      set((s) => ({ folders: replaceFolder(s.folders, folder) }));
    } catch (err) {
      set({ error: `Não foi possível alterar a pasta: ${errorText(err)}` });
    }
  };

  return {
  diagrams: [],
  archivedDiagrams: [],
  folders: [],
  hubSection: hubPrefs.hubSection,
  hubQuery: "",
  hubSort: hubPrefs.hubSort,
  selected: null,
  loading: false,
  error: null,
  remoteScene: null,
  remoteLibrary: null,

  load: async () => {
    set({ loading: true, error: null });
    try {
      const diagrams = await diagramsApi.list({ status: "active" });
      set({ diagrams, loading: false });
    } catch (err) {
      set({
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },

  select: async (id) => {
    const token = ++selectSeq;
    if (!id) {
      set({ selected: null, remoteScene: null });
      return;
    }
    const diagram = await diagramsApi.get(id);
    // Ignora resultado obsoleto se o usuário já trocou de seleção nesse meio
    // tempo (só acontece com cliques rápidos; get é barato mas assíncrono):
    // apenas a chamada mais recente (token corrente) aplica o resultado.
    if (diagram && token === selectSeq) {
      set({ selected: diagram, remoteScene: null });
    }
  },

  loadArchived: async () => {
    try {
      const archivedDiagrams = await diagramsApi.list({ status: "archived" });
      set({ archivedDiagrams });
    } catch (err) {
      set({ error: errorText(err) });
    }
  },

  loadFolders: async () => {
    try {
      const folders = await diagramsApi.foldersList();
      const { hubSection } = get();
      // Pasta lembrada que não existe mais cai em Recentes.
      const gone =
        isFolderSection(hubSection) && !folders.some((f) => f.id === hubSection);
      set((s) => ({
        folders,
        diagrams: unfileMissing(s.diagrams, folders),
        archivedDiagrams: unfileMissing(s.archivedDiagrams, folders),
        ...(gone ? { hubSection: "recent" } : {}),
      }));
      if (gone) savePrefs();
    } catch (err) {
      set({ error: errorText(err) });
    }
  },

  create: async (folderId) => {
    const section = get().hubSection;
    const target =
      folderId !== undefined ? folderId : isFolderSection(section) ? section : null;
    const diagram = await diagramsApi.create({
      title: "Novo diagrama",
      scene: { elements: [] },
      author: "human",
      sourceFormat: "scene",
      folderId: target,
    });
    set((s) => ({
      diagrams: upsertMeta(s.diagrams, toMeta(diagram)),
      folders: target ? shiftCount(s.folders, null, target) : s.folders,
      selected: diagram,
      remoteScene: null,
    }));
  },

  createFolder: async (name, color) => {
    try {
      const folder = await diagramsApi.folderCreate({ name, color });
      set((s) => ({ folders: replaceFolder(s.folders, folder) }));
      return folder;
    } catch (err) {
      set({ error: `Não foi possível criar a pasta: ${errorText(err)}` });
      return null;
    }
  },

  renameFolder: (id, name) => updateFolder(id, { name }),

  recolorFolder: (id, color) => updateFolder(id, { color }),

  deleteFolder: async (id) => {
    try {
      await diagramsApi.folderDelete(id);
    } catch (err) {
      set({ error: `Não foi possível excluir a pasta: ${errorText(err)}` });
      return;
    }
    const unfile = (list: DiagramMeta[]) =>
      list.map((d) => (d.folderId === id ? { ...d, folderId: null } : d));
    set((s) => ({
      folders: s.folders.filter((f) => f.id !== id),
      // O main já tirou os diagramas da pasta (ON DELETE SET NULL).
      diagrams: unfile(s.diagrams),
      archivedDiagrams: unfile(s.archivedDiagrams),
      selected:
        s.selected?.folderId === id ? { ...s.selected, folderId: null } : s.selected,
      hubSection: s.hubSection === id ? "recent" : s.hubSection,
    }));
    savePrefs();
  },

  // Otimista: o card muda de pasta na hora; falha desfaz e mostra o erro.
  move: async (id, folderId) => {
    const before = get();
    const meta = [...before.diagrams, ...before.archivedDiagrams].find(
      (d) => d.id === id,
    );
    if (!meta || meta.folderId === folderId) return;
    const counted = meta.status === "active";
    const apply = (from: string | null, to: string | null) =>
      set((s) => ({
        diagrams: withFolder(s.diagrams, id, to),
        archivedDiagrams: withFolder(s.archivedDiagrams, id, to),
        selected: s.selected?.id === id ? { ...s.selected, folderId: to } : s.selected,
        folders: counted ? shiftCount(s.folders, from, to) : s.folders,
      }));
    apply(meta.folderId, folderId);
    try {
      await diagramsApi.move(id, folderId);
    } catch (err) {
      apply(folderId, meta.folderId);
      set({ error: `Não foi possível mover o diagrama: ${errorText(err)}` });
    }
  },

  setHubSection: (hubSection) => {
    set({ hubSection });
    savePrefs();
  },

  setHubQuery: (hubQuery) => set({ hubQuery }),

  setHubSort: (hubSort) => {
    set({ hubSort });
    savePrefs();
  },

  rename: async (id, title) => {
    const diagram = await diagramsApi.rename(id, title);
    set((s) => ({
      diagrams: upsertMeta(s.diagrams, toMeta(diagram)),
      selected:
        s.selected?.id === id
          ? { ...s.selected, title: diagram.title }
          : s.selected,
    }));
  },

  archive: async (id) => {
    const diagram = await diagramsApi.archive(id);
    set((s) => ({
      ...placeByStatus(s, toMeta(diagram)),
      selected: s.selected?.id === id ? { ...s.selected, status: "archived" } : s.selected,
    }));
    void get().loadFolders();
  },

  unarchive: async (id) => {
    const diagram = await diagramsApi.unarchive(id);
    set((s) => ({
      ...placeByStatus(s, toMeta(diagram)),
      selected: s.selected?.id === id ? { ...s.selected, status: "active" } : s.selected,
    }));
    void get().loadFolders();
  },

  remove: async (id) => {
    await diagramsApi.delete(id);
    set((s) => ({
      diagrams: s.diagrams.filter((m) => m.id !== id),
      archivedDiagrams: s.archivedDiagrams.filter((m) => m.id !== id),
      selected: s.selected?.id === id ? null : s.selected,
      remoteScene: s.selected?.id === id ? null : s.remoteScene,
    }));
  },

  saveScene: async (input) => {
    const diagram = await diagramsApi.updateScene(input);
    // O broadcast diagram:updated também chega aqui (eco); atualizar direto
    // deixa a lista em dia mesmo se o watch ainda não estiver ligado.
    set((s) => ({
      diagrams: upsertMeta(s.diagrams, toMeta(diagram)),
      selected:
        s.selected?.id === diagram.id
          ? { ...diagram, scene: s.selected.scene } // cena local é a fonte da verdade no editor aberto
          : s.selected,
    }));
  },

  startWatch: () => {
    if (watchStarted) return;
    watchStarted = true;

    offUpdated = diagramsApi.onUpdated((payload) => {
      const diagram = payload as Diagram;
      if (!diagram?.id) return;
      // Toast só pra diagrama NÃO aberto e com bump de version (mudança de
      // conteúdo real — rename/archive não versionam). O aberto já tem o
      // fluxo remoteScene/banner; o eco do próprio save cai no filtro de id.
      const cur = get();
      const prev = cur.diagrams.find((m) => m.id === diagram.id);
      if (
        cur.selected?.id !== diagram.id &&
        prev !== undefined &&
        diagram.version > prev.version
      ) {
        maybeToastRemoteUpdate(diagram);
      }
      set((s) => {
        const lists = placeByStatus(s, toMeta(diagram));
        if (s.selected?.id !== diagram.id) return lists;
        // Thumbnail e move não bumpam version nem updated_at: a cena que vem
        // junto é a do banco, que pode estar atrás de um save em voo — repassar
        // ao editor reverteria o canvas.
        if (
          diagram.version === s.selected.version &&
          diagram.updatedAt === s.selected.updatedAt
        ) {
          return { ...lists, selected: { ...diagram, scene: s.selected.scene } };
        }
        // Diagrama aberto: repassa a cena nova pro editor via remoteScene.
        // O editor decide se aplica (sem edição local pendente), mostra o
        // banner (com pendência) ou ignora (eco do próprio save).
        return {
          ...lists,
          selected: { ...diagram, scene: s.selected.scene },
          remoteScene: { scene: diagram.scene, nonce: ++remoteNonce },
        };
      });
    });

    offDeleted = diagramsApi.onDeleted((payload) => {
      const { id } = (payload ?? {}) as { id?: string };
      if (!id) return;
      set((s) => ({
        diagrams: s.diagrams.filter((m) => m.id !== id),
        archivedDiagrams: s.archivedDiagrams.filter((m) => m.id !== id),
        selected: s.selected?.id === id ? null : s.selected,
        remoteScene: s.selected?.id === id ? null : s.remoteScene,
      }));
    });

    offFoldersUpdated = diagramsApi.onFoldersUpdated(() => {
      void get().loadFolders();
    });

    offLinksUpdated = diagramsApi.onLinksUpdated((payload) => {
      const { diagramId, links } = (payload ?? {}) as {
        diagramId?: string;
        links?: DiagramLink[];
      };
      if (!diagramId || !links) return;
      set((s) =>
        s.selected?.id === diagramId
          ? { selected: { ...s.selected, links } }
          : s,
      );
    });

    offLibraryUpdated = diagramsApi.library.onUpdated((payload) => {
      const { items } = (payload ?? {}) as { items?: DiagramLibraryItem[] };
      if (!items) return;
      // O editor decide se aplica: compara o hash com o último salvo/aplicado
      // (eco do próprio replace é ignorado lá).
      set({ remoteLibrary: { items, nonce: ++libraryNonce } });
    });
  },

  stopWatch: () => {
    if (offUpdated) {
      offUpdated();
      offUpdated = null;
    }
    if (offDeleted) {
      offDeleted();
      offDeleted = null;
    }
    if (offLinksUpdated) {
      offLinksUpdated();
      offLinksUpdated = null;
    }
    if (offLibraryUpdated) {
      offLibraryUpdated();
      offLibraryUpdated = null;
    }
    if (offFoldersUpdated) {
      offFoldersUpdated();
      offFoldersUpdated = null;
    }
    watchStarted = false;
  },
  };
});
