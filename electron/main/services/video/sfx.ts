import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { promisify } from "node:util";
import { dirname } from "node:path";
import * as assetStore from "./asset-store";
import { ensureDir, publicPathOf, sfxRelPath } from "./paths";
import type { VideoAsset } from "../../../../shared/types/ipc";

const execFileAsync = promisify(execFile);

// SFX sintetizados com ffmpeg puro — porte de `video/scripts/sfx.mjs`. Nenhum
// sample baixado, nenhuma licença a rastrear, e o resultado é DETERMINÍSTICO:
// por isso o arquivo pode ficar fora do git e o hash de idempotência é a
// própria receita (fonte + filtros), não o conteúdo.
//
// A regra de gosto: curto (<1,2s) e discreto. O SFX pontua o corte, não compete
// com a narração — todos saem bem abaixo de 0 dBFS.
//
// GOTCHA medido neste ffmpeg (8.0.1): a fonte `sine` NÃO sai em fundo de escala
// — ela entrega ~-18 dBFS, então um `volume=` calculado em cima dela erra por
// 18 dB, e erra em SILÊNCIO (nenhum aviso, só um SFX inaudível). `aevalsrc`
// respeita a amplitude escrita na expressão, então todas as fontes tonais aqui
// usam aevalsrc e o pico final é previsível.

const RATE = 48_000;

export interface SfxRecipe {
  name: string;
  why: string;
  source: string;
  filter: string[];
}

export const SFX: SfxRecipe[] = [
  {
    name: "whoosh",
    why: "transição entre cenas — ruído branco filtrado, entra rápido e sai longo",
    source: `anoisesrc=color=white:amplitude=0.6:duration=0.9:sample_rate=${RATE}`,
    filter: [
      "highpass=f=700",
      "lowpass=f=6500",
      "afade=t=in:st=0:d=0.3:curve=exp",
      "afade=t=out:st=0.3:d=0.6:curve=exp",
      "volume=0.30",
    ],
  },
  {
    name: "tick",
    why: "aparição de texto/chip — clique seco, sem cauda",
    source: `anoisesrc=color=white:amplitude=0.8:duration=0.05:sample_rate=${RATE}`,
    filter: [
      "highpass=f=1800",
      "lowpass=f=5200",
      "afade=t=out:st=0:d=0.05:curve=exp",
      "volume=0.35",
    ],
  },
  {
    name: "sub-hit",
    // Queda de 70 Hz para ~49 Hz (f(t) = 70 - 30*t): o glide descendente é o
    // que faz o grave ler como impacto em vez de nota.
    why: "corte seco / impacto do logo — grave com glide descendente e decaimento rápido",
    source: `aevalsrc=0.9*sin(2*PI*(70*t-15*t*t)):duration=0.7:sample_rate=${RATE}`,
    filter: [
      "lowpass=f=170",
      "afade=t=in:st=0:d=0.008",
      "afade=t=out:st=0.04:d=0.66:curve=exp",
      "volume=0.28",
    ],
  },
  {
    name: "riser",
    // sine não varre frequência; aevalsrc com fase quadrática dá o chirp
    // 210 Hz -> ~1000 Hz em 1.1s (f(t) = 210 + 720*t).
    why: "tensão antes do corte do cold-open — chirp linear ascendente",
    source: `aevalsrc=0.5*sin(2*PI*(210*t+360*t*t)):duration=1.1:sample_rate=${RATE}`,
    filter: [
      "highpass=f=150",
      "afade=t=in:st=0:d=0.85:curve=exp",
      "afade=t=out:st=1.0:d=0.1",
      "volume=0.22",
    ],
  },
];

export interface SfxDeps {
  broadcast?: (channel: string, payload: unknown) => void;
  run?: (args: string[]) => Promise<void>;
}

async function runFfmpeg(args: string[]): Promise<void> {
  await execFileAsync("ffmpeg", args);
}

// Nome + receita: mudou o filtro, muda o hash e o SFX é regerado. É a mesma
// ideia da idempotência do TTS, só que a "entrada" é a receita e não o texto.
export function recipeHashOf(recipe: SfxRecipe): string {
  return `${recipe.source}|${recipe.filter.join(",")}`;
}

// Gera os SFX que faltam e registra cada um como asset COMPARTILHADO
// (projectId null): a biblioteca de SFX é da marca, não de uma peça — apagar a
// peça não pode levar o whoosh embora.
export async function generateSfx(
  opts: { force?: boolean } = {},
  deps: SfxDeps = {},
): Promise<{ assets: VideoAsset[]; generated: number; reused: number }> {
  const run = deps.run ?? runFfmpeg;
  const assets: VideoAsset[] = [];
  let generated = 0;
  let reused = 0;

  for (const recipe of SFX) {
    const rel = sfxRelPath(recipe.name);
    const absPath = publicPathOf(rel);
    const hash = recipeHashOf(recipe);
    const existing = assetStore.findByHash(null, "sfx", hash);

    if (existing && !opts.force && existsSync(absPath)) {
      assets.push(existing);
      reused += 1;
      continue;
    }

    ensureDir(dirname(absPath));
    await run([
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      recipe.source,
      "-filter:a",
      recipe.filter.join(","),
      "-ac",
      "1",
      "-ar",
      String(RATE),
      "-c:a",
      "pcm_s16le",
      absPath,
    ]);

    const { asset } = assetStore.registerOrReuse({
      projectId: null,
      kind: "sfx",
      path: absPath,
      hash,
      provider: "ffmpeg",
      model: null,
      // O "prompt" de um SFX é a receita: é ela que o reproduz.
      prompt: `${recipe.why} :: ${recipe.source} :: ${recipe.filter.join(",")}`,
      costCents: 0,
      bytes: existsSync(absPath) ? statSync(absPath).size : null,
    });
    assets.push(asset);
    generated += 1;
    deps.broadcast?.("videoAsset:updated", asset);
  }

  return { assets, generated, reused };
}
