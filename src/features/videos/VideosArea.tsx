import { useEffect, useMemo, useState } from "react";
import { Clapperboard, Plus } from "lucide-react";
import { Icon } from "@/components/ui/Icon";
import { activeMarker } from "@/features/brand";
import { useVideosStore } from "@/store/videosStore";
import {
  PROJECT_STATUS_COLOR,
  PROJECT_STATUS_LABEL,
  kindLabel,
  relativeTime,
} from "./video-labels";
import { NewProjectDialog } from "./NewProjectDialog";
import { ScriptEditor } from "./ScriptEditor";
import { CastPanel } from "./CastPanel";
import { BrandKitPanel } from "./BrandKitPanel";
import { AssetPanel } from "./AssetPanel";
import { RenderPanel } from "./RenderPanel";
import type { VideoProjectMeta } from "../../../shared/types/ipc";

type Tab = "script" | "cast" | "brand" | "assets" | "renders";

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "script", label: "Roteiro" },
  { id: "cast", label: "Elenco" },
  { id: "brand", label: "Marca" },
  { id: "assets", label: "Assets" },
  { id: "renders", label: "Renders" },
];

export function VideosArea() {
  const projects = useVideosStore((s) => s.projects);
  const selected = useVideosStore((s) => s.selected);
  const locale = useVideosStore((s) => s.locale);
  const showArchived = useVideosStore((s) => s.showArchived);
  const loading = useVideosStore((s) => s.loading);
  const error = useVideosStore((s) => s.error);
  const load = useVideosStore((s) => s.load);
  const loadLibrary = useVideosStore((s) => s.loadLibrary);
  const select = useVideosStore((s) => s.select);
  const setLocale = useVideosStore((s) => s.setLocale);
  const setShowArchived = useVideosStore((s) => s.setShowArchived);
  const startWatch = useVideosStore((s) => s.startWatch);
  const stopWatch = useVideosStore((s) => s.stopWatch);

  const [tab, setTab] = useState<Tab>("script");
  const [dialogOpen, setDialogOpen] = useState(false);

  useEffect(() => {
    void load();
    void loadLibrary();
    startWatch();
    return () => stopWatch();
  }, [load, loadLibrary, startWatch, stopWatch]);

  // A lista é agrupada por categoria porque é assim que a peça é pensada: ela
  // pertence a uma categoria antes de pertencer a uma marca ou a um prazo.
  const groups = useMemo(() => {
    const byKind = new Map<string, VideoProjectMeta[]>();
    for (const p of projects) {
      const list = byKind.get(p.kind) ?? [];
      list.push(p);
      byKind.set(p.kind, list);
    }
    return [...byKind.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [projects]);

  return (
    <>
      <aside className="flex w-72 shrink-0 flex-col border-r border-[var(--color-border)] bg-[var(--color-surface)]">
        <div className="flex items-center justify-between border-b border-[var(--color-border)] px-4 py-3">
          <span className="text-sm font-semibold text-[var(--color-text)]">
            Vídeos
          </span>
          <button
            type="button"
            onClick={() => setDialogOpen(true)}
            title="Nova peça"
            className="flex h-6 w-6 items-center justify-center rounded-md text-[var(--color-text-dim)] transition hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text)]"
          >
            <Icon as={Plus} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {error ? (
            <p className="px-4 py-6 text-sm text-[var(--color-danger)]">
              {error}
            </p>
          ) : loading && projects.length === 0 ? (
            <p className="px-4 py-6 text-sm text-[var(--color-text-dim)]">
              Carregando…
            </p>
          ) : projects.length === 0 ? (
            <p className="px-4 py-6 text-sm text-[var(--color-text-dim)]">
              Nenhuma peça ainda. Toda peça nasce de um template — comece pelo
              “+” acima.
            </p>
          ) : (
            groups.map(([kind, list]) => (
              <div key={kind}>
                <p className="sticky top-0 z-10 bg-[var(--color-surface-2)] px-4 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-[var(--color-text-dim)]">
                  {kindLabel(kind)}
                </p>
                <ul>
                  {list.map((p) => {
                    const active = p.id === selected?.id;
                    return (
                      <li key={p.id}>
                        <button
                          type="button"
                          onClick={() => void select(p.id)}
                          className={`flex w-full flex-col gap-1 border-b border-[var(--color-border)] px-4 py-3 text-left transition ${
                            active
                              ? `bg-[var(--color-surface-2)] ${activeMarker}`
                              : "hover:bg-[var(--color-surface-2)]/60"
                          }`}
                        >
                          <span className="truncate text-sm font-medium text-[var(--color-text)]">
                            {p.title}
                          </span>
                          <span className="flex items-center gap-1.5 text-[11px] text-[var(--color-text-dim)]">
                            <span
                              style={{ color: PROJECT_STATUS_COLOR[p.status] }}
                            >
                              {PROJECT_STATUS_LABEL[p.status]}
                            </span>
                            {p.archivedAt !== null && (
                              <span className="rounded-full border border-[var(--color-border)] px-1.5 py-px">
                                Arquivada
                              </span>
                            )}
                            <span>{p.locales.join(" · ")}</span>
                            <span className="tabular-nums">
                              {relativeTime(p.updatedAt)}
                            </span>
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))
          )}
        </div>

        <label className="flex cursor-pointer items-center gap-2 border-t border-[var(--color-border)] px-4 py-2.5 text-xs text-[var(--color-text-dim)]">
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(e) => void setShowArchived(e.target.checked)}
            className="accent-[var(--color-accent)]"
          />
          Mostrar arquivadas
        </label>
      </aside>

      <main className="flex flex-1 flex-col overflow-hidden">
        {!selected ? (
          <div className="flex flex-1 items-center justify-center px-6 text-sm text-[var(--color-text-dim)]">
            <div className="flex max-w-md flex-col items-center gap-3 text-center">
              <Icon as={Clapperboard} size={32} />
              <p className="text-[var(--color-text)]">
                Uma peça nunca começa do zero.
              </p>
              <p>
                Ela nasce de um <strong>template</strong> de uma categoria e já
                chega com estilo (brand kit), elenco de personagens e o
                blueprint de cenas. O roteiro é por locale; os assets guardam o
                prompt que os gerou.
              </p>
              <button
                type="button"
                onClick={() => setDialogOpen(true)}
                className="text-[var(--color-accent)] hover:underline"
              >
                Criar a primeira peça
              </button>
            </div>
          </div>
        ) : (
          <>
            <header className="flex flex-wrap items-start justify-between gap-3 border-b border-[var(--color-border)] px-6 py-4">
              <div className="min-w-0">
                <h2 className="truncate text-lg font-semibold text-[var(--color-text)]">
                  {selected.title}
                </h2>
                <p className="mt-1 flex flex-wrap items-center gap-2 font-mono text-xs text-[var(--color-text-dim)]">
                  <span>{selected.slug}</span>
                  <span>·</span>
                  <span
                    style={{ color: PROJECT_STATUS_COLOR[selected.status] }}
                  >
                    {PROJECT_STATUS_LABEL[selected.status]}
                  </span>
                  <span>·</span>
                  <span>{kindLabel(selected.kind)}</span>
                </p>
              </div>
              {selected.locales.length > 0 && (
                <div className="flex items-center gap-1">
                  {selected.locales.map((l) => (
                    <button
                      key={l}
                      type="button"
                      onClick={() => void setLocale(l)}
                      className={`rounded-full border px-2.5 py-1 text-xs transition ${
                        l === locale
                          ? "border-[var(--color-accent)] text-[var(--color-text)]"
                          : "border-[var(--color-border)] text-[var(--color-text-dim)] hover:text-[var(--color-text)]"
                      }`}
                    >
                      {l}
                    </button>
                  ))}
                </div>
              )}
            </header>

            <nav className="flex shrink-0 gap-1 border-b border-[var(--color-border)] px-6">
              {TABS.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setTab(t.id)}
                  className={`border-b-2 px-3 py-2 text-sm transition ${
                    t.id === tab
                      ? "border-[var(--color-accent)] text-[var(--color-text)]"
                      : "border-transparent text-[var(--color-text-dim)] hover:text-[var(--color-text)]"
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </nav>

            {tab === "script" && (
              <ScriptEditor key={`${selected.id}-${locale}`} />
            )}
            {tab === "cast" && <CastPanel />}
            {tab === "brand" && <BrandKitPanel />}
            {tab === "assets" && <AssetPanel />}
            {tab === "renders" && <RenderPanel />}
          </>
        )}
      </main>

      <NewProjectDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
      />
    </>
  );
}
