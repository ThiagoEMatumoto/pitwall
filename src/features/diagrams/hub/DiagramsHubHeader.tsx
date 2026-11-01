import { Plus, Search, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { cx } from "@/features/brand";
import { useDiagramsStore } from "@/store/diagramsStore";
import type { DiagramHubSort } from "./diagram-hub";

const SORTS: Array<{ value: DiagramHubSort; label: string }> = [
  { value: "recent", label: "Recentes" },
  { value: "name", label: "Nome" },
];

export function DiagramsHubHeader({
  title,
  count,
  creating,
  onCreate,
}: {
  title: string;
  count: number;
  creating: boolean;
  onCreate: () => void;
}) {
  const query = useDiagramsStore((s) => s.hubQuery);
  const sort = useDiagramsStore((s) => s.hubSort);
  const setQuery = useDiagramsStore((s) => s.setHubQuery);
  const setSort = useDiagramsStore((s) => s.setHubSort);

  return (
    <header className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-3 border-b border-[var(--color-border)] px-6 py-4">
      <div className="flex min-w-0 items-baseline gap-2">
        <h1 className="truncate text-lg font-semibold text-[var(--color-text)]">
          {title}
        </h1>
        <span
          className="text-[12px] tabular-nums text-[var(--color-text-dim)]"
          aria-label={`${count} diagramas`}
        >
          {count}
        </span>
      </div>

      <div className="ml-auto flex flex-wrap items-center gap-2">
        <div className="relative">
          <Icon
            as={Search}
            size={14}
            aria-hidden
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--color-text-dim)]"
          />
          <input
            type="text"
            role="searchbox"
            value={query}
            placeholder="Buscar diagramas"
            aria-label="Buscar diagramas"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && setQuery("")}
            className="h-8 w-56 rounded-full border border-[var(--color-border)] bg-[var(--color-bg)] pl-8 pr-7 text-[12px] text-[var(--color-text)] outline-none transition placeholder:text-[var(--color-text-dim)] focus:border-[var(--color-accent)]/70"
          />
          {query && (
            <button
              type="button"
              aria-label="Limpar busca"
              onClick={() => setQuery("")}
              className="absolute right-1.5 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-full text-[var(--color-text-dim)] outline-none hover:text-[var(--color-text)] focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
            >
              <Icon as={X} size={12} />
            </button>
          )}
        </div>

        <div
          role="group"
          aria-label="Ordenar por"
          className="flex h-8 items-center rounded-full border border-[var(--color-border)] p-0.5"
        >
          {SORTS.map((s) => (
            <button
              key={s.value}
              type="button"
              aria-pressed={sort === s.value}
              onClick={() => setSort(s.value)}
              className={cx(
                "h-full rounded-full px-3 text-[12px] outline-none transition focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]",
                sort === s.value
                  ? "bg-[var(--color-surface-2)] text-[var(--color-text)]"
                  : "text-[var(--color-text-dim)] hover:text-[var(--color-text)]",
              )}
            >
              {s.label}
            </button>
          ))}
        </div>

        <Button className="h-8 py-0" loading={creating} onClick={onCreate}>
          <Icon as={Plus} size={14} />
          Novo diagrama
        </Button>
      </div>
    </header>
  );
}
