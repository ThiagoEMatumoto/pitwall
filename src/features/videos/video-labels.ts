import type {
  VideoAssetKind,
  VideoProjectStatus,
  VideoRenderStatus,
  VideoScriptLineKind,
} from "../../../shared/types/ipc";

// Etapa da esteira. Arquivar é ortogonal (archivedAt) e vira badge próprio.
export const PROJECT_STATUS_LABEL: Record<VideoProjectStatus, string> = {
  draft: "Rascunho",
  scripting: "Roteiro",
  assets: "Assets",
  rendering: "Renderizando",
  done: "Pronta",
};

export const PROJECT_STATUS_COLOR: Record<VideoProjectStatus, string> = {
  draft: "var(--color-text-dim)",
  scripting: "var(--color-info)",
  assets: "var(--color-accent)",
  rendering: "var(--color-warning)",
  done: "var(--color-success)",
};

export const RENDER_STATUS_LABEL: Record<VideoRenderStatus, string> = {
  queued: "Na fila",
  running: "Renderizando",
  done: "Pronto",
  failed: "Falhou",
};

export const RENDER_STATUS_COLOR: Record<VideoRenderStatus, string> = {
  queued: "var(--color-text-dim)",
  running: "var(--color-warning)",
  done: "var(--color-success)",
  failed: "var(--color-danger)",
};

export const ASSET_KIND_LABEL: Record<VideoAssetKind, string> = {
  audio: "Narração",
  texture: "Textura",
  keyvisual: "Key visual",
  character: "Personagem",
  sfx: "SFX",
  music: "Trilha",
};

export const SCRIPT_KIND_LABEL: Record<VideoScriptLineKind, string> = {
  narration: "Narração",
  on_screen: "Tela",
};

// Categoria de template/peça é coluna ABERTA no banco: um kind novo não exige
// migration, então aqui só traduzimos os conhecidos e caímos num Título bonito.
const KNOWN_KIND_LABEL: Record<string, string> = {
  promo: "Promo",
  "character-story": "História de personagem",
  explainer: "Explicativo",
  teaser: "Teaser",
  demo: "Demo",
};

export function kindLabel(kind: string): string {
  const known = KNOWN_KIND_LABEL[kind];
  if (known) return known;
  const words = kind.replace(/[-_]+/g, " ").trim();
  if (!words) return "Sem categoria";
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function slugify(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

// Provedores da área (ElevenLabs, Gemini) cobram em USD — costCents é centavo
// de dólar. Mostramos com 2 casas mesmo em valores pequenos: o ponto do painel
// é o acumulado ficar visível ANTES de gerar mais.
export function formatCents(cents: number): string {
  return `US$ ${(cents / 100).toLocaleString("pt-BR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function formatSeconds(sec: number): string {
  const total = Math.max(0, Math.round(sec));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m}:${String(s).padStart(2, "0")}` : `${s}s`;
}

export function formatBytes(bytes: number | null): string {
  if (bytes === null) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(0)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

// Estimativa de locução em pt-BR a ~155 palavras/min (2,6 p/s). É palpite de
// ROTEIRO — quando o áudio já existe, o durationSec do asset manda.
const WORDS_PER_SEC = 2.6;

export function estimateSpeechSec(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  if (words === 0) return 0;
  return words / WORDS_PER_SEC;
}

export function relativeTime(ts: number, now = Date.now()): string {
  const diff = now - ts;
  const min = Math.floor(diff / 60_000);
  if (min < 1) return "agora";
  if (min < 60) return `há ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `há ${h} h`;
  const d = Math.floor(h / 24);
  if (d === 1) return "ontem";
  if (d < 7) return `há ${d} dias`;
  return new Date(ts).toLocaleDateString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
  });
}
