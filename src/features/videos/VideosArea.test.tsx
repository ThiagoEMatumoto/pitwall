import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { VideoProject, VideoProjectMeta } from "../../../shared/types/ipc";

const sub = () => vi.fn(() => () => {});

vi.mock("@/lib/ipc", () => ({
  shellApi: { openPath: vi.fn(), openExternal: vi.fn() },
  videoApi: {
    brandKits: { list: vi.fn().mockResolvedValue([]), onUpdated: sub() },
    characters: {
      list: vi.fn().mockResolvedValue([]),
      get: vi.fn(),
      onUpdated: sub(),
    },
    templates: { list: vi.fn().mockResolvedValue([]), onUpdated: sub() },
    projects: {
      list: vi.fn().mockResolvedValue([]),
      get: vi.fn(),
      create: vi.fn(),
      setCast: vi.fn(),
      archive: vi.fn(),
      unarchive: vi.fn(),
      onUpdated: sub(),
      onDeleted: sub(),
    },
    scenes: { onUpdated: sub() },
    script: {
      list: vi.fn().mockResolvedValue([]),
      set: vi.fn(),
      onUpdated: sub(),
    },
    assets: {
      list: vi.fn().mockResolvedValue([]),
      generateAudio: vi.fn(),
      onUpdated: sub(),
      onJobEvent: sub(),
    },
    renders: {
      list: vi.fn().mockResolvedValue([]),
      start: vi.fn(),
      cancel: vi.fn(),
      reveal: vi.fn(),
      onProgress: sub(),
      onUpdated: sub(),
    },
  },
}));

const { VideosArea } = await import("./VideosArea");
const { useVideosStore } = await import("@/store/videosStore");
const { videoApi } = await import("@/lib/ipc");

function makeMeta(over: Partial<VideoProjectMeta> = {}): VideoProjectMeta {
  return {
    id: "p1",
    slug: "pitwall-promo",
    title: "Promo de lançamento",
    description: "",
    kind: "promo",
    templateId: "t1",
    brandKitId: "b1",
    locales: ["pt-BR", "en-US"],
    themePreset: "slate",
    status: "scripting",
    createdAt: 1000,
    updatedAt: Date.now(),
    archivedAt: null,
    ...over,
  };
}

function makeProject(over: Partial<VideoProject> = {}): VideoProject {
  return {
    ...makeMeta(),
    cast: [],
    scenes: [
      {
        id: "s1",
        projectId: "p1",
        sceneId: "cold-open",
        ord: 0,
        role: "Abertura",
        targetSec: 4,
        visual: "",
        createdAt: 1000,
        updatedAt: 1000,
      },
    ],
    ...over,
  };
}

describe("VideosArea (smoke)", () => {
  it("estado vazio ensina o modelo: a peça nasce de um template", () => {
    useVideosStore.setState({
      projects: [],
      selected: null,
      loading: false,
      error: null,
    });
    render(<VideosArea />);
    expect(screen.getByText("Vídeos")).toBeInTheDocument();
    expect(screen.getByTitle("Nova peça")).toBeInTheDocument();
    expect(
      screen.getAllByText(/Uma peça nunca começa do zero/i).length,
    ).toBeGreaterThan(0);
    expect(screen.getAllByText(/template/i).length).toBeGreaterThan(0);
  });

  it("agrupa a lista por categoria e mostra status, locales e arquivadas", () => {
    const projects = [
      makeMeta(),
      makeMeta({
        id: "p2",
        title: "História do Pit",
        kind: "character-story",
        status: "done",
        archivedAt: 5000,
      }),
    ];
    useVideosStore.setState({
      projects,
      selected: null,
      showArchived: true,
      loading: false,
      error: null,
    });
    render(<VideosArea />);
    expect(screen.getByText("Promo")).toBeInTheDocument();
    expect(screen.getByText("História de personagem")).toBeInTheDocument();
    expect(screen.getByText("Promo de lançamento")).toBeInTheDocument();
    expect(screen.getByText("Roteiro")).toBeInTheDocument();
    expect(screen.getAllByText("pt-BR · en-US").length).toBe(2);
    expect(screen.getByText("Arquivada")).toBeInTheDocument();
  });

  it("com peça selecionada mostra cabeçalho, seletor de locale e abas", () => {
    useVideosStore.setState({
      projects: [makeMeta()],
      selected: makeProject(),
      locale: "pt-BR",
      script: [],
      assets: [],
      renders: [],
      loading: false,
      error: null,
    });
    render(<VideosArea />);
    expect(screen.getAllByText("Promo de lançamento").length).toBe(2);
    expect(screen.getByText("pitwall-promo")).toBeInTheDocument();
    for (const tab of ["Elenco", "Marca", "Assets", "Renders"]) {
      expect(screen.getByRole("button", { name: tab })).toBeInTheDocument();
    }
    // Aba default é o roteiro: a cena do blueprint tem que aparecer.
    expect(screen.getByText("cold-open")).toBeInTheDocument();
    expect(screen.getByText("Abertura")).toBeInTheDocument();
  });

  it("mostra o erro da lista sem derrubar a área", async () => {
    // O load() do effect roda no mount e limparia um error semeado à mão — o
    // erro tem que vir do caminho real, a chamada de IPC falhando.
    const listMock = videoApi.projects.list as ReturnType<typeof vi.fn>;
    listMock.mockRejectedValueOnce(new Error("banco indisponível"));
    useVideosStore.setState({
      projects: [],
      selected: null,
      loading: false,
      error: null,
    });
    render(<VideosArea />);
    expect(await screen.findByText("banco indisponível")).toBeInTheDocument();
  });
});
