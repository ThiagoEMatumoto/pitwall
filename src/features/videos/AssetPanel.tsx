import { useMemo, useState } from "react";
import { FolderOpen, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { shellApi } from "@/lib/ipc";
import { useVideosStore } from "@/store/videosStore";
import {
  ASSET_KIND_LABEL,
  formatBytes,
  formatCents,
  formatSeconds,
  relativeTime,
} from "./video-labels";
import type { VideoAssetKind } from "../../../shared/types/ipc";

const JOB_STATUS_LABEL: Record<string, string> = {
  started: "gerando",
  reused: "reusado (não pagou)",
  done: "pronto",
  failed: "falhou",
};

export function AssetPanel() {
  const project = useVideosStore((s) => s.selected);
  const locale = useVideosStore((s) => s.locale);
  const assets = useVideosStore((s) => s.assets);
  const loading = useVideosStore((s) => s.assetsLoading);
  const error = useVideosStore((s) => s.assetsError);
  const job = useVideosStore((s) => s.assetJob);
  const generating = useVideosStore((s) => s.generating);
  const generateAudio = useVideosStore((s) => s.generateAudio);
  const loadAssets = useVideosStore((s) => s.loadAssets);

  const [force, setForce] = useState(false);

  const totalCents = useMemo(
    () => assets.reduce((a, x) => a + x.costCents, 0),
    [assets],
  );

  const byKind = useMemo(() => {
    const map = new Map<VideoAssetKind, { count: number; cents: number }>();
    for (const a of assets) {
      const cur = map.get(a.kind) ?? { count: 0, cents: 0 };
      map.set(a.kind, { count: cur.count + 1, cents: cur.cents + a.costCents });
    }
    return [...map.entries()].sort((a, b) => b[1].cents - a[1].cents);
  }, [assets]);

  if (!project) return null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* O acumulado fica no topo de propósito: a decisão de gerar mais é
          tomada olhando pro que já foi gasto, não depois da fatura. */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--color-border)] px-6 py-3">
        <div className="flex items-baseline gap-3">
          <span className="text-xs text-[var(--color-text-dim)]">
            Custo acumulado
          </span>
          <span className="text-lg font-semibold tabular-nums text-[var(--color-text)]">
            {formatCents(totalCents)}
          </span>
          <span className="text-xs text-[var(--color-text-dim)]">
            · {assets.length} asset{assets.length === 1 ? "" : "s"}
          </span>
        </div>
        <div className="flex items-center gap-3">
          <label
            className="flex cursor-pointer items-center gap-1.5 text-[11px] text-[var(--color-text-dim)]"
            title="Ignora o hash e re-paga a API (use quando trocar a voz)"
          >
            <input
              type="checkbox"
              checked={force}
              onChange={(e) => setForce(e.target.checked)}
              className="accent-[var(--color-accent)]"
            />
            Forçar regeração
          </label>
          <Button
            onClick={() =>
              locale &&
              void generateAudio({
                projectId: project.id,
                locale,
                force: force || undefined,
              })
            }
            disabled={!locale}
            loading={generating}
          >
            <Icon as={Sparkles} size={14} />
            Gerar narração{locale ? ` (${locale})` : ""}
          </Button>
        </div>
      </div>

      {byKind.length > 0 && (
        <div className="flex flex-wrap gap-2 border-b border-[var(--color-border)] px-6 py-2">
          {byKind.map(([kind, agg]) => (
            <span
              key={kind}
              className="rounded-full border border-[var(--color-border)] px-2 py-px text-[11px] text-[var(--color-text-dim)]"
            >
              {ASSET_KIND_LABEL[kind]} · {agg.count} ·{" "}
              <span className="tabular-nums">{formatCents(agg.cents)}</span>
            </span>
          ))}
        </div>
      )}

      {job && (
        <p className="border-b border-[var(--color-border)] px-6 py-2 text-xs text-[var(--color-text-dim)]">
          {ASSET_KIND_LABEL[job.kind]}
          {job.sceneId ? ` · ${job.sceneId}` : ""}
          {job.locale ? ` · ${job.locale}` : ""} —{" "}
          <span
            style={{
              color:
                job.status === "failed"
                  ? "var(--color-danger)"
                  : job.status === "reused"
                    ? "var(--color-success)"
                    : "var(--color-text)",
            }}
          >
            {JOB_STATUS_LABEL[job.status] ?? job.status}
          </span>
          {job.error ? ` · ${job.error}` : ""}
        </p>
      )}

      <div className="flex-1 overflow-y-auto px-6 py-4">
        {error ? (
          <div>
            <p className="text-sm text-[var(--color-danger)]">{error}</p>
            <Button
              variant="ghost"
              className="mt-3"
              onClick={() => void loadAssets()}
            >
              Tentar de novo
            </Button>
          </div>
        ) : loading && assets.length === 0 ? (
          <p className="text-sm text-[var(--color-text-dim)]">
            Carregando assets…
          </p>
        ) : assets.length === 0 ? (
          <p className="max-w-xl text-sm text-[var(--color-text-dim)]">
            Nenhum asset ainda. A narração sai do roteiro salvo — e é
            idempotente por hash: cena cujo áudio já está em dia não é re-paga.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[46rem] border-collapse text-sm">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wide text-[var(--color-text-dim)]">
                  <th className="py-1.5 pr-3 font-medium">Tipo</th>
                  <th className="py-1.5 pr-3 font-medium">Cena</th>
                  <th className="py-1.5 pr-3 font-medium">Locale</th>
                  <th className="py-1.5 pr-3 font-medium">Origem</th>
                  <th className="py-1.5 pr-3 text-right font-medium">Dur.</th>
                  <th className="py-1.5 pr-3 text-right font-medium">Tam.</th>
                  <th className="py-1.5 pr-3 text-right font-medium">Custo</th>
                  <th className="py-1.5 pr-3 text-right font-medium">Quando</th>
                  <th className="py-1.5" />
                </tr>
              </thead>
              <tbody>
                {assets.map((a) => (
                  <tr
                    key={a.id}
                    className="border-t border-[var(--color-border)] align-top"
                  >
                    <td className="py-1.5 pr-3 text-[var(--color-text)]">
                      {ASSET_KIND_LABEL[a.kind]}
                    </td>
                    <td className="py-1.5 pr-3 font-mono text-xs text-[var(--color-text-dim)]">
                      {a.sceneId ?? "—"}
                    </td>
                    <td className="py-1.5 pr-3 text-xs text-[var(--color-text-dim)]">
                      {a.locale ?? "—"}
                    </td>
                    <td
                      className="max-w-[16rem] truncate py-1.5 pr-3 text-xs text-[var(--color-text-dim)]"
                      title={a.prompt ?? undefined}
                    >
                      {[a.provider, a.model].filter(Boolean).join(" · ") || "—"}
                      {a.refIds.length > 0 && (
                        <span
                          className="ml-1 text-[var(--color-accent)]"
                          title="Assets passados como referência na geração"
                        >
                          +{a.refIds.length} ref
                        </span>
                      )}
                    </td>
                    <td className="py-1.5 pr-3 text-right tabular-nums text-xs text-[var(--color-text-dim)]">
                      {a.durationSec === null
                        ? "—"
                        : formatSeconds(a.durationSec)}
                    </td>
                    <td className="py-1.5 pr-3 text-right tabular-nums text-xs text-[var(--color-text-dim)]">
                      {formatBytes(a.bytes)}
                    </td>
                    <td className="py-1.5 pr-3 text-right tabular-nums text-xs text-[var(--color-text)]">
                      {formatCents(a.costCents)}
                    </td>
                    <td className="py-1.5 pr-3 text-right text-xs text-[var(--color-text-dim)]">
                      {relativeTime(a.createdAt)}
                    </td>
                    <td className="py-1.5 text-right">
                      <button
                        type="button"
                        title={a.path}
                        onClick={() => void shellApi.openPath(a.path)}
                        className="text-[var(--color-text-dim)] transition hover:text-[var(--color-text)]"
                      >
                        <Icon as={FolderOpen} size={14} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
