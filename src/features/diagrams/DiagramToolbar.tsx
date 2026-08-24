import { useEffect, useState } from "react";
import { MoreHorizontal } from "lucide-react";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type {
  Diagram,
  DiagramLink,
  DiagramVersionMeta,
} from "../../../shared/types/ipc";
import { diagramsApi } from "@/lib/ipc";
import {
  navigateToFeature,
  navigateToProject,
  navigateToTask,
} from "@/lib/nav";
import { useDiagramsStore } from "@/store/diagramsStore";
import { showToast } from "@/features/notifications/toast-store";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Icon } from "@/components/ui/Icon";
import { Menu } from "@/components/ui/Menu";
import { loadExcalidrawUtils } from "./excalidraw-lazy";
import { KIND_LABEL, PARENT_TYPE_LABEL } from "./diagram-labels";

function formatWhen(ts: number): string {
  return new Date(ts).toLocaleString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function LinkChip({ link }: { link: DiagramLink }) {
  const label = `${PARENT_TYPE_LABEL[link.parentType]} · ${link.parentId.slice(0, 8)}`;
  const navigate =
    link.parentType === "feature"
      ? () => navigateToFeature(link.parentId)
      : link.parentType === "task"
        ? () => navigateToTask(link.parentId)
        : link.parentType === "project"
          ? () => navigateToProject(link.parentId)
          : null;

  const base =
    "shrink-0 rounded-full border border-[var(--color-border)] px-2 py-0.5 text-[11px] text-[var(--color-text-dim)]";
  if (!navigate) {
    return <span className={base}>{label}</span>;
  }
  return (
    <button
      type="button"
      onClick={navigate}
      className={`${base} transition hover:border-[var(--color-accent)]/60 hover:text-[var(--color-text)]`}
    >
      {label}
    </button>
  );
}

interface Props {
  diagram: Diagram;
  excalidrawAPI: ExcalidrawImperativeAPI | null;
}

export function DiagramToolbar({ diagram, excalidrawAPI }: Props) {
  const rename = useDiagramsStore((s) => s.rename);
  const archive = useDiagramsStore((s) => s.archive);
  const unarchive = useDiagramsStore((s) => s.unarchive);
  const remove = useDiagramsStore((s) => s.remove);

  const [title, setTitle] = useState(diagram.title);
  const [menuOpen, setMenuOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [versions, setVersions] = useState<DiagramVersionMeta[]>([]);
  const [versionsLoading, setVersionsLoading] = useState(false);
  const [restoring, setRestoring] = useState<number | null>(null);

  // Rename externo (ex.: via MCP) atualiza o campo se o usuário não editou.
  useEffect(() => {
    setTitle(diagram.title);
  }, [diagram.title]);

  const commitTitle = () => {
    const next = title.trim();
    if (!next || next === diagram.title) {
      setTitle(diagram.title);
      return;
    }
    void rename(diagram.id, next);
  };

  const copyPng = async () => {
    if (!excalidrawAPI) return;
    try {
      const utils = await loadExcalidrawUtils();
      const blob = await utils.exportToBlob({
        elements: excalidrawAPI.getSceneElements(),
        appState: excalidrawAPI.getAppState(),
        files: excalidrawAPI.getFiles(),
        mimeType: "image/png",
      });
      await navigator.clipboard.write([
        new ClipboardItem({ "image/png": blob }),
      ]);
      showToast({ title: "PNG copiado", durationMs: 2500 });
    } catch (err) {
      showToast({
        title: "Falha ao copiar PNG",
        body: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const copySvg = async () => {
    if (!excalidrawAPI) return;
    try {
      const utils = await loadExcalidrawUtils();
      const svg = await utils.exportToSvg({
        elements: excalidrawAPI.getSceneElements(),
        appState: excalidrawAPI.getAppState(),
        files: excalidrawAPI.getFiles(),
      });
      await navigator.clipboard.writeText(svg.outerHTML);
      showToast({ title: "SVG copiado", durationMs: 2500 });
    } catch (err) {
      showToast({
        title: "Falha ao copiar SVG",
        body: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const openHistory = () => {
    setHistoryOpen(true);
    setVersionsLoading(true);
    diagramsApi
      .listVersions(diagram.id)
      .then((v) => setVersions(v))
      .catch(() => setVersions([]))
      .finally(() => setVersionsLoading(false));
  };

  const restoreVersion = async (version: number) => {
    setRestoring(version);
    try {
      // O broadcast diagram:updated atualiza store e editor (remoteScene).
      await diagramsApi.restoreVersion(diagram.id, version);
      setHistoryOpen(false);
      showToast({ title: `Versão ${version} restaurada`, durationMs: 2500 });
    } catch (err) {
      showToast({
        title: "Falha ao restaurar versão",
        body: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setRestoring(null);
    }
  };

  const archived = diagram.status === "archived";

  return (
    <header className="flex items-center gap-3 border-b border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-2">
      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onBlur={commitTitle}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") setTitle(diagram.title);
        }}
        aria-label="Título do diagrama"
        className="min-w-0 flex-1 truncate rounded-md border border-transparent bg-transparent px-2 py-1 text-sm font-semibold text-[var(--color-text)] outline-none transition hover:border-[var(--color-border)] focus:border-[var(--color-accent)]"
      />

      <span className="shrink-0 rounded-full bg-[var(--color-surface-2)] px-2 py-0.5 text-[11px] text-[var(--color-text-dim)]">
        {KIND_LABEL[diagram.kind]}
      </span>
      {archived && (
        <span className="shrink-0 rounded-full border border-[var(--color-border)] px-2 py-0.5 text-[11px] text-[var(--color-text-dim)]">
          Arquivado
        </span>
      )}

      {diagram.links.length > 0 && (
        <div className="flex max-w-[40%] shrink-0 items-center gap-1.5 overflow-x-auto">
          {diagram.links.map((link) => (
            <LinkChip key={`${link.parentType}:${link.parentId}`} link={link} />
          ))}
        </div>
      )}

      <Menu
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        items={[
          {
            label: "Copiar PNG",
            onClick: () => void copyPng(),
            disabled: !excalidrawAPI,
            title: excalidrawAPI ? undefined : "Editor ainda carregando",
          },
          {
            label: "Copiar SVG",
            onClick: () => void copySvg(),
            disabled: !excalidrawAPI,
            title: excalidrawAPI ? undefined : "Editor ainda carregando",
          },
          { label: "Histórico…", onClick: openHistory },
          archived
            ? {
                label: "Desarquivar",
                onClick: () => void unarchive(diagram.id),
              }
            : { label: "Arquivar", onClick: () => void archive(diagram.id) },
          {
            label: "Excluir…",
            onClick: () => setConfirmDelete(true),
            danger: true,
          },
        ]}
      >
        <button
          type="button"
          onClick={() => setMenuOpen((o) => !o)}
          title="Mais ações"
          className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--color-text-dim)] transition hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text)]"
        >
          <Icon as={MoreHorizontal} />
        </button>
      </Menu>

      <Dialog
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        title="Histórico de versões"
        widthClassName="w-[34rem]"
      >
        {versionsLoading ? (
          <p className="py-4 text-sm text-[var(--color-text-dim)]">
            Carregando…
          </p>
        ) : versions.length === 0 ? (
          <p className="py-4 text-sm text-[var(--color-text-dim)]">
            Nenhuma versão registrada.
          </p>
        ) : (
          <ul className="max-h-80 overflow-y-auto">
            {versions.map((v) => (
              <li
                key={v.id}
                className="flex items-center justify-between gap-3 border-b border-[var(--color-border)] py-2 last:border-b-0"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm text-[var(--color-text)]">
                    <span className="font-mono tabular-nums">v{v.version}</span>{" "}
                    · {v.summary}
                  </p>
                  <p className="text-[11px] text-[var(--color-text-dim)]">
                    {v.author === "claude" ? "Claude" : "Você"} ·{" "}
                    {formatWhen(v.createdAt)}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  disabled={v.version === diagram.version || restoring !== null}
                  title={
                    v.version === diagram.version ? "Versão atual" : undefined
                  }
                  onClick={() => void restoreVersion(v.version)}
                >
                  {restoring === v.version
                    ? "Restaurando…"
                    : v.version === diagram.version
                      ? "Atual"
                      : "Restaurar"}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Dialog>

      <Dialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title="Excluir diagrama"
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
              Cancelar
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                setConfirmDelete(false);
                void remove(diagram.id);
              }}
            >
              Excluir
            </Button>
          </>
        }
      >
        <p className="text-sm text-[var(--color-text)]">
          Excluir <strong>{diagram.title}</strong>? O histórico de versões vai
          junto — essa ação não tem desfazer.
        </p>
      </Dialog>
    </header>
  );
}
