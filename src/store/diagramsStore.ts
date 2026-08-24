import { create } from "zustand";
import { diagramsApi } from "@/lib/ipc";
import { navigateToDiagram } from "@/lib/nav";
import { showToast } from "@/features/notifications/toast-store";
import type {
  Diagram,
  DiagramLibraryItem,
  DiagramLink,
  DiagramMeta,
  DiagramScene,
  UpdateDiagramSceneInput,
} from "../../shared/types/ipc";

// Donos únicos das assinaturas (StrictMode-safe, molde do contentContractsStore):
// `watchStarted` guarda contra o duplo-mount do effect — a 2ª chamada é no-op.
let offUpdated: (() => void) | null = null;
let offDeleted: (() => void) | null = null;
let offLinksUpdated: (() => void) | null = null;
let offLibraryUpdated: (() => void) | null = null;
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

interface DiagramsState {
  diagrams: DiagramMeta[];
  selected: Diagram | null;
  showArchived: boolean;
  loading: boolean;
  error: string | null;
  remoteScene: RemoteScene | null;
  remoteLibrary: RemoteLibrary | null;

  load: () => Promise<void>;
  select: (id: string | null) => Promise<void>;
  setShowArchived: (show: boolean) => Promise<void>;
  create: () => Promise<void>;
  rename: (id: string, title: string) => Promise<void>;
  archive: (id: string) => Promise<void>;
  unarchive: (id: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  // Debounce fica no editor; aqui é o write direto (head e/ou snapshot).
  saveScene: (input: UpdateDiagramSceneInput) => Promise<void>;
  startWatch: () => void;
  stopWatch: () => void;
}

export const useDiagramsStore = create<DiagramsState>((set, get) => ({
  diagrams: [],
  selected: null,
  showArchived: false,
  loading: false,
  error: null,
  remoteScene: null,
  remoteLibrary: null,

  load: async () => {
    set({ loading: true, error: null });
    try {
      const diagrams = await diagramsApi.list({
        status: get().showArchived ? "all" : "active",
      });
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

  setShowArchived: async (show) => {
    set({ showArchived: show });
    await get().load();
  },

  create: async () => {
    const diagram = await diagramsApi.create({
      title: "Novo diagrama",
      scene: { elements: [] },
      author: "human",
      sourceFormat: "scene",
    });
    set((s) => ({
      diagrams: upsertMeta(s.diagrams, toMeta(diagram)),
      selected: diagram,
      remoteScene: null,
    }));
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
    await diagramsApi.archive(id);
    // Recarrega a lista: com "mostrar arquivados" desligado o item sai dela.
    await get().load();
    const sel = get().selected;
    if (sel?.id === id) {
      set({ selected: { ...sel, status: "archived" } });
    }
  },

  unarchive: async (id) => {
    await diagramsApi.unarchive(id);
    await get().load();
    const sel = get().selected;
    if (sel?.id === id) {
      set({ selected: { ...sel, status: "active" } });
    }
  },

  remove: async (id) => {
    await diagramsApi.delete(id);
    set((s) => ({
      diagrams: s.diagrams.filter((m) => m.id !== id),
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
        const inFilter = s.showArchived || diagram.status === "active";
        const diagrams = inFilter
          ? upsertMeta(s.diagrams, toMeta(diagram))
          : s.diagrams.filter((m) => m.id !== diagram.id);
        if (s.selected?.id !== diagram.id) return { diagrams };
        // Diagrama aberto: repassa a cena nova pro editor via remoteScene.
        // O editor decide se aplica (sem edição local pendente), mostra o
        // banner (com pendência) ou ignora (eco do próprio save).
        return {
          diagrams,
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
        selected: s.selected?.id === id ? null : s.selected,
        remoteScene: s.selected?.id === id ? null : s.remoteScene,
      }));
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
    watchStarted = false;
  },
}));
