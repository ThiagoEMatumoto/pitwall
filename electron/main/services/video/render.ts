import { spawn, type ChildProcess } from "node:child_process";
import { statSync } from "node:fs";
import { createInterface, type Interface } from "node:readline";
import { join } from "node:path";
import { spawnEnv } from "../custom-env";
import * as projectStore from "./project-store";
import * as renderStore from "./render-store";
import { writeContract } from "./manifest";
import { ensureDir, videoOutDir, videoWorkspaceDir } from "./paths";
import type {
  StartVideoRenderInput,
  VideoRenderMeta,
  VideoRenderProgressEvent,
} from "../../../../shared/types/ipc";

// Render do Remotion. Processo longo (minutos) com progresso ao vivo.
//
// TRANSPORTE: `child_process.spawn` + readline, NÃO node-pty — o PTY funde
// stdout e stderr e injeta FORCE_COLOR, e é justamente do stdout que sai a
// linha de progresso que precisamos ler (meeting-sidecar-manager.ts:6-11).
//
// INVARIANTE (copiada do job-runner, services/job-runner.ts:186-189): esta
// função NUNCA lança pro chamador depois de enfileirar. Todo caminho — spawn
// que falha, exit ≠ 0, app fechado no meio — cai num update para 'failed', pra
// a row jamais ficar presa em 'running'. Quem quer saber se deu certo lê o
// status da row; a row É o resultado.
//
// O Remotion não emite NDJSON, então o progresso é parseado com tolerância
// (regex de "N/M frames"). Linha que não casa é só log: parse nunca falha o
// render.

const RENDER_TIMEOUT_MS = 30 * 60_000;

export interface RenderDeps {
  broadcast?: (channel: string, payload: unknown) => void;
  spawnImpl?: typeof spawn;
}

interface Tracked {
  child: ChildProcess;
  outRl: Interface;
  errRl: Interface;
  timer: NodeJS.Timeout;
  cancelled: boolean;
}

const running = new Map<string, Tracked>();

// As composições do motor são `Promo-pt-BR`, `Promo-en`: <Kind>-<locale>, com
// o kind capitalizado. Deriva daqui em vez de guardar no banco porque a fonte
// de verdade é o `src/index.ts` do workspace, não o app.
export function compositionIdFor(kind: string, locale: string): string {
  const head = kind.trim();
  const pascal = head.charAt(0).toUpperCase() + head.slice(1);
  return `${pascal}-${locale}`;
}

// "Rendered 120/300", "120/300 frames", "45%". Devolve null quando a linha não
// carrega progresso — a maioria não carrega, e isso é normal.
export function parseProgress(line: string): {
  renderedFrames: number | null;
  totalFrames: number | null;
  progress: number | null;
} | null {
  const frames = line.match(/(\d+)\s*\/\s*(\d+)/);
  if (frames) {
    const rendered = Number(frames[1]);
    const total = Number(frames[2]);
    if (total > 0 && rendered <= total) {
      return {
        renderedFrames: rendered,
        totalFrames: total,
        progress: rendered / total,
      };
    }
  }
  const percent = line.match(/(\d{1,3})\s*%/);
  if (percent) {
    const pct = Number(percent[1]);
    if (pct >= 0 && pct <= 100) {
      return { renderedFrames: null, totalFrames: null, progress: pct / 100 };
    }
  }
  return null;
}

function emitProgress(
  deps: RenderDeps,
  render: { id: string; projectId: string; locale: string },
  patch: Partial<VideoRenderProgressEvent> & {
    status: VideoRenderProgressEvent["status"];
  },
): void {
  const event: VideoRenderProgressEvent = {
    renderId: render.id,
    projectId: render.projectId,
    locale: render.locale,
    status: patch.status,
    progress: patch.progress ?? null,
    renderedFrames: patch.renderedFrames ?? null,
    totalFrames: patch.totalFrames ?? null,
    message: patch.message ?? null,
  };
  deps.broadcast?.("videoRender:progress", event);
}

function finish(
  deps: RenderDeps,
  renderId: string,
  projectId: string,
  locale: string,
  patch: Omit<renderStore.UpdateRenderInput, "id" | "finishedAt">,
  message: string | null,
): void {
  const meta = renderStore.update({
    ...patch,
    id: renderId,
    finishedAt: Date.now(),
  });
  deps.broadcast?.("videoRender:updated", meta);
  emitProgress(
    deps,
    { id: renderId, projectId, locale },
    { status: meta.status, message },
  );
}

// Enfileira e dispara. Devolve a row 'queued' IMEDIATAMENTE — o render leva
// minutos e o handler IPC não pode esperar por ele.
export function startRender(
  input: StartVideoRenderInput,
  deps: RenderDeps = {},
): VideoRenderMeta {
  const project = projectStore.get(input.projectId);
  if (!project) throw new Error(`video project not found: ${input.projectId}`);
  if (!project.locales.includes(input.locale)) {
    throw new Error(`locale ${input.locale} não está na peça ${project.slug}`);
  }
  const meta = renderStore.enqueue(input.projectId, input.locale);
  deps.broadcast?.("videoRender:updated", meta);
  void run(meta.id, project.id, project.slug, project.kind, input.locale, deps);
  return meta;
}

// Fire-and-forget. NUNCA lança: o try/catch envolve o corpo inteiro, inclusive
// a escrita do contrato e o spawn.
async function run(
  renderId: string,
  projectId: string,
  slug: string,
  kind: string,
  locale: string,
  deps: RenderDeps,
): Promise<void> {
  try {
    // O motor lê o roteiro e o manifesto do DISCO: renderizar sem reescrevê-los
    // produziria um vídeo silenciosamente desatualizado.
    await writeContract(projectId);

    const workspace = videoWorkspaceDir();
    const outDir = videoOutDir();
    ensureDir(outDir);
    const outPath = join(outDir, `${slug}-${locale}.mp4`);
    const composition = compositionIdFor(kind, locale);

    const startedMeta = renderStore.update({
      id: renderId,
      status: "running",
      startedAt: Date.now(),
      outPath,
    });
    deps.broadcast?.("videoRender:updated", startedMeta);
    emitProgress(
      deps,
      { id: renderId, projectId, locale },
      { status: "running", message: composition },
    );

    // `npx --no-install`: o workspace tem node_modules PRÓPRIO (ABI isolado do
    // Electron) e o remotion tem que vir DE LÁ. Um `npx` que baixasse a versão
    // mais recente renderizaria com um motor diferente do que foi testado.
    const spawnImpl = deps.spawnImpl ?? spawn;
    const child = spawnImpl(
      "npx",
      [
        "--no-install",
        "remotion",
        "render",
        "src/index.ts",
        composition,
        outPath,
      ],
      { cwd: workspace, stdio: ["ignore", "pipe", "pipe"], env: spawnEnv() },
    );

    if (!child.stdout || !child.stderr) {
      finish(
        deps,
        renderId,
        projectId,
        locale,
        { status: "failed" },
        "spawn sem stdout/stderr",
      );
      return;
    }

    const outRl = createInterface({ input: child.stdout });
    const errRl = createInterface({ input: child.stderr });
    const timer = setTimeout(() => {
      renderStore.appendLog(
        renderId,
        `\n[pitwall] tempo esgotado (${RENDER_TIMEOUT_MS} ms)\n`,
      );
      child.kill("SIGKILL");
    }, RENDER_TIMEOUT_MS);
    const tracked: Tracked = { child, outRl, errRl, timer, cancelled: false };
    running.set(renderId, tracked);

    const onLine = (line: string): void => {
      renderStore.appendLog(renderId, `${line}\n`);
      const parsed = parseProgress(line);
      if (parsed) {
        emitProgress(
          deps,
          { id: renderId, projectId, locale },
          { status: "running", ...parsed, message: null },
        );
      }
    };
    outRl.on("line", onLine);
    // O Remotion escreve a barra de progresso no stderr; tratar stderr como
    // "só erro" perderia justamente o progresso.
    errRl.on("line", onLine);

    child.on("error", (err) => {
      renderStore.appendLog(
        renderId,
        `\n[pitwall] spawn error: ${err.message}\n`,
      );
    });

    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      outRl.close();
      errRl.close();
      running.delete(renderId);

      if (tracked.cancelled) {
        finish(
          deps,
          renderId,
          projectId,
          locale,
          { status: "failed" },
          "cancelado",
        );
        return;
      }
      if (code === 0) {
        let bytes: number | null = null;
        try {
          bytes = statSync(outPath).size;
        } catch {
          // arquivo sumiu entre o exit e o stat: o render vira falha abaixo
        }
        if (bytes === null || bytes === 0) {
          finish(
            deps,
            renderId,
            projectId,
            locale,
            { status: "failed" },
            "o Remotion saiu com 0 mas não deixou arquivo",
          );
          return;
        }
        finish(
          deps,
          renderId,
          projectId,
          locale,
          { status: "done", outPath, bytes },
          null,
        );
        return;
      }
      finish(
        deps,
        renderId,
        projectId,
        locale,
        { status: "failed" },
        `Remotion encerrou com código ${code ?? signal}`,
      );
    });
  } catch (err) {
    // Qualquer coisa antes/durante o spawn (contrato ilegível, cwd inexistente,
    // npx ausente) termina a row — nunca a deixa presa em 'running'.
    const message = err instanceof Error ? err.message : String(err);
    renderStore.appendLog(renderId, `\n[pitwall] ${message}\n`);
    finish(deps, renderId, projectId, locale, { status: "failed" }, message);
  }
}

// Cancelar é matar o processo; a transição pra 'failed' acontece no 'exit',
// pelo mesmo caminho de qualquer outra morte — dois lugares marcando o fim é
// como uma row acaba com status inconsistente.
export function cancelRender(
  renderId: string,
  deps: RenderDeps = {},
): VideoRenderMeta {
  const render = renderStore.get(renderId);
  if (!render) throw new Error(`video render not found: ${renderId}`);
  const tracked = running.get(renderId);
  if (!tracked) {
    // Já morreu (ou é órfão de um boot anterior): reconcilia aqui.
    if (render.status === "queued" || render.status === "running") {
      const meta = renderStore.update({
        id: renderId,
        status: "failed",
        finishedAt: Date.now(),
      });
      deps.broadcast?.("videoRender:updated", meta);
      return meta;
    }
    return render;
  }
  tracked.cancelled = true;
  tracked.child.kill("SIGTERM");
  return render;
}

export function isRendering(renderId: string): boolean {
  return running.has(renderId);
}

// Mata todo render vivo — chamado no shutdown do app, espelhando o killAll do
// pty-manager. Sem isto o processo do Remotion sobrevive ao app fechado.
export function killAll(): void {
  for (const [, tracked] of running) {
    tracked.cancelled = true;
    clearTimeout(tracked.timer);
    tracked.child.kill("SIGKILL");
  }
  running.clear();
}
