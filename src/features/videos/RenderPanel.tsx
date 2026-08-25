import { useMemo, useState } from "react";
import { Play, Square } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { useVideosStore } from "@/store/videosStore";
import {
  RENDER_STATUS_COLOR,
  RENDER_STATUS_LABEL,
  formatBytes,
  formatSeconds,
  relativeTime,
} from "./video-labels";
import type { VideoRenderMeta } from "../../../shared/types/ipc";

// O MP4 fica no disco (payload de mídia nunca trafega por IPC), então o preview
// aponta pro arquivo. Se o CSP do renderer barrar, o onError troca pelo aviso e
// o "Abrir no player" continua sendo o caminho garantido.
function fileUrl(path: string): string {
  return `file://${path.split("/").map(encodeURIComponent).join("/")}`;
}

export function RenderPanel() {
  const project = useVideosStore((s) => s.selected);
  const renders = useVideosStore((s) => s.renders);
  const progress = useVideosStore((s) => s.renderProgress);
  const loading = useVideosStore((s) => s.rendersLoading);
  const error = useVideosStore((s) => s.rendersError);
  const startRender = useVideosStore((s) => s.startRender);
  const cancelRender = useVideosStore((s) => s.cancelRender);
  const revealRender = useVideosStore((s) => s.revealRender);
  const loadRenders = useVideosStore((s) => s.loadRenders);

  const [previewBroken, setPreviewBroken] = useState<Record<string, boolean>>(
    {},
  );

  // Um card por locale, mostrando o render mais recente daquele locale.
  const latestByLocale = useMemo(() => {
    const map = new Map<string, VideoRenderMeta>();
    for (const r of renders) {
      const prev = map.get(r.locale);
      if (!prev || r.createdAt > prev.createdAt) map.set(r.locale, r);
    }
    return map;
  }, [renders]);

  if (!project) return null;

  if (error) {
    return (
      <div className="px-6 py-8">
        <p className="text-sm text-[var(--color-danger)]">{error}</p>
        <Button
          variant="ghost"
          className="mt-3"
          onClick={() => void loadRenders()}
        >
          Tentar de novo
        </Button>
      </div>
    );
  }

  if (loading && renders.length === 0) {
    return (
      <p className="px-6 py-8 text-sm text-[var(--color-text-dim)]">
        Carregando renders…
      </p>
    );
  }

  if (project.locales.length === 0) {
    return (
      <p className="px-6 py-8 text-sm text-[var(--color-text-dim)]">
        Esta peça não tem locale nenhum — sem locale não há o que renderizar.
      </p>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto px-6 py-4">
      <ul className="flex flex-col gap-3">
        {project.locales.map((locale) => {
          const render = latestByLocale.get(locale) ?? null;
          const live = render ? progress[render.id] : undefined;
          const status = live?.status ?? render?.status ?? null;
          const running = status === "running" || status === "queued";
          const pct =
            live?.progress !== null && live?.progress !== undefined
              ? Math.round(live.progress * 100)
              : null;
          return (
            <li
              key={locale}
              className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-3"
            >
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-baseline gap-2">
                  <span className="text-sm font-medium text-[var(--color-text)]">
                    {locale}
                  </span>
                  {status && (
                    <span
                      className="text-[11px]"
                      style={{ color: RENDER_STATUS_COLOR[status] }}
                    >
                      {RENDER_STATUS_LABEL[status]}
                    </span>
                  )}
                  {render && (
                    <span className="text-[11px] text-[var(--color-text-dim)]">
                      {relativeTime(render.createdAt)}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  {running && render ? (
                    <Button
                      variant="ghost"
                      onClick={() => void cancelRender(render.id)}
                    >
                      <Icon as={Square} size={13} />
                      Cancelar
                    </Button>
                  ) : (
                    <Button onClick={() => void startRender(locale)}>
                      <Icon as={Play} size={13} />
                      {render ? "Renderizar de novo" : "Renderizar"}
                    </Button>
                  )}
                  {render?.status === "done" && (
                    <Button
                      variant="ghost"
                      onClick={() => void revealRender(render.id)}
                    >
                      Abrir no player
                    </Button>
                  )}
                </div>
              </div>

              {running && (
                <div className="mt-3">
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--color-surface-2)]">
                    <div
                      className="h-full rounded-full transition-[width]"
                      style={{
                        width: pct === null ? "10%" : `${pct}%`,
                        background: "var(--gradient-brand)",
                      }}
                    />
                  </div>
                  <p className="mt-1 text-[11px] tabular-nums text-[var(--color-text-dim)]">
                    {pct === null ? "Preparando…" : `${pct}%`}
                    {live?.renderedFrames !== null &&
                    live?.renderedFrames !== undefined &&
                    live.totalFrames
                      ? ` · ${live.renderedFrames}/${live.totalFrames} frames`
                      : ""}
                    {live?.message ? ` · ${live.message}` : ""}
                  </p>
                </div>
              )}

              {render?.status === "failed" && (
                <p className="mt-2 text-xs text-[var(--color-danger)]">
                  {live?.message ??
                    "O render falhou. O log completo fica na row do render."}
                </p>
              )}

              {render?.status === "done" && render.outPath && (
                <div className="mt-3">
                  {previewBroken[render.id] ? (
                    <p className="text-xs text-[var(--color-text-dim)]">
                      Não foi possível pré-visualizar aqui — abra no player do
                      sistema.
                    </p>
                  ) : (
                    <video
                      src={fileUrl(render.outPath)}
                      controls
                      preload="metadata"
                      onError={() =>
                        setPreviewBroken((p) => ({ ...p, [render.id]: true }))
                      }
                      className="max-h-72 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)]"
                    />
                  )}
                  <p className="mt-1 flex flex-wrap gap-2 text-[11px] text-[var(--color-text-dim)]">
                    <span className="tabular-nums">
                      {render.durationSec === null
                        ? "—"
                        : formatSeconds(render.durationSec)}
                    </span>
                    <span className="tabular-nums">
                      {formatBytes(render.bytes)}
                    </span>
                    <span className="truncate font-mono" title={render.outPath}>
                      {render.outPath}
                    </span>
                  </p>
                </div>
              )}

              {!render && (
                <p className="mt-2 text-xs text-[var(--color-text-dim)]">
                  Nenhum render deste locale ainda.
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
