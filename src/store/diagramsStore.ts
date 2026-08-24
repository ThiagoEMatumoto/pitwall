import { create } from "zustand";
import { diagramsApi } from "@/lib/ipc";
import type {
  Diagram,
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
let watchStarted = false;

// Cena vinda de broadcast (ex.: Claude editou via MCP) endereçada ao editor
// aberto. O nonce muda a cada broadcast — é o que o effect do editor observa
// (a cena em si pode ser deep-equal e mesmo assim precisar reaplicar).
export interface RemoteScene {
  scene: DiagramScene;
  nonce: number;
}

let remoteNonce = 0;

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
    if (!id) {
      set({ selected: null, remoteScene: null });
      return;
    }
    const diagram = await diagramsApi.get(id);
    // Ignora resultado obsoleto se o usuário já trocou de seleção nesse meio
    // tempo (só acontece com cliques rápidos; get é barato mas assíncrono).
    if (diagram) set({ selected: diagram, remoteScene: null });
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
    watchStarted = false;
  },
}));
