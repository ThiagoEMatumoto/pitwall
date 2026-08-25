import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type {
  VideoBrandKit,
  VideoCharacterMeta,
  VideoTemplate,
} from "../../../shared/types/ipc";

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
      onUpdated: sub(),
      onDeleted: sub(),
    },
    scenes: { onUpdated: sub() },
    script: { list: vi.fn().mockResolvedValue([]), onUpdated: sub() },
    assets: {
      list: vi.fn().mockResolvedValue([]),
      onUpdated: sub(),
      onJobEvent: sub(),
    },
    renders: {
      list: vi.fn().mockResolvedValue([]),
      onProgress: sub(),
      onUpdated: sub(),
    },
  },
}));

const { NewProjectDialog } = await import("./NewProjectDialog");
const { useVideosStore } = await import("@/store/videosStore");

const brandKit: VideoBrandKit = {
  id: "b1",
  name: "Pitwall",
  tokens: {
    palette: { accent: "#9D8CFF", bg: "#08080B" },
    typography: { display: "Schibsted Grotesk" },
  },
  toneOfVoice: "Direto, sem hype.",
  doDont: { do: ["Falar de mecânica"], dont: ["Prometer mágica"] },
  logoAssetId: null,
  ttsVoices: { "pt-BR": "voice-pt", "en-US": "voice-en" },
  createdAt: 1,
  updatedAt: 1,
};

const character: VideoCharacterMeta = {
  id: "c1",
  name: "Pit",
  canonicalDescription: "Engenheiro de pista",
  visualSpec: { canonical: "homem, 30s", invariants: [], negative: [] },
  voiceId: null,
  createdAt: 1,
  updatedAt: 1,
  archivedAt: null,
};

const promoTemplate: VideoTemplate = {
  id: "t1",
  kind: "promo",
  name: "Promo 60s",
  description: "",
  sceneBlueprint: [
    { sceneId: "cold-open", role: "Abertura", targetSec: 4 },
    { sceneId: "logo", role: "Assinatura", targetSec: 3 },
  ],
  brandKitId: "b1",
  defaultCast: [{ characterId: "c1", roleInPiece: "narrador" }],
  createdAt: 1,
  updatedAt: 1,
};

const storyTemplate: VideoTemplate = {
  ...promoTemplate,
  id: "t2",
  kind: "character-story",
  name: "História em 3 atos",
  sceneBlueprint: [],
  defaultCast: [],
};

function seed(templates: VideoTemplate[] = [promoTemplate, storyTemplate]) {
  useVideosStore.setState({
    templates,
    brandKits: [brandKit],
    characters: [character],
    libraryLoading: false,
    libraryError: null,
  });
}

describe("NewProjectDialog", () => {
  it("lista templates agrupados por categoria", () => {
    seed();
    render(<NewProjectDialog open onClose={() => {}} />);
    expect(screen.getByText("Promo")).toBeInTheDocument();
    expect(screen.getByText("História de personagem")).toBeInTheDocument();
    expect(screen.getByText("Promo 60s")).toBeInTheDocument();
    expect(screen.getByText("Começar em branco")).toBeInTheDocument();
  });

  it("mostra o que a peça herda ao escolher o template", () => {
    seed();
    render(<NewProjectDialog open onClose={() => {}} />);
    // Sem template escolhido o dialog diz que aquilo é o caminho de exceção.
    expect(screen.getAllByText(/caminho de exceção/i).length).toBeGreaterThan(
      0,
    );

    fireEvent.click(screen.getByText("Promo 60s"));

    expect(screen.getByText("Pitwall")).toBeInTheDocument();
    expect(screen.getByText("Pit · narrador")).toBeInTheDocument();
    expect(screen.getByText("cold-open")).toBeInTheDocument();
    expect(screen.getByText("logo")).toBeInTheDocument();
    expect(screen.getByText("Assinatura")).toBeInTheDocument();
    // Duração-alvo somada do blueprint (4s + 3s).
    expect(screen.getByText("7s")).toBeInTheDocument();
    // Os locales com voz de TTS no brand kit viram o default da peça.
    expect(screen.getByLabelText("Locales")).toHaveValue("pt-BR, en-US");
  });

  it("cria a peça herdando kind e templateId, com slug derivado do título", async () => {
    const createProject = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    seed();
    // O dialog só precisa provar QUE chama a ação com o input certo; o retorno
    // real (VideoProject) é problema do store, testado pelo caminho dele.
    useVideosStore.setState({ createProject: createProject as never });
    render(<NewProjectDialog open onClose={onClose} />);

    fireEvent.click(screen.getByText("Promo 60s"));
    fireEvent.change(screen.getByLabelText("Título"), {
      target: { value: "Promo de Lançamento" },
    });
    expect(screen.getByLabelText("Slug")).toHaveValue("promo-de-lancamento");

    fireEvent.click(screen.getByRole("button", { name: "Criar peça" }));

    await waitFor(() => expect(createProject).toHaveBeenCalledTimes(1));
    expect(createProject).toHaveBeenCalledWith({
      slug: "promo-de-lancamento",
      title: "Promo de Lançamento",
      kind: "promo",
      templateId: "t1",
      locales: ["pt-BR", "en-US"],
    });
    expect(onClose).toHaveBeenCalled();
  });

  it("sem título o botão de criar fica desabilitado", () => {
    seed();
    render(<NewProjectDialog open onClose={() => {}} />);
    expect(screen.getByRole("button", { name: "Criar peça" })).toBeDisabled();
  });

  it("biblioteca vazia explica de onde vêm os templates", () => {
    seed([]);
    render(<NewProjectDialog open onClose={() => {}} />);
    expect(
      screen.getAllByText(/Nenhum template ainda/i).length,
    ).toBeGreaterThan(0);
  });
});
