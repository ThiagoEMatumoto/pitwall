import { useEffect } from "react";
import { useDiagramsStore } from "@/store/diagramsStore";
import { DiagramEditor } from "./DiagramEditor";
import { DiagramsHub } from "./hub/DiagramsHub";

// Sem diagrama aberto: o hub (pastas + grade). Com um aberto: o editor em
// tela cheia; o toolbar tem o "voltar" para o hub.
export function DiagramsArea() {
  const selected = useDiagramsStore((s) => s.selected);
  const remoteScene = useDiagramsStore((s) => s.remoteScene);
  const load = useDiagramsStore((s) => s.load);
  const loadFolders = useDiagramsStore((s) => s.loadFolders);
  const startWatch = useDiagramsStore((s) => s.startWatch);
  const stopWatch = useDiagramsStore((s) => s.stopWatch);

  useEffect(() => {
    void load();
    void loadFolders();
    startWatch();
    return () => stopWatch();
  }, [load, loadFolders, startWatch, stopWatch]);

  if (!selected) return <DiagramsHub />;

  return (
    <main className="flex flex-1 flex-col overflow-hidden">
      <DiagramEditor key={selected.id} diagram={selected} remoteScene={remoteScene} />
    </main>
  );
}
