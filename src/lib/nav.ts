import { useAppStore } from "@/store/appStore";
import { useDesignStore } from "@/store/designStore";
import { useDiagramsStore } from "@/store/diagramsStore";
import { useFeaturesStore } from "@/store/featuresStore";
import { useMeetingsStore } from "@/store/meetingsStore";
import { useObjectivesStore } from "@/store/objectivesStore";
import { useTasksStore } from "@/store/tasksStore";

// Navegação clicável entre objetivos/features/tasks (Onda 2 — fecha o "todo
// vínculo é texto morto" da curadoria). Cada função seleciona a entidade no
// store dono (o detail carrega sozinho) e troca a área ativa — extraído de
// TreeNode.tsx, que era o único lugar que navegava (só a Home).

export function navigateToObjective(id: string): void {
  void useObjectivesStore.getState().select(id);
  useAppStore.getState().setArea("objectives");
}

export function navigateToFeature(id: string): void {
  void useFeaturesStore.getState().select(id);
  useAppStore.getState().setArea("features");
}

// Tasks não têm uma view de detalhe própria (lista/board/pendências filtram
// em memória, sem rota por id) — foca a tarefa via tasksStore; TasksArea abre
// o dialog de edição dela assim que a tarefa aparecer na lista carregada.
export function navigateToTask(id: string): void {
  useTasksStore.getState().focusTask(id);
  useAppStore.getState().setArea("tasks");
}

export function navigateToMeeting(id: string): void {
  void useMeetingsStore.getState().select(id);
  useAppStore.getState().setArea("meetings");
}

export function navigateToProject(id: string): void {
  useAppStore.getState().setActiveProject(id);
  useAppStore.getState().setArea("projects");
}

// Import circular com diagramsStore (o toast "Claude atualizou" navega pra
// cá): inofensivo — ambos os lados só usam o outro dentro de função.
export function navigateToDiagram(id: string): void {
  void useDiagramsStore.getState().select(id);
  useAppStore.getState().setArea("diagrams");
}

// Same circular-import shape as diagrams: designStore toasts navigate here.
export function navigateToDesign(docId?: string): void {
  if (docId) void useDesignStore.getState().openDoc(docId);
  useAppStore.getState().setArea("design");
}
