import { useEffect, useState } from "react";
import { LayoutTemplate, Library, Plus, Workflow } from "lucide-react";
import { Icon } from "@/components/ui/Icon";
import { activeMarker } from "@/features/brand";
import { useDiagramsStore } from "@/store/diagramsStore";
import { KIND_LABEL, relativeTime } from "./diagram-labels";
import { DiagramEditor } from "./DiagramEditor";
import { LibraryCatalogDialog } from "./LibraryCatalogDialog";
import { TemplatePickerDialog } from "./TemplatePickerDialog";

const headerButton =
  "flex h-6 w-6 items-center justify-center rounded-md text-[var(--color-text-dim)] transition hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text)]";
const textButton =
  "inline-flex items-center gap-1.5 rounded-md border border-[var(--color-border)] px-2.5 py-1 text-xs text-[var(--color-text)] transition hover:bg-[var(--color-surface-2)]";

export function DiagramsArea() {
  const diagrams = useDiagramsStore((s) => s.diagrams);
  const selected = useDiagramsStore((s) => s.selected);
  const remoteScene = useDiagramsStore((s) => s.remoteScene);
  const showArchived = useDiagramsStore((s) => s.showArchived);
  const loading = useDiagramsStore((s) => s.loading);
  const error = useDiagramsStore((s) => s.error);
  const load = useDiagramsStore((s) => s.load);
  const select = useDiagramsStore((s) => s.select);
  const create = useDiagramsStore((s) => s.create);
  const createFromTemplate = useDiagramsStore((s) => s.createFromTemplate);
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [librariesOpen, setLibrariesOpen] = useState(false);
  const setShowArchived = useDiagramsStore((s) => s.setShowArchived);
  const startWatch = useDiagramsStore((s) => s.startWatch);
  const stopWatch = useDiagramsStore((s) => s.stopWatch);

  useEffect(() => {
    void load();
    startWatch();
    return () => stopWatch();
  }, [load, startWatch, stopWatch]);

  return (
    <>
      <aside className="flex w-72 shrink-0 flex-col border-r border-[var(--color-border)] bg-[var(--color-surface)]">
        <div className="flex items-center justify-between border-b border-[var(--color-border)] px-4 py-3">
          <span className="text-sm font-semibold text-[var(--color-text)]">
            Diagramas
          </span>
          <div className="flex items-center gap-0.5">
            <button
              type="button"
              onClick={() => setLibrariesOpen(true)}
              title="Bibliotecas de shapes"
              aria-label="Bibliotecas"
              className={headerButton}
            >
              <Icon as={Library} />
            </button>
            <button
              type="button"
              onClick={() => setTemplatesOpen(true)}
              title="Novo a partir de modelo"
              aria-label="Novo a partir de modelo"
              className={headerButton}
            >
              <Icon as={LayoutTemplate} />
            </button>
            <button
              type="button"
              onClick={() => void create()}
              title="Novo diagrama"
              aria-label="Novo diagrama"
              className={headerButton}
            >
              <Icon as={Plus} />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto">
          {error ? (
            <p className="px-4 py-6 text-sm text-[var(--color-danger)]">
              {error}
            </p>
          ) : loading && diagrams.length === 0 ? (
            <p className="px-4 py-6 text-sm text-[var(--color-text-dim)]">
              Carregando…
            </p>
          ) : diagrams.length === 0 ? (
            <p className="px-4 py-6 text-sm text-[var(--color-text-dim)]">
              Nenhum diagrama ainda. Peça a uma sessão do Claude para criar um,
              comece em branco no “+” acima ou parta de um modelo de
              arquitetura de software ou pipeline de ML.
            </p>
          ) : (
            <ul>
              {diagrams.map((d) => {
                const active = d.id === selected?.id;
                return (
                  <li key={d.id}>
                    <button
                      type="button"
                      onClick={() => void select(d.id)}
                      className={`flex w-full flex-col gap-1 border-b border-[var(--color-border)] px-4 py-3 text-left transition ${
                        active
                          ? `bg-[var(--color-surface-2)] ${activeMarker}`
                          : "hover:bg-[var(--color-surface-2)]/60"
                      }`}
                    >
                      <span className="truncate text-sm font-medium text-[var(--color-text)]">
                        {d.title}
                      </span>
                      <span className="flex items-center gap-1.5 text-[11px] text-[var(--color-text-dim)]">
                        <span className="rounded-full bg-[var(--color-surface-2)] px-1.5 py-px">
                          {KIND_LABEL[d.kind]}
                        </span>
                        {d.status === "archived" && (
                          <span className="rounded-full border border-[var(--color-border)] px-1.5 py-px">
                            Arquivado
                          </span>
                        )}
                        <span className="tabular-nums">
                          {relativeTime(d.updatedAt)}
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <label className="flex cursor-pointer items-center gap-2 border-t border-[var(--color-border)] px-4 py-2.5 text-xs text-[var(--color-text-dim)]">
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(e) => void setShowArchived(e.target.checked)}
            className="accent-[var(--color-accent)]"
          />
          Mostrar arquivados
        </label>
      </aside>

      <main className="flex flex-1 flex-col overflow-hidden">
        {!selected ? (
          <div className="flex flex-1 items-center justify-center text-sm text-[var(--color-text-dim)]">
            <div className="flex max-w-sm flex-col items-center gap-2 text-center">
              <Icon as={Workflow} size={32} />
              <span>
                Selecione um diagrama — ou peça ao Claude para criar um (ex.:
                “desenha a arquitetura desse repo”).
              </span>
              <div className="mt-2 flex flex-wrap justify-center gap-2">
                <button
                  type="button"
                  onClick={() => setTemplatesOpen(true)}
                  className={textButton}
                >
                  <Icon as={LayoutTemplate} size={14} />
                  Novo a partir de modelo
                </button>
                <button
                  type="button"
                  onClick={() => setLibrariesOpen(true)}
                  className={textButton}
                >
                  <Icon as={Library} size={14} />
                  Bibliotecas de shapes
                </button>
              </div>
              <span className="text-xs">
                Modelos: arquitetura de software, pipeline de ML,
                microsserviços. Bibliotecas: ícones de system design,
                Kubernetes, deep learning, stack de dados e cloud.
              </span>
            </div>
          </div>
        ) : (
          <DiagramEditor
            key={selected.id}
            diagram={selected}
            remoteScene={remoteScene}
          />
        )}
      </main>

      <TemplatePickerDialog
        open={templatesOpen}
        onClose={() => setTemplatesOpen(false)}
        onPick={createFromTemplate}
      />
      <LibraryCatalogDialog
        open={librariesOpen}
        onClose={() => setLibrariesOpen(false)}
      />
    </>
  );
}
