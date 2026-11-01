import { useState } from "react";
import {
  ArrowRightLeft,
  Boxes,
  Database,
  Network,
  Shapes,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import { Icon } from "@/components/ui/Icon";
import type { DiagramKind } from "../../../../shared/types/ipc";

export const KIND_ICON: Record<DiagramKind, LucideIcon> = {
  architecture: Boxes,
  flow: Workflow,
  sequence: ArrowRightLeft,
  er: Database,
  mindmap: Network,
  other: Shapes,
};

// Grade de pontos como um canvas vazio + ícone do kind: diagrama sem preview
// ainda (criado pelo Claude e nunca aberto) não parece imagem quebrada.
function Placeholder({ kind }: { kind: DiagramKind }) {
  return (
    <div
      aria-hidden
      data-testid="diagram-thumb-placeholder"
      className="flex h-full w-full items-center justify-center text-[var(--color-text-dim)] opacity-60"
      style={{
        backgroundImage:
          "radial-gradient(color-mix(in srgb, var(--color-text-dim) 22%, transparent) 1px, transparent 1px)",
        backgroundSize: "14px 14px",
      }}
    >
      <Icon as={KIND_ICON[kind]} size={22} />
    </div>
  );
}

// `thumbnail` é o data URL PNG que o editor grava a cada snapshot.
export function DiagramThumb({
  kind,
  thumbnail,
}: {
  kind: DiagramKind;
  thumbnail: string | null;
}) {
  // Guarda QUAL src falhou: um preview novo tenta de novo sem remontar.
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  if (!thumbnail || failedSrc === thumbnail) return <Placeholder kind={kind} />;
  return (
    <img
      src={thumbnail}
      alt=""
      loading="lazy"
      draggable={false}
      onError={() => setFailedSrc(thumbnail)}
      className="h-full w-full bg-[var(--color-surface-2)] object-contain"
    />
  );
}
