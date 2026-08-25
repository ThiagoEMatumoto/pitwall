import { ipcMain, shell } from "electron";
import { broadcast } from "../services/notify";
import * as assetStore from "../services/video/asset-store";
import * as brandKitStore from "../services/video/brand-kit-store";
import * as characterStore from "../services/video/character-store";
import * as projectStore from "../services/video/project-store";
import * as renderStore from "../services/video/render-store";
import * as scriptStore from "../services/video/script-store";
import * as templateStore from "../services/video/template-store";
import { generateAudio } from "../services/video/tts";
import { generateImage } from "../services/video/image-gen";
import { cancelRender, startRender } from "../services/video/render";
import type {
  CreateVideoBrandKitInput,
  CreateVideoCharacterInput,
  CreateVideoProjectInput,
  CreateVideoTemplateInput,
  GenerateVideoAssetsResult,
  GenerateVideoAudioInput,
  GenerateVideoImageInput,
  RegisterVideoAssetInput,
  ReorderVideoScenesInput,
  SaveVideoTemplateFromProjectInput,
  SetVideoCharacterRefsInput,
  SetVideoProjectCastInput,
  SetVideoScriptInput,
  StartVideoRenderInput,
  UpdateVideoBrandKitInput,
  UpdateVideoCharacterInput,
  UpdateVideoProjectInput,
  UpdateVideoTemplateInput,
  UpsertVideoSceneInput,
  VideoAsset,
  VideoAssetListFilter,
  VideoBrandKit,
  VideoCharacter,
  VideoCharacterListFilter,
  VideoCharacterMeta,
  VideoProject,
  VideoProjectListFilter,
  VideoProjectMeta,
  VideoRender,
  VideoRenderListFilter,
  VideoRenderMeta,
  VideoScene,
  VideoScriptLine,
  VideoTemplate,
  VideoTemplateListFilter,
} from "../../../shared/types/ipc";

// IPC do Video Lab. Molde de ipc/diagrams: handlers FINOS (a regra mora nos
// stores) e broadcast em toda mutação, pelos mesmos canais que o MCP usará.
//
// Os serviços de geração (TTS, imagem, render) recebem o `broadcast` INJETADO
// como dependência: eles mutam fora de um handler IPC (o render dura minutos e
// termina muito depois do invoke retornar) e precisam emitir o mesmo evento que
// o handler emitiria — mesma regra do job-runner do app.

const notifyDeps = { broadcast };

export function registerVideoIpc(): void {
  // Renders 'queued'/'running' de um boot anterior são órfãos: o processo do
  // Remotion morre junto com o app e o 'exit' que reconciliaria nunca dispara.
  // Mesma reconciliação de boot que db.ts já faz com sessões e handoffs.
  const orphans = renderStore.reconcileOrphans();
  if (orphans > 0) console.log(`[video] ${orphans} render(s) órfão(s) marcados como failed`);

  // ---- brand kits ----

  ipcMain.handle("video:brand-kits-list", (): VideoBrandKit[] =>
    brandKitStore.list(),
  );

  ipcMain.handle(
    "video:brand-kits-get",
    (_e, id: string): VideoBrandKit | null => brandKitStore.get(id),
  );

  ipcMain.handle(
    "video:brand-kits-create",
    (_e, input: CreateVideoBrandKitInput): VideoBrandKit => {
      const kit = brandKitStore.create(input);
      broadcast("videoBrandKit:updated", kit);
      return kit;
    },
  );

  ipcMain.handle(
    "video:brand-kits-update",
    (_e, input: UpdateVideoBrandKitInput): VideoBrandKit => {
      const kit = brandKitStore.update(input);
      broadcast("videoBrandKit:updated", kit);
      return kit;
    },
  );

  // Marcador { id, deleted } no MESMO canal do update: o brand kit não tem
  // canal de delete próprio, e a UI trata os dois como sinal de recarga.
  ipcMain.handle("video:brand-kits-delete", (_e, id: string): void => {
    brandKitStore.remove(id);
    broadcast("videoBrandKit:updated", { id, deleted: true });
  });

  // ---- personagens ----

  ipcMain.handle(
    "video:characters-list",
    (_e, filter?: VideoCharacterListFilter): VideoCharacterMeta[] =>
      characterStore.list(filter),
  );

  ipcMain.handle(
    "video:characters-get",
    (_e, id: string): VideoCharacter | null => characterStore.get(id),
  );

  ipcMain.handle(
    "video:characters-create",
    (_e, input: CreateVideoCharacterInput): VideoCharacter => {
      const character = characterStore.create(input);
      broadcast("videoCharacter:updated", character);
      return character;
    },
  );

  ipcMain.handle(
    "video:characters-update",
    (_e, input: UpdateVideoCharacterInput): VideoCharacter => {
      const character = characterStore.update(input);
      broadcast("videoCharacter:updated", character);
      return character;
    },
  );

  ipcMain.handle(
    "video:characters-set-refs",
    (_e, input: SetVideoCharacterRefsInput): VideoCharacter => {
      const character = characterStore.setRefs(input);
      broadcast("videoCharacter:updated", character);
      return character;
    },
  );

  ipcMain.handle(
    "video:characters-archive",
    (_e, id: string): VideoCharacter => {
      const character = characterStore.archive(id);
      broadcast("videoCharacter:updated", character);
      return character;
    },
  );

  ipcMain.handle(
    "video:characters-unarchive",
    (_e, id: string): VideoCharacter => {
      const character = characterStore.unarchive(id);
      broadcast("videoCharacter:updated", character);
      return character;
    },
  );

  // ---- templates ----

  ipcMain.handle(
    "video:templates-list",
    (_e, filter?: VideoTemplateListFilter): VideoTemplate[] =>
      templateStore.list(filter),
  );

  ipcMain.handle(
    "video:templates-get",
    (_e, id: string): VideoTemplate | null => templateStore.get(id),
  );

  ipcMain.handle(
    "video:templates-create",
    (_e, input: CreateVideoTemplateInput): VideoTemplate => {
      const template = templateStore.create(input);
      broadcast("videoTemplate:updated", template);
      return template;
    },
  );

  ipcMain.handle(
    "video:templates-update",
    (_e, input: UpdateVideoTemplateInput): VideoTemplate => {
      const template = templateStore.update(input);
      broadcast("videoTemplate:updated", template);
      return template;
    },
  );

  ipcMain.handle("video:templates-delete", (_e, id: string): void => {
    templateStore.remove(id);
    broadcast("videoTemplate:updated", { id, deleted: true });
  });

  // Fecha o ciclo de reuso: a peça que ficou boa vira molde da próxima.
  ipcMain.handle(
    "video:templates-save-from-project",
    (_e, input: SaveVideoTemplateFromProjectInput): VideoTemplate => {
      const template = templateStore.saveFromProject(input);
      broadcast("videoTemplate:updated", template);
      return template;
    },
  );

  // ---- peças ----

  ipcMain.handle(
    "video:projects-list",
    (_e, filter?: VideoProjectListFilter): VideoProjectMeta[] =>
      projectStore.list(filter),
  );

  ipcMain.handle("video:projects-get", (_e, id: string): VideoProject | null =>
    projectStore.get(id),
  );

  ipcMain.handle(
    "video:projects-create",
    (_e, input: CreateVideoProjectInput): VideoProject => {
      const project = projectStore.create(input);
      broadcast("videoProject:updated", project);
      return project;
    },
  );

  ipcMain.handle(
    "video:projects-update",
    (_e, input: UpdateVideoProjectInput): VideoProject => {
      const project = projectStore.update(input);
      broadcast("videoProject:updated", project);
      return project;
    },
  );

  ipcMain.handle(
    "video:projects-set-cast",
    (_e, input: SetVideoProjectCastInput): VideoProject => {
      const project = projectStore.setCast(input);
      broadcast("videoProject:updated", project);
      return project;
    },
  );

  ipcMain.handle("video:projects-archive", (_e, id: string): VideoProject => {
    const project = projectStore.archive(id);
    broadcast("videoProject:updated", project);
    return project;
  });

  ipcMain.handle("video:projects-unarchive", (_e, id: string): VideoProject => {
    const project = projectStore.unarchive(id);
    broadcast("videoProject:updated", project);
    return project;
  });

  // Direto (sem two-step archive→delete): a UI já confirma com o usuário antes
  // de chamar. O two-step é regra do MCP, onde não há diálogo.
  ipcMain.handle("video:projects-delete", (_e, id: string): void => {
    projectStore.remove(id);
    broadcast("videoProject:deleted", { id });
  });

  // ---- cenas ----

  ipcMain.handle("video:scenes-list", (_e, projectId: string): VideoScene[] =>
    projectStore.listScenes(projectId),
  );

  ipcMain.handle(
    "video:scenes-upsert",
    (_e, input: UpsertVideoSceneInput): VideoScene => {
      const scene = projectStore.upsertScene(input);
      broadcastScenes(input.projectId);
      return scene;
    },
  );

  ipcMain.handle(
    "video:scenes-reorder",
    (_e, input: ReorderVideoScenesInput): VideoScene[] => {
      const scenes = projectStore.reorderScenes(input);
      broadcast("videoScenes:updated", { projectId: input.projectId, scenes });
      return scenes;
    },
  );

  ipcMain.handle(
    "video:scenes-delete",
    (_e, projectId: string, sceneId: string): void => {
      projectStore.removeScene(projectId, sceneId);
      broadcastScenes(projectId);
    },
  );

  // ---- roteiro ----

  ipcMain.handle(
    "video:script-list",
    (_e, projectId: string, locale: string): VideoScriptLine[] =>
      scriptStore.list(projectId, locale),
  );

  ipcMain.handle(
    "video:script-set",
    (_e, input: SetVideoScriptInput): VideoScriptLine[] => {
      const lines = scriptStore.set(input);
      broadcast("videoScript:updated", {
        projectId: input.projectId,
        locale: input.locale,
      });
      return lines;
    },
  );

  // ---- assets ----

  ipcMain.handle(
    "video:assets-list",
    (_e, filter?: VideoAssetListFilter): VideoAsset[] =>
      assetStore.list(filter),
  );

  ipcMain.handle("video:assets-get", (_e, id: string): VideoAsset | null =>
    assetStore.get(id),
  );

  ipcMain.handle(
    "video:assets-register",
    (_e, input: RegisterVideoAssetInput): VideoAsset => {
      const asset = assetStore.register(input);
      broadcast("videoAsset:updated", asset);
      return asset;
    },
  );

  // Geração: `go !== true` é DRY-RUN (nenhuma chamada de API). O progresso do
  // lote chega por videoAsset:job, emitido de dentro do serviço.
  ipcMain.handle(
    "video:assets-generate-audio",
    (_e, input: GenerateVideoAudioInput): Promise<GenerateVideoAssetsResult> =>
      generateAudio(input, notifyDeps),
  );

  ipcMain.handle(
    "video:assets-generate-image",
    (_e, input: GenerateVideoImageInput): Promise<GenerateVideoAssetsResult> =>
      generateImage(input, notifyDeps),
  );

  // Só a linha do banco. O arquivo no disco é do serviço que o criou.
  ipcMain.handle("video:assets-delete", (_e, id: string): void => {
    assetStore.remove(id);
    broadcast("videoAsset:updated", { id, deleted: true });
  });

  // ---- renders ----

  ipcMain.handle(
    "video:renders-list",
    (_e, filter?: VideoRenderListFilter): VideoRenderMeta[] =>
      renderStore.list(filter),
  );

  ipcMain.handle("video:renders-get", (_e, id: string): VideoRender | null =>
    renderStore.get(id),
  );

  // Devolve a row 'queued' na hora; o resto chega por videoRender:progress e
  // videoRender:updated. NUNCA lança por falha do render — a row gravada com
  // status 'failed' É o resultado.
  ipcMain.handle(
    "video:renders-start",
    (_e, input: StartVideoRenderInput): VideoRenderMeta =>
      startRender(input, notifyDeps),
  );

  ipcMain.handle("video:renders-cancel", (_e, id: string): VideoRenderMeta =>
    cancelRender(id, notifyDeps),
  );

  ipcMain.handle(
    "video:renders-reveal",
    async (_e, id: string): Promise<void> => {
      const render = renderStore.get(id);
      if (!render?.outPath)
        throw new Error(`render ${id} ainda não tem arquivo`);
      await shell.openPath(render.outPath);
    },
  );
}

// Cena mudou ⇒ o conjunto INTEIRO da peça vai no evento. A UI reordena e
// renumera, então mandar só a cena tocada obrigaria o renderer a adivinhar o
// resto.
function broadcastScenes(projectId: string): void {
  broadcast("videoScenes:updated", {
    projectId,
    scenes: projectStore.listScenes(projectId),
  });
}
