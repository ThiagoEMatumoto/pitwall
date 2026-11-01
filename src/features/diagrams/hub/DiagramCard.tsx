import { useState, type CSSProperties } from "react";
import { useDraggable } from "@dnd-kit/core";
import { MoreHorizontal } from "lucide-react";
import { Icon } from "@/components/ui/Icon";
import { Menu } from "@/components/ui/Menu";
import { cx } from "@/features/brand";
import { InlineInput } from "@/features/design/InlineInput";
import { moveSection } from "@/features/design/hub/doc-menu";
import { folderDotStyle } from "@/features/design/hub/folder-colors";
import { useDiagramsStore } from "@/store/diagramsStore";
import type { DiagramMeta } from "../../../../shared/types/ipc";
import { KIND_LABEL, relativeTime } from "../diagram-labels";
import { DiagramThumb } from "./DiagramThumb";

// O stagger de entrada para de crescer depois de uma dúzia de cards.
const MAX_STAGGER = 12;

export function DiagramCard({
  diagram,
  index,
  showFolder,
}: {
  diagram: DiagramMeta;
  index: number;
  showFolder: boolean;
}) {
  const folders = useDiagramsStore((s) => s.folders);
  const select = useDiagramsStore((s) => s.select);
  const move = useDiagramsStore((s) => s.move);
  const rename = useDiagramsStore((s) => s.rename);
  const archive = useDiagramsStore((s) => s.archive);
  const unarchive = useDiagramsStore((s) => s.unarchive);
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  // Selecionar texto no campo de renomear não pode levantar o card.
  const { setNodeRef, listeners, isDragging } = useDraggable({
    id: diagram.id,
    disabled: renaming,
  });

  const archived = diagram.status === "archived";
  const folder = showFolder
    ? folders.find((f) => f.id === diagram.folderId)
    : undefined;

  return (
    <article
      ref={setNodeRef}
      {...listeners}
      data-testid="diagram-card"
      className={cx(
        "group relative home-rise motion-reduce:animate-none",
        isDragging && "opacity-40",
      )}
      style={{ "--i": Math.min(index, MAX_STAGGER) } as CSSProperties}
    >
      <div className="glass-card flex h-full flex-col overflow-hidden transition duration-200 ease-out group-hover:-translate-y-px group-hover:border-[var(--color-accent-dim)]/40 group-focus-within:border-[var(--color-accent-dim)]/60 motion-reduce:transition-none motion-reduce:group-hover:translate-y-0">
        <div className="relative aspect-[16/10] overflow-hidden border-b border-white/[0.04] bg-[var(--color-surface-2)]">
          <DiagramThumb kind={diagram.kind} thumbnail={diagram.thumbnail} />
        </div>

        <div className="flex items-start gap-1 px-3 pb-2.5 pt-2">
          <div className="min-w-0 flex-1">
            {renaming ? (
              <InlineInput
                placeholder="Nome do diagrama"
                initial={diagram.title}
                className="relative z-10 h-6 w-full rounded-md border border-[var(--color-accent)] bg-[var(--color-bg)] px-1.5 text-[13px] text-[var(--color-text)] outline-none"
                onSubmit={(title) => {
                  setRenaming(false);
                  if (title !== diagram.title) void rename(diagram.id, title);
                }}
                onCancel={() => setRenaming(false)}
              />
            ) : (
              // Esticado sobre o card inteiro: um tab stop, o card é o alvo.
              <button
                type="button"
                onClick={() => void select(diagram.id)}
                className="block w-full truncate text-left text-[13px] font-medium leading-6 text-[var(--color-text)] outline-none after:absolute after:inset-0 after:rounded-xl focus-visible:after:ring-2 focus-visible:after:ring-[var(--color-accent)]"
              >
                {diagram.title}
              </button>
            )}
            <div className="flex min-w-0 items-center gap-1.5 text-[11px] text-[var(--color-text-dim)]">
              <span className="shrink-0">{KIND_LABEL[diagram.kind]}</span>
              <span aria-hidden>·</span>
              <span className="shrink-0 tabular-nums">
                {relativeTime(diagram.updatedAt)}
              </span>
              {folder && (
                <>
                  <span aria-hidden>·</span>
                  <span className="flex min-w-0 items-center gap-1">
                    <span
                      aria-hidden
                      className="h-1.5 w-1.5 shrink-0 rounded-full"
                      style={folderDotStyle(folder.color)}
                    />
                    <span className="truncate">{folder.name}</span>
                  </span>
                </>
              )}
            </div>
          </div>

          {/* Eventos de ponteiro do menu (portal) borbulham por aqui no React,
              não até o card arrastável. */}
          <div
            className="relative z-10"
            onPointerDown={(e) => e.stopPropagation()}
          >
            <Menu
              open={menuOpen}
              onClose={() => setMenuOpen(false)}
              portal
              sections={[
                {
                  title: "Diagrama",
                  items: [
                    { label: "Renomear", onClick: () => setRenaming(true) },
                    archived
                      ? {
                          label: "Desarquivar",
                          onClick: () => void unarchive(diagram.id),
                        }
                      : {
                          label: "Arquivar",
                          onClick: () => void archive(diagram.id),
                          danger: true,
                        },
                  ],
                },
                moveSection(folders, diagram.folderId, (folderId) =>
                  void move(diagram.id, folderId),
                ),
              ]}
            >
              <button
                type="button"
                aria-label={`Opções de ${diagram.title}`}
                title="Opções"
                onClick={() => setMenuOpen((o) => !o)}
                aria-expanded={menuOpen}
                className="flex h-6 w-6 items-center justify-center rounded-md text-[var(--color-text-dim)] opacity-0 outline-none transition hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text)] focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] group-hover:opacity-100 group-focus-within:opacity-100 aria-expanded:opacity-100"
              >
                <Icon as={MoreHorizontal} size={14} />
              </button>
            </Menu>
          </div>
        </div>
      </div>
    </article>
  );
}

// O que segue o ponteiro durante o arraste: thumbnail + título.
export function DiagramDragChip({ diagram }: { diagram: DiagramMeta }) {
  return (
    <div className="glass-card flex w-56 cursor-grabbing items-center gap-2 overflow-hidden p-1.5 pr-3 shadow-2xl">
      <div className="aspect-[16/10] w-14 shrink-0 overflow-hidden rounded-md bg-[var(--color-surface-2)]">
        <DiagramThumb kind={diagram.kind} thumbnail={diagram.thumbnail} />
      </div>
      <span className="truncate text-[12px] font-medium text-[var(--color-text)]">
        {diagram.title}
      </span>
    </div>
  );
}
