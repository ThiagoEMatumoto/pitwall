import { create } from "zustand";
import { videoApi } from "@/lib/ipc";
import type {
  CreateVideoProjectInput,
  GenerateVideoAudioInput,
  SetVideoProjectCastInput,
  SetVideoScriptInput,
  VideoAsset,
  VideoAssetJobEvent,
  VideoBrandKit,
  VideoCharacter,
  VideoCharacterMeta,
  VideoProject,
  VideoProjectMeta,
  VideoRenderMeta,
  VideoRenderProgressEvent,
  VideoScene,
  VideoScriptLine,
  VideoTemplate,
} from "../../shared/types/ipc";

// Donos únicos das assinaturas (molde do diagramsStore): o effect da área monta
// duas vezes no StrictMode e a 2ª chamada precisa ser no-op.
let offProjectUpdated: (() => void) | null = null;
let offProjectDeleted: (() => void) | null = null;
let offScenesUpdated: (() => void) | null = null;
let offScriptUpdated: (() => void) | null = null;
let offAssetUpdated: (() => void) | null = null;
let offAssetJob: (() => void) | null = null;
let offRenderUpdated: (() => void) | null = null;
let offRenderProgress: (() => void) | null = null;
let offTemplateUpdated: (() => void) | null = null;
let offCharacterUpdated: (() => void) | null = null;
let offBrandKitUpdated: (() => void) | null = null;
let watchStarted = false;

// Token da seleção em voo: um get() que resolve depois de outro select()
// descarta o resultado obsoleto (mesmo anti-race do diagramsStore).
let selectSeq = 0;

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function toMeta(p: VideoProject): VideoProjectMeta {
  const { cast: _cast, scenes: _scenes, ...meta } = p;
  return meta;
}

function upsertMeta(
  list: VideoProjectMeta[],
  meta: VideoProjectMeta,
): VideoProjectMeta[] {
  const rest = list.filter((m) => m.id !== meta.id);
  return [...rest, meta].sort((a, b) => b.updatedAt - a.updatedAt);
}

function upsertAsset(list: VideoAsset[], asset: VideoAsset): VideoAsset[] {
  const rest = list.filter((a) => a.id !== asset.id);
  return [asset, ...rest].sort((a, b) => b.createdAt - a.createdAt);
}

function upsertRender(
  list: VideoRenderMeta[],
  render: VideoRenderMeta,
): VideoRenderMeta[] {
  const rest = list.filter((r) => r.id !== render.id);
  return [render, ...rest].sort((a, b) => b.createdAt - a.createdAt);
}

interface VideosState {
  // Biblioteca reusável (não pertence a peça nenhuma).
  templates: VideoTemplate[];
  characters: VideoCharacterMeta[];
  brandKits: VideoBrandKit[];
  /** Personagem completo (com refs), carregado sob demanda pelo CastPanel. */
  characterDetail: Record<string, VideoCharacter>;
  libraryLoading: boolean;
  libraryError: string | null;

  projects: VideoProjectMeta[];
  selected: VideoProject | null;
  showArchived: boolean;
  loading: boolean;
  error: string | null;

  /** Locale corrente do roteiro/render (sempre um dos `selected.locales`). */
  locale: string | null;
  script: VideoScriptLine[];
  scriptLoading: boolean;
  scriptError: string | null;

  assets: VideoAsset[];
  assetsLoading: boolean;
  assetsError: string | null;
  /** Último evento de lote — o painel mostra "gerando…/reusado" ao vivo. */
  assetJob: VideoAssetJobEvent | null;
  generating: boolean;

  renders: VideoRenderMeta[];
  rendersLoading: boolean;
  rendersError: string | null;
  /** renderId → último progresso recebido (não é persistido em lugar nenhum). */
  renderProgress: Record<string, VideoRenderProgressEvent>;

  loadLibrary: () => Promise<void>;
  load: () => Promise<void>;
  select: (id: string | null) => Promise<void>;
  setShowArchived: (show: boolean) => Promise<void>;
  createProject: (input: CreateVideoProjectInput) => Promise<VideoProject>;
  archive: (id: string) => Promise<void>;
  unarchive: (id: string) => Promise<void>;
  setLocale: (locale: string) => Promise<void>;
  loadScript: () => Promise<void>;
  saveScript: (input: SetVideoScriptInput) => Promise<void>;
  setCast: (input: SetVideoProjectCastInput) => Promise<void>;
  ensureCharacter: (id: string) => Promise<void>;
  loadAssets: () => Promise<void>;
  generateAudio: (input: GenerateVideoAudioInput) => Promise<void>;
  loadRenders: () => Promise<void>;
  startRender: (locale: string) => Promise<void>;
  cancelRender: (id: string) => Promise<void>;
  revealRender: (id: string) => Promise<void>;
  startWatch: () => void;
  stopWatch: () => void;
}

export const useVideosStore = create<VideosState>((set, get) => ({
  templates: [],
  characters: [],
  brandKits: [],
  characterDetail: {},
  libraryLoading: false,
  libraryError: null,

  projects: [],
  selected: null,
  showArchived: false,
  loading: false,
  error: null,

  locale: null,
  script: [],
  scriptLoading: false,
  scriptError: null,

  assets: [],
  assetsLoading: false,
  assetsError: null,
  assetJob: null,
  generating: false,

  renders: [],
  rendersLoading: false,
  rendersError: null,
  renderProgress: {},

  loadLibrary: async () => {
    set({ libraryLoading: true, libraryError: null });
    try {
      const [templates, characters, brandKits] = await Promise.all([
        videoApi.templates.list(),
        videoApi.characters.list(),
        videoApi.brandKits.list(),
      ]);
      set({ templates, characters, brandKits, libraryLoading: false });
    } catch (err) {
      set({ libraryLoading: false, libraryError: errMsg(err) });
    }
  },

  load: async () => {
    set({ loading: true, error: null });
    try {
      const projects = await videoApi.projects.list({
        includeArchived: get().showArchived,
      });
      set({ projects, loading: false });
    } catch (err) {
      set({ loading: false, error: errMsg(err) });
    }
  },

  select: async (id) => {
    const token = ++selectSeq;
    if (!id) {
      set({
        selected: null,
        locale: null,
        script: [],
        assets: [],
        renders: [],
      });
      return;
    }
    const project = await videoApi.projects.get(id);
    if (!project || token !== selectSeq) return;
    set({
      selected: project,
      locale: project.locales[0] ?? null,
      script: [],
      assets: [],
      renders: [],
      scriptError: null,
      assetsError: null,
      rendersError: null,
    });
    await Promise.all([
      get().loadScript(),
      get().loadAssets(),
      get().loadRenders(),
    ]);
  },

  setShowArchived: async (show) => {
    set({ showArchived: show });
    await get().load();
  },

  createProject: async (input) => {
    const project = await videoApi.projects.create(input);
    set((s) => ({ projects: upsertMeta(s.projects, toMeta(project)) }));
    await get().select(project.id);
    return project;
  },

  archive: async (id) => {
    await videoApi.projects.archive(id);
    await get().load();
    if (get().selected?.id === id) await get().select(id);
  },

  unarchive: async (id) => {
    await videoApi.projects.unarchive(id);
    await get().load();
    if (get().selected?.id === id) await get().select(id);
  },

  setLocale: async (locale) => {
    set({ locale, script: [] });
    await get().loadScript();
  },

  loadScript: async () => {
    const { selected, locale } = get();
    if (!selected || !locale) {
      set({ script: [] });
      return;
    }
    set({ scriptLoading: true, scriptError: null });
    try {
      const script = await videoApi.script.list(selected.id, locale);
      // O usuário pode ter trocado de peça/locale enquanto a lista vinha.
      const cur = get();
      if (cur.selected?.id !== selected.id || cur.locale !== locale) return;
      set({ script, scriptLoading: false });
    } catch (err) {
      set({ scriptLoading: false, scriptError: errMsg(err) });
    }
  },

  saveScript: async (input) => {
    const script = await videoApi.script.set(input);
    const cur = get();
    if (cur.selected?.id === input.projectId && cur.locale === input.locale) {
      set({ script });
    }
  },

  setCast: async (input) => {
    const project = await videoApi.projects.setCast(input);
    set((s) => ({
      projects: upsertMeta(s.projects, toMeta(project)),
      selected: s.selected?.id === project.id ? project : s.selected,
    }));
  },

  ensureCharacter: async (id) => {
    if (get().characterDetail[id]) return;
    const character = await videoApi.characters.get(id);
    if (!character) return;
    set((s) => ({
      characterDetail: { ...s.characterDetail, [id]: character },
    }));
  },

  loadAssets: async () => {
    const selected = get().selected;
    if (!selected) {
      set({ assets: [] });
      return;
    }
    set({ assetsLoading: true, assetsError: null });
    try {
      const assets = await videoApi.assets.list({ projectId: selected.id });
      if (get().selected?.id !== selected.id) return;
      set({ assets, assetsLoading: false });
    } catch (err) {
      set({ assetsLoading: false, assetsError: errMsg(err) });
    }
  },

  generateAudio: async (input) => {
    set({ generating: true, assetsError: null });
    try {
      await videoApi.assets.generateAudio(input);
      await get().loadAssets();
      set({ generating: false });
    } catch (err) {
      set({ generating: false, assetsError: errMsg(err) });
    }
  },

  loadRenders: async () => {
    const selected = get().selected;
    if (!selected) {
      set({ renders: [] });
      return;
    }
    set({ rendersLoading: true, rendersError: null });
    try {
      const renders = await videoApi.renders.list({ projectId: selected.id });
      if (get().selected?.id !== selected.id) return;
      set({ renders, rendersLoading: false });
    } catch (err) {
      set({ rendersLoading: false, rendersError: errMsg(err) });
    }
  },

  startRender: async (locale) => {
    const selected = get().selected;
    if (!selected) return;
    set({ rendersError: null });
    try {
      // `start` nunca lança por FALHA do render (a row 'failed' é o resultado);
      // um throw aqui é erro de enfileiramento, e esse sim vira estado de erro.
      const render = await videoApi.renders.start({
        projectId: selected.id,
        locale,
      });
      set((s) => ({ renders: upsertRender(s.renders, render) }));
    } catch (err) {
      set({ rendersError: errMsg(err) });
    }
  },

  cancelRender: async (id) => {
    const render = await videoApi.renders.cancel(id);
    set((s) => ({ renders: upsertRender(s.renders, render) }));
  },

  revealRender: async (id) => {
    await videoApi.renders.reveal(id);
  },

  startWatch: () => {
    if (watchStarted) return;
    watchStarted = true;

    offProjectUpdated = videoApi.projects.onUpdated((payload) => {
      const project = payload as VideoProject;
      if (!project?.id) return;
      set((s) => {
        const inFilter = s.showArchived || project.archivedAt === null;
        const projects = inFilter
          ? upsertMeta(s.projects, toMeta(project))
          : s.projects.filter((m) => m.id !== project.id);
        return {
          projects,
          selected: s.selected?.id === project.id ? project : s.selected,
        };
      });
    });

    offProjectDeleted = videoApi.projects.onDeleted((payload) => {
      const { id } = (payload ?? {}) as { id?: string };
      if (!id) return;
      set((s) =>
        s.selected?.id === id
          ? {
              projects: s.projects.filter((m) => m.id !== id),
              selected: null,
              locale: null,
              script: [],
              assets: [],
              renders: [],
            }
          : { projects: s.projects.filter((m) => m.id !== id) },
      );
    });

    offScenesUpdated = videoApi.scenes.onUpdated((payload) => {
      const { projectId, scenes } = (payload ?? {}) as {
        projectId?: string;
        scenes?: VideoScene[];
      };
      if (!projectId || !scenes) return;
      set((s) =>
        s.selected?.id === projectId
          ? { selected: { ...s.selected, scenes } }
          : s,
      );
    });

    offScriptUpdated = videoApi.script.onUpdated((payload) => {
      const { projectId, locale } = (payload ?? {}) as {
        projectId?: string;
        locale?: string;
      };
      const cur = get();
      // Só recarrega se o broadcast for do que está aberto — Claude pode estar
      // escrevendo o roteiro de outro locale/peça pelo MCP.
      if (cur.selected?.id === projectId && cur.locale === locale) {
        void cur.loadScript();
      }
    });

    offAssetUpdated = videoApi.assets.onUpdated((payload) => {
      const marker = (payload ?? {}) as { id?: string; deleted?: boolean };
      if (!marker.id) return;
      if (marker.deleted) {
        set((s) => ({ assets: s.assets.filter((a) => a.id !== marker.id) }));
        return;
      }
      const asset = payload as VideoAsset;
      set((s) => {
        // Asset compartilhado (projectId null) não entra na lista da peça.
        if (asset.projectId !== s.selected?.id) return s;
        return { assets: upsertAsset(s.assets, asset) };
      });
    });

    offAssetJob = videoApi.assets.onJobEvent((payload) => {
      const event = payload as VideoAssetJobEvent;
      if (!event?.projectId) return;
      if (get().selected?.id !== event.projectId) return;
      set({ assetJob: event });
    });

    offRenderUpdated = videoApi.renders.onUpdated((payload) => {
      const render = payload as VideoRenderMeta;
      if (!render?.id) return;
      if (get().selected?.id !== render.projectId) return;
      set((s) => ({ renders: upsertRender(s.renders, render) }));
    });

    offRenderProgress = videoApi.renders.onProgress((payload) => {
      const event = payload as VideoRenderProgressEvent;
      if (!event?.renderId) return;
      if (get().selected?.id !== event.projectId) return;
      set((s) => ({
        renderProgress: { ...s.renderProgress, [event.renderId]: event },
      }));
    });

    offTemplateUpdated = videoApi.templates.onUpdated(() => {
      void get().loadLibrary();
    });
    offCharacterUpdated = videoApi.characters.onUpdated((payload) => {
      const character = payload as VideoCharacter;
      if (character?.id) {
        set((s) => ({
          characterDetail: { ...s.characterDetail, [character.id]: character },
        }));
      }
      void get().loadLibrary();
    });
    offBrandKitUpdated = videoApi.brandKits.onUpdated(() => {
      void get().loadLibrary();
    });
  },

  stopWatch: () => {
    const offs = [
      offProjectUpdated,
      offProjectDeleted,
      offScenesUpdated,
      offScriptUpdated,
      offAssetUpdated,
      offAssetJob,
      offRenderUpdated,
      offRenderProgress,
      offTemplateUpdated,
      offCharacterUpdated,
      offBrandKitUpdated,
    ];
    for (const off of offs) off?.();
    offProjectUpdated = null;
    offProjectDeleted = null;
    offScenesUpdated = null;
    offScriptUpdated = null;
    offAssetUpdated = null;
    offAssetJob = null;
    offRenderUpdated = null;
    offRenderProgress = null;
    offTemplateUpdated = null;
    offCharacterUpdated = null;
    offBrandKitUpdated = null;
    watchStarted = false;
  },
}));
