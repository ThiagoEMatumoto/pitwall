import { useEffect, useMemo, useState } from "react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
} from "@dnd-kit/core";
import { chipFollowsCursor, hubCollisionDetection } from "@/features/design/hub/hub-drag";
import { parseDropId } from "@/features/design/hub/hub-filter";
import { useDiagramsStore } from "@/store/diagramsStore";
import { DiagramDragChip } from "./DiagramCard";
import { DiagramsHubGrid } from "./DiagramsHubGrid";
import { DiagramsHubHeader } from "./DiagramsHubHeader";
import { DiagramsHubSidebar } from "./DiagramsHubSidebar";
import { sectionDiagrams, sectionTitle, visibleDiagrams } from "./diagram-hub";

// Um clique no card ainda abre: o arraste só começa depois desta distância.
const DRAG_DISTANCE_PX = 6;

// Mostrado quando nenhum diagrama está aberto: seções + pastas à esquerda, a
// grade da seção à direita. Arrastar um card para uma pasta o move (mesmo
// modelo do hub do Design).
export function DiagramsHub() {
  const diagrams = useDiagramsStore((s) => s.diagrams);
  const archived = useDiagramsStore((s) => s.archivedDiagrams);
  const folders = useDiagramsStore((s) => s.folders);
  const section = useDiagramsStore((s) => s.hubSection);
  const query = useDiagramsStore((s) => s.hubQuery);
  const sort = useDiagramsStore((s) => s.hubSort);
  const loading = useDiagramsStore((s) => s.loading);
  const error = useDiagramsStore((s) => s.error);
  const create = useDiagramsStore((s) => s.create);
  const move = useDiagramsStore((s) => s.move);
  const loadArchived = useDiagramsStore((s) => s.loadArchived);
  const setQuery = useDiagramsStore((s) => s.setHubQuery);

  const [creating, setCreating] = useState(false);
  const [dragId, setDragId] = useState<string | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: DRAG_DISTANCE_PX } }),
  );

  useEffect(() => {
    if (section === "archived") void loadArchived();
  }, [section, loadArchived]);

  const inSection = useMemo(
    () => sectionDiagrams(section, diagrams, archived),
    [section, diagrams, archived],
  );
  const shown = useMemo(
    () => visibleDiagrams(inSection, query, sort),
    [inSection, query, sort],
  );
  const all = [...diagrams, ...archived];
  const dragged = dragId ? all.find((d) => d.id === dragId) : undefined;

  const titleOf = (id: string | number) =>
    all.find((d) => d.id === id)?.title ?? "diagrama";
  const announcements: Announcements = {
    onDragStart: ({ active }) => `Arrastando ${titleOf(active.id)}.`,
    onDragOver: ({ over }) =>
      over?.data.current?.label ? `Sobre ${over.data.current.label}.` : "Fora de uma pasta.",
    onDragEnd: ({ active, over }) =>
      over?.data.current?.label
        ? `${titleOf(active.id)} movido para ${over.data.current.label}.`
        : "Solto fora de uma pasta.",
    onDragCancel: () => "Movimento cancelado.",
  };

  function onDragEnd(e: DragEndEvent): void {
    setDragId(null);
    const target = parseDropId(e.over?.id);
    if (target !== undefined) void move(String(e.active.id), target);
  }

  async function onCreate(): Promise<void> {
    setCreating(true);
    try {
      await create();
    } catch (err) {
      useDiagramsStore.setState({
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setCreating(false);
    }
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={hubCollisionDetection}
      accessibility={{ announcements }}
      onDragStart={(e) => setDragId(String(e.active.id))}
      onDragEnd={onDragEnd}
      onDragCancel={() => setDragId(null)}
    >
      <DiagramsHubSidebar />
      <main className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
        <DiagramsHubHeader
          title={sectionTitle(section, folders)}
          count={shown.length}
          creating={creating}
          onCreate={() => void onCreate()}
        />
        {error && (
          <div
            role="alert"
            className="flex items-center gap-2 px-6 pt-3 text-xs text-[var(--color-danger)]"
          >
            <span className="min-w-0 truncate">{error}</span>
            <button
              type="button"
              onClick={() => useDiagramsStore.setState({ error: null })}
              className="shrink-0 rounded underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
            >
              Dispensar
            </button>
          </div>
        )}
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          <DiagramsHubGrid
            section={section}
            diagrams={shown}
            sectionCount={inSection.length}
            query={query}
            loading={loading}
            onCreate={() => void onCreate()}
            onClearQuery={() => setQuery("")}
          />
        </div>
      </main>
      <DragOverlay dropAnimation={null} modifiers={[chipFollowsCursor]}>
        {dragged ? <DiagramDragChip diagram={dragged} /> : null}
      </DragOverlay>
    </DndContext>
  );
}
