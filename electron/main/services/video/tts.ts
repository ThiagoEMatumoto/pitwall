import { existsSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { clearVoiceSecrets, resolveSecret } from "../voice-config";
import * as assetStore from "./asset-store";
import * as brandKitStore from "./brand-kit-store";
import * as projectStore from "./project-store";
import * as scriptStore from "./script-store";
import { probeDurationSec } from "./ffprobe";
import { audioRelPath, ensureDir, publicPathOf } from "./paths";
import type {
  GenerateVideoAudioInput,
  GenerateVideoAssetsResult,
  VideoAsset,
  VideoAssetJobEvent,
} from "../../../../shared/types/ipc";

// Narração via ElevenLabs — porte de `video/scripts/tts.mjs` pro main process.
//
// Três coisas vieram do motor e não podem se perder:
//
// 1. CREDENCIAL pelo mesmo caminho do app: `resolveSecret('VOZ_TTS_KEY')` de
//    voice-config, que aceita valor direto OU comando (*_KEY_CMD). Nesta
//    máquina a chave vem do cofre via comando — suporte a *_KEY_CMD não é
//    opcional.
// 2. IDEMPOTÊNCIA por sha256(text + voiceId + modelId) (script-store.audioHashOf).
//    Sem ela cada preview re-paga a API. O hash inclui voz e modelo de
//    propósito: trocar de voz precisa regerar sem que o roteiro tenha mudado.
// 3. DRY-RUN por default. `go !== true` não faz UMA chamada de rede: devolve o
//    plano com `costCents` = ESTIMATIVA e `generated` = 0. Quem gasta dinheiro
//    diz explicitamente que quer gastar.

const TTS_TIMEOUT_MS = 180_000;

// eleven_multilingual_v2 é o modelo do motor (video/content/script.json), não o
// do voz.env: lá o default é o flash, afinado pra latência de ditado. Narração
// de peça troca latência por qualidade.
const DEFAULT_MODEL_ID = "eleven_multilingual_v2";

// US$0,10 por 1k caracteres (atelier.config.yaml:tts.preco_por_1k_chars) → 10
// centavos por 1k. Guardado em centavos porque é o que a coluna cost_cents é.
const PRICE_CENTS_PER_1K_CHARS = 10;

export interface TtsDeps {
  broadcast?: (channel: string, payload: unknown) => void;
  fetchImpl?: typeof fetch;
}

interface PlanRow {
  sceneId: string;
  text: string;
  hash: string;
  absPath: string;
  existing: VideoAsset | null;
  cached: boolean;
}

function costCentsFor(chars: number): number {
  return Math.ceil((chars / 1000) * PRICE_CENTS_PER_1K_CHARS);
}

function modelId(): string {
  return process.env.PITWALL_VIDEO_TTS_MODEL?.trim() || DEFAULT_MODEL_ID;
}

function emit(deps: TtsDeps, event: VideoAssetJobEvent): void {
  deps.broadcast?.("videoAsset:job", event);
}

// Uma tentativa de síntese. Mesmo endpoint/headers de voice-tts.ts; só o
// model_id vem daqui em vez do voz.env.
async function request(
  fetchImpl: typeof fetch,
  key: string,
  text: string,
  voiceId: string,
  model: string,
): Promise<{ status: number; body: ArrayBuffer; pista: string }> {
  const url =
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream` +
    "?output_format=mp3_44100_128";
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: { "xi-api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify({ text, model_id: model }),
      signal: AbortSignal.timeout(TTS_TIMEOUT_MS),
    });
  } catch {
    return { status: 0, body: new ArrayBuffer(0), pista: "" };
  }
  if (res.status !== 200) {
    const pista = (await res.text().catch(() => "")).slice(0, 160);
    return { status: res.status, body: new ArrayBuffer(0), pista };
  }
  const buf = await res.arrayBuffer().catch(() => new ArrayBuffer(0));
  return { status: 200, body: buf, pista: "" };
}

function errorMessage(http: number, pista: string): string {
  if (http === 401 || http === 403) {
    return "a credencial de voz foi recusada — confira VOZ_TTS_KEY / VOZ_TTS_KEY_CMD no voz.env";
  }
  if (http === 0)
    return "não consegui chamar o serviço de voz (rede ou tempo esgotado)";
  return `o serviço de voz respondeu HTTP ${http}${pista ? ": " + pista : ""}`;
}

// 401/403 pode ser só o cache de secret velho: invalida e refaz UMA vez com
// secret fresco (mesma regra de voice-tts/voice-stt). Falhou de novo, é erro.
async function synthesize(
  fetchImpl: typeof fetch,
  key: string,
  text: string,
  voiceId: string,
  model: string,
): Promise<Buffer> {
  let attempt = await request(fetchImpl, key, text, voiceId, model);
  if (attempt.status === 401 || attempt.status === 403) {
    clearVoiceSecrets();
    const fresh = await resolveSecret("VOZ_TTS_KEY");
    if (fresh.ok && fresh.value !== key) {
      attempt = await request(fetchImpl, fresh.value, text, voiceId, model);
    }
  }
  if (attempt.status !== 200)
    throw new Error(errorMessage(attempt.status, attempt.pista));
  if (attempt.body.byteLength === 0) {
    throw new Error("o serviço de voz devolveu um arquivo vazio");
  }
  return Buffer.from(attempt.body);
}

// Monta o plano SEM tocar a rede: quais cenas já têm áudio válido (hash bate e
// o mp3 existe no disco) e quais precisam ser sintetizadas. O `existsSync` não
// é decorativo — o banco pode ter a linha e o arquivo ter sido apagado à mão,
// e aí o render quebraria no meio em vez de aqui.
export function buildPlan(
  input: GenerateVideoAudioInput,
  voiceId: string,
  model: string,
): PlanRow[] {
  const scenes = projectStore.listScenes(input.projectId);
  const wanted = input.sceneIds?.length ? new Set(input.sceneIds) : null;
  const rows: PlanRow[] = [];
  for (const scene of scenes) {
    if (wanted && !wanted.has(scene.sceneId)) continue;
    const text = scriptStore.narrationForScene(
      input.projectId,
      input.locale,
      scene.sceneId,
    );
    if (!text) continue; // cena sem narração neste locale: nada a sintetizar
    const hash = scriptStore.audioHashOf(text, voiceId, model);
    const existing = assetStore.findByHash(input.projectId, "audio", hash);
    const absPath = publicPathOf(audioRelPath(input.locale, scene.sceneId));
    rows.push({
      sceneId: scene.sceneId,
      text,
      hash,
      absPath,
      existing,
      cached: Boolean(existing && !input.force && existsSync(existing.path)),
    });
  }
  return rows;
}

export async function generateAudio(
  input: GenerateVideoAudioInput,
  deps: TtsDeps = {},
): Promise<GenerateVideoAssetsResult> {
  const project = projectStore.get(input.projectId);
  if (!project) throw new Error(`video project not found: ${input.projectId}`);

  const voiceId =
    input.voiceId?.trim() ||
    brandKitStore.voiceForLocale(project.brandKitId, input.locale);
  if (!voiceId) {
    throw new Error(
      `sem voz para o locale ${input.locale} — passe voiceId ou configure ttsVoices no brand kit da peça`,
    );
  }
  const model = modelId();
  const plan = buildPlan(input, voiceId, model);

  const reusedAssets = plan.filter((r) => r.cached).map((r) => r.existing!);
  const pending = plan.filter((r) => !r.cached);
  const estimateCents = costCentsFor(
    pending.reduce((sum, r) => sum + r.text.length, 0),
  );

  // DRY-RUN: nem a credencial é resolvida (buscar no cofre custa ~1s e uma ida
  // à rede). `costCents` aqui é o que SERIA gasto.
  if (input.go !== true) {
    return {
      assets: reusedAssets,
      generated: 0,
      reused: reusedAssets.length,
      failed: 0,
      costCents: estimateCents,
    };
  }

  const key = await resolveSecret("VOZ_TTS_KEY");
  if (!key.ok) throw new Error(key.error);

  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const assets: VideoAsset[] = [...reusedAssets];
  let generated = 0;
  let failed = 0;
  let costCents = 0;

  for (const row of reusedAssets) {
    emit(deps, {
      projectId: input.projectId,
      kind: "audio",
      sceneId: row.sceneId,
      locale: input.locale,
      status: "reused",
      assetId: row.id,
      error: null,
    });
  }

  // Sequencial de propósito: o ElevenLabs cobra por caractere e limita
  // concorrência por plano; paralelizar aqui trocaria 20s de espera por um 429
  // no meio de um lote já parcialmente pago.
  for (const row of plan) {
    if (row.cached) continue;
    emit(deps, {
      projectId: input.projectId,
      kind: "audio",
      sceneId: row.sceneId,
      locale: input.locale,
      status: "started",
      assetId: null,
      error: null,
    });
    try {
      const bytes = await synthesize(
        fetchImpl,
        key.value,
        row.text,
        voiceId,
        model,
      );
      ensureDir(dirname(row.absPath));
      writeFileSync(row.absPath, bytes);
      const durationSec = await probeDurationSec(row.absPath);
      const cents = costCentsFor(row.text.length);
      // O asset velho da MESMA cena (hash diferente: o texto ou a voz mudou)
      // sai do banco, senão a cena teria dois áudios e o manifesto escolheria
      // um por sorte. O arquivo no disco é o mesmo caminho, já sobrescrito.
      for (const stale of assetStore.list({
        projectId: input.projectId,
        sceneId: row.sceneId,
        kind: "audio",
        locale: input.locale,
      })) {
        if (stale.hash !== row.hash) assetStore.remove(stale.id);
      }
      const { asset } = assetStore.registerOrReuse({
        projectId: input.projectId,
        sceneId: row.sceneId,
        kind: "audio",
        locale: input.locale,
        path: row.absPath,
        hash: row.hash,
        provider: "elevenlabs",
        model,
        prompt: row.text,
        costCents: cents,
        bytes: bytes.length,
        durationSec,
      });
      assets.push(asset);
      generated += 1;
      costCents += cents;
      deps.broadcast?.("videoAsset:updated", asset);
      emit(deps, {
        projectId: input.projectId,
        kind: "audio",
        sceneId: row.sceneId,
        locale: input.locale,
        status: "done",
        assetId: asset.id,
        error: null,
      });
    } catch (err) {
      // Uma cena que falha não aborta o lote: o que já foi pago fica gravado e
      // a próxima rodada reusa pelo hash em vez de re-pagar tudo.
      failed += 1;
      emit(deps, {
        projectId: input.projectId,
        kind: "audio",
        sceneId: row.sceneId,
        locale: input.locale,
        status: "failed",
        assetId: null,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { assets, generated, reused: reusedAssets.length, failed, costCents };
}

// Bytes do arquivo, ou null se sumiu do disco. Usado pelo manifesto pra não
// anunciar ao motor um áudio que não existe mais.
export function fileBytes(absPath: string): number | null {
  try {
    return statSync(absPath).size;
  } catch {
    return null;
  }
}
