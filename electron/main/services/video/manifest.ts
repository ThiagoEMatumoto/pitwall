import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as assetStore from "./asset-store";
import * as brandKitStore from "./brand-kit-store";
import * as projectStore from "./project-store";
import * as scriptStore from "./script-store";
import { probeDurationSec, round3 } from "./ffprobe";
import {
  audioRelPath,
  ensureDir,
  publicPathOf,
  videoContentDir,
} from "./paths";

// Gera os dois arquivos de contrato que o motor Remotion consome:
// `content/script.json` (o roteiro) e `content/audio-manifest.json` (o
// timeline). São a MESMA forma que o motor já lê hoje — o banco virou a fonte,
// o formato não mudou.
//
// A duração vem do ffprobe, não do roteiro: `targetSec` é intenção, e um
// timeline montado com a intenção sai fora de sincronia com a narração real.
// Cena sem mp3 no disco é PENDENTE: `file` e `textHash` nulos e a duração cai
// no alvo do roteiro — é o que faz a próxima rodada de TTS gerá-la.

const FPS = 30;

// Respiro antes e depois da narração, em segundos. Preservados entre execuções
// quando já ajustados à mão num manifesto real (mesma regra de tts.mjs).
const PAD_START_SEC = 0.25;
const PAD_END_SEC = 0.6;

export interface ManifestScene {
  id: string;
  textHash: string | null;
  voiceId: string | null;
  modelId: string | null;
  file: string | null;
  durationSec: number;
  padStartSec: number;
  padEndSec: number;
}

export interface AudioManifest {
  version: 1;
  fps: number;
  locales: Record<string, { scenes: ManifestScene[] }>;
}

export interface ScriptScene {
  id: string;
  role: string;
  targetSec: number;
  visual: string;
  narration: Record<string, string>;
  onScreen: Record<string, string[]>;
}

export interface ScriptFile {
  version: 1;
  fps: number;
  kind: string;
  locales: string[];
  brand: { theme: string | null; display: string | null; mono: string | null };
  tts: { modelId: string; voices: Record<string, { voiceId: string }> };
  scenes: ScriptScene[];
}

export function manifestPath(): string {
  return join(videoContentDir(), "audio-manifest.json");
}

export function scriptPath(): string {
  return join(videoContentDir(), "script.json");
}

// Pads da execução anterior, indexados por `${locale}/${sceneId}`. Um manifesto
// ilegível vira mapa vazio em vez de derrubar a geração.
function previousPads(): Map<
  string,
  { padStartSec: number; padEndSec: number }
> {
  const out = new Map<string, { padStartSec: number; padEndSec: number }>();
  const path = manifestPath();
  if (!existsSync(path)) return out;
  try {
    const prev = JSON.parse(
      readFileSync(path, "utf8"),
    ) as Partial<AudioManifest>;
    for (const [locale, entry] of Object.entries(prev.locales ?? {})) {
      for (const scene of entry.scenes ?? []) {
        out.set(`${locale}/${scene.id}`, {
          padStartSec: scene.padStartSec ?? PAD_START_SEC,
          padEndSec: scene.padEndSec ?? PAD_END_SEC,
        });
      }
    }
  } catch {
    // manifesto corrompido: cai nos pads default
  }
  return out;
}

export async function buildManifest(projectId: string): Promise<AudioManifest> {
  const project = projectStore.get(projectId);
  if (!project) throw new Error(`video project not found: ${projectId}`);

  const pads = previousPads();
  const locales: AudioManifest["locales"] = {};

  // TODOS os locales da peça entram sempre — gerar áudio só de um locale não
  // pode apagar do manifesto as cenas do outro.
  for (const locale of project.locales) {
    // DÍVIDA CONHECIDA: `video_assets` não tem coluna pra voz, então o voiceId
    // do manifesto vem da mesma fonte que o TTS usa por default (o brand kit).
    // Um `voiceId` passado ad-hoc em generateAudio gera o áudio certo mas não
    // fica registrado — o manifesto anunciaria a voz da marca. Resolver exige
    // uma coluna nova; até lá, gerar com voz avulsa é caminho de exceção.
    const voiceId = brandKitStore.voiceForLocale(project.brandKitId, locale);
    const scenes: ManifestScene[] = [];
    for (const scene of project.scenes) {
      const rel = audioRelPath(locale, scene.sceneId);
      const absPath = publicPathOf(rel);
      // O `existsSync` não é decorativo: a linha pode existir no banco e o mp3
      // ter sido apagado à mão, e aí o render quebraria no meio.
      const asset = assetStore
        .list({ projectId, sceneId: scene.sceneId, kind: "audio", locale })
        .find((a) => existsSync(a.path));
      const onDisk = Boolean(asset) && existsSync(absPath);
      const durationSec = onDisk
        ? ((await probeDurationSec(absPath)) ?? scene.targetSec)
        : scene.targetSec;
      const pad = pads.get(`${locale}/${scene.sceneId}`);
      scenes.push({
        id: scene.sceneId,
        textHash: onDisk ? (asset?.hash ?? null) : null,
        voiceId: onDisk ? voiceId : null,
        modelId: onDisk ? (asset?.model ?? null) : null,
        file: onDisk ? rel : null,
        durationSec: round3(durationSec),
        padStartSec: pad?.padStartSec ?? PAD_START_SEC,
        padEndSec: pad?.padEndSec ?? PAD_END_SEC,
      });
    }
    locales[locale] = { scenes };
  }

  return { version: 1, fps: FPS, locales };
}

export function buildScript(projectId: string): ScriptFile {
  const project = projectStore.get(projectId);
  if (!project) throw new Error(`video project not found: ${projectId}`);
  const kit = project.brandKitId ? brandKitStore.get(project.brandKitId) : null;

  const scenes: ScriptScene[] = project.scenes.map((scene) => {
    const narration: Record<string, string> = {};
    const onScreen: Record<string, string[]> = {};
    for (const locale of project.locales) {
      narration[locale] = scriptStore.narrationForScene(
        projectId,
        locale,
        scene.sceneId,
      );
      onScreen[locale] = scriptStore
        .list(projectId, locale)
        .filter((l) => l.sceneId === scene.sceneId && l.kind === "on_screen")
        .map((l) => l.text);
    }
    return {
      id: scene.sceneId,
      role: scene.role,
      targetSec: scene.targetSec,
      visual: scene.visual,
      narration,
      onScreen,
    };
  });

  const voices: Record<string, { voiceId: string }> = {};
  for (const locale of project.locales) {
    const voiceId = kit?.ttsVoices[locale];
    if (voiceId) voices[locale] = { voiceId };
  }

  return {
    version: 1,
    fps: FPS,
    kind: project.kind,
    locales: project.locales,
    brand: {
      theme: project.themePreset,
      display: kit?.tokens.typography.display ?? null,
      mono: kit?.tokens.typography.mono ?? null,
    },
    tts: {
      modelId:
        process.env.PITWALL_VIDEO_TTS_MODEL?.trim() || "eleven_multilingual_v2",
      voices,
    },
    scenes,
  };
}

// Escreve os dois arquivos. Chamado antes de todo render: o motor lê do disco,
// então um render de roteiro velho seria um vídeo silenciosamente errado.
export async function writeContract(projectId: string): Promise<{
  manifestPath: string;
  scriptPath: string;
}> {
  ensureDir(videoContentDir());
  const manifest = await buildManifest(projectId);
  const script = buildScript(projectId);
  const mp = manifestPath();
  const sp = scriptPath();
  writeFileSync(mp, `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(sp, `${JSON.stringify(script, null, 2)}\n`);
  return { manifestPath: mp, scriptPath: sp };
}
