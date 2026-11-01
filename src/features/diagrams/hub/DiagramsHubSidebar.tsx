import { useState } from "react";
import { Archive, Clock, Inbox, Plus } from "lucide-react";
import { Icon } from "@/components/ui/Icon";
import { InlineInput } from "@/features/design/InlineInput";
import { FolderRow, SIDEBAR_INPUT_CLASS } from "@/features/design/hub/FolderItem";
import { dropId } from "@/features/design/hub/hub-filter";
import { NavRow } from "@/features/design/hub/NavRow";
import { useDiagramsStore } from "@/store/diagramsStore";

export function DiagramsHubSidebar() {
  const diagrams = useDiagramsStore((s) => s.diagrams);
  const folders = useDiagramsStore((s) => s.folders);
  const section = useDiagramsStore((s) => s.hubSection);
  const setSection = useDiagramsStore((s) => s.setHubSection);
  const createFolder = useDiagramsStore((s) => s.createFolder);
  const renameFolder = useDiagramsStore((s) => s.renameFolder);
  const recolorFolder = useDiagramsStore((s) => s.recolorFolder);
  const deleteFolder = useDiagramsStore((s) => s.deleteFolder);
  const [creating, setCreating] = useState(false);

  const unfiled = diagrams.filter((d) => d.folderId === null).length;

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-[var(--color-border)] bg-[var(--color-surface)]">
      <div className="px-4 pb-3 pt-4">
        <h2 className="text-sm font-semibold text-[var(--color-text)]">Diagramas</h2>
      </div>
      <nav
        aria-label="Seções de diagramas"
        className="min-h-0 flex-1 overflow-y-auto px-2 pb-3"
      >
        <NavRow
          active={section === "recent"}
          onSelect={() => setSection("recent")}
          leading={<Icon as={Clock} size={14} className="shrink-0 opacity-80" />}
          label="Recentes"
          count={diagrams.length}
        />

        <div className="mt-5 flex items-center justify-between px-2 pb-1">
          <span className="text-[11px] font-medium text-[var(--color-text-dim)]">
            Pastas
          </span>
          <button
            type="button"
            aria-label="Nova pasta"
            title="Nova pasta"
            onClick={() => setCreating(true)}
            className="flex h-5 w-5 items-center justify-center rounded text-[var(--color-text-dim)] outline-none transition hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text)] focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
          >
            <Icon as={Plus} size={12} />
          </button>
        </div>
        {creating && (
          <InlineInput
            placeholder="Nome da pasta"
            className={SIDEBAR_INPUT_CLASS}
            onSubmit={(name) => {
              setCreating(false);
              void createFolder(name).then((f) => f && setSection(f.id));
            }}
            onCancel={() => setCreating(false)}
          />
        )}
        <ul className="flex flex-col gap-px">
          {folders.map((f) => (
            <FolderRow
              key={f.id}
              folder={f}
              itemsLabel="diagramas"
              active={section === f.id}
              onSelect={() => setSection(f.id)}
              onRename={(name) => void renameFolder(f.id, name)}
              onRecolor={(color) => void recolorFolder(f.id, color)}
              onDelete={() => void deleteFolder(f.id)}
            />
          ))}
        </ul>
        {folders.length === 0 && !creating && (
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="w-full rounded-md px-2 py-1.5 text-left text-[11px] leading-relaxed text-[var(--color-text-dim)] outline-none transition hover:text-[var(--color-text)] focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
          >
            Crie uma pasta para agrupar diagramas por projeto ou tema.
          </button>
        )}

        <div className="mt-5 flex flex-col gap-px border-t border-[var(--color-border)] pt-3">
          <NavRow
            dropId={dropId(null)}
            active={section === "unfiled"}
            onSelect={() => setSection("unfiled")}
            leading={<Icon as={Inbox} size={14} className="shrink-0 opacity-80" />}
            label="Sem pasta"
            count={unfiled}
          />
          <NavRow
            active={section === "archived"}
            onSelect={() => setSection("archived")}
            leading={<Icon as={Archive} size={14} className="shrink-0 opacity-80" />}
            label="Arquivados"
          />
        </div>
      </nav>
    </aside>
  );
}
