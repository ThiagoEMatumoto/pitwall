import type { ComponentType, ReactNode } from "react";
import {
  Archive,
  FolderOpen,
  Inbox,
  SearchX,
  Workflow,
  type LucideProps,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import type { DiagramMeta } from "../../../../shared/types/ipc";
import { DiagramCard } from "./DiagramCard";
import type { DiagramHubSection } from "./diagram-hub";

const SKELETONS = 6;
const GRID = "grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-4 p-6";

function Empty({
  icon,
  title,
  children,
  actions,
}: {
  icon: ComponentType<LucideProps>;
  title: string;
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-1 items-center justify-center px-6 py-16">
      <div className="flex max-w-sm flex-col items-center gap-2 text-center">
        <span className="mb-1 flex h-11 w-11 items-center justify-center rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)] text-[var(--color-text-dim)]">
          <Icon as={icon} size={20} />
        </span>
        <h2 className="text-sm font-semibold text-[var(--color-text)]">{title}</h2>
        <p className="text-[13px] leading-relaxed text-[var(--color-text-dim)]">
          {children}
        </p>
        {actions && (
          <div className="mt-2 flex flex-wrap justify-center gap-2">{actions}</div>
        )}
      </div>
    </div>
  );
}

export function DiagramsHubGrid({
  section,
  diagrams,
  sectionCount,
  query,
  loading,
  onCreate,
  onClearQuery,
}: {
  section: DiagramHubSection;
  diagrams: DiagramMeta[];
  // A seção antes da busca: separa "pasta vazia" de "nada bate".
  sectionCount: number;
  query: string;
  loading: boolean;
  onCreate: () => void;
  onClearQuery: () => void;
}) {
  if (loading && sectionCount === 0) {
    return (
      <div aria-busy="true" aria-label="Carregando diagramas" className={GRID}>
        {Array.from({ length: SKELETONS }, (_, i) => (
          <div key={i} className="glass-card overflow-hidden">
            <div className="pw-agent-skeleton aspect-[16/10] bg-[var(--color-surface-2)]" />
            <div className="space-y-2 px-3 py-3">
              <div className="pw-agent-skeleton h-3 w-2/3 rounded bg-[var(--color-surface-2)]" />
              <div className="pw-agent-skeleton h-2.5 w-1/3 rounded bg-[var(--color-surface-2)]" />
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (sectionCount === 0) {
    if (section === "recent") {
      return (
        <Empty
          icon={Workflow}
          title="Nenhum diagrama ainda"
          actions={<Button onClick={onCreate}>Novo diagrama</Button>}
        >
          Peça a uma sessão do Claude para criar um (ex.: “desenha a arquitetura
          desse repo”) — ou comece um em branco.
        </Empty>
      );
    }
    if (section === "archived") {
      return (
        <Empty icon={Archive} title="Nada arquivado">
          Diagramas arquivados saem das listas, mas ficam guardados aqui.
        </Empty>
      );
    }
    if (section === "unfiled") {
      return (
        <Empty icon={Inbox} title="Tudo organizado">
          Todos os diagramas estão em alguma pasta.
        </Empty>
      );
    }
    return (
      <Empty
        icon={FolderOpen}
        title="Esta pasta está vazia"
        actions={<Button onClick={onCreate}>Novo diagrama</Button>}
      >
        Arraste diagramas para cá ou crie um novo.
      </Empty>
    );
  }

  if (diagrams.length === 0) {
    return (
      <Empty
        icon={SearchX}
        title={`Nenhum diagrama com “${query.trim()}”`}
        actions={
          <Button variant="ghost" onClick={onClearQuery}>
            Limpar busca
          </Button>
        }
      >
        A busca olha só os títulos desta seção.
      </Empty>
    );
  }

  return (
    <ul aria-label="Diagramas" className={GRID}>
      {diagrams.map((d, i) => (
        <li key={d.id}>
          <DiagramCard diagram={d} index={i} showFolder={section === "recent"} />
        </li>
      ))}
    </ul>
  );
}
