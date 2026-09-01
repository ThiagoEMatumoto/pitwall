import type { DiagramKind, DiagramParentType } from "../../../shared/types/ipc";

export const KIND_LABEL: Record<DiagramKind, string> = {
  architecture: "Arquitetura",
  flow: "Fluxo",
  sequence: "Sequência",
  er: "ER",
  mindmap: "Mindmap",
  other: "Outro",
};

export const PARENT_TYPE_LABEL: Record<DiagramParentType, string> = {
  project: "Projeto",
  repo: "Repo",
  feature: "Feature",
  task: "Tarefa",
  objective: "Objetivo",
  key_result: "KR",
  session: "Sessão",
  handoff: "Handoff",
};

// "há 5 min" / "há 3 h" / "ontem" / data curta — pro updatedAt da lista.
export function relativeTime(ts: number, now = Date.now()): string {
  const diff = now - ts;
  const min = Math.floor(diff / 60_000);
  if (min < 1) return "agora";
  if (min < 60) return `há ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `há ${h} h`;
  const d = Math.floor(h / 24);
  if (d === 1) return "ontem";
  if (d < 7) return `há ${d} dias`;
  return new Date(ts).toLocaleDateString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
  });
}
