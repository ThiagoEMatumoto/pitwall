import {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { Diagram } from "../../../shared/types/ipc";
import type { RemoteScene } from "@/store/diagramsStore";
import { useDiagramsStore } from "@/store/diagramsStore";
import { showToast } from "@/features/notifications/toast-store";
import { Button } from "@/components/ui/Button";
import { LazyExcalidraw, loadExcalidrawUtils } from "./excalidraw-lazy";
import { DiagramToolbar } from "./DiagramToolbar";

const SAVE_DEBOUNCE_MS = 800;

// Identidade barata da cena: id+version de cada elemento. É o que decide se um
// onChange é edição real (Excalidraw bumpa version a cada mutação) e se um
// broadcast é eco do nosso próprio save.
function fingerprint(elements: readonly unknown[]): string {
  return elements
    .map((e) => {
      const el = e as { id?: string; version?: number };
      return `${el.id}:${el.version}`;
    })
    .join("|");
}

function cssVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  return v || fallback;
}

interface Props {
  diagram: Diagram;
  remoteScene: RemoteScene | null;
}

// Montado com key={diagram.id}: trocar de diagrama remonta o editor inteiro
// (initialData limpo, refs zeradas) e o unmount faz o flush final.
export function DiagramEditor({ diagram, remoteScene }: Props) {
  const saveScene = useDiagramsStore((s) => s.saveScene);
  const [excalidrawAPI, setExcalidrawAPI] =
    useState<ExcalidrawImperativeAPI | null>(null);
  const [conflict, setConflict] = useState<RemoteScene | null>(null);

  // Fingerprint do que está persistido (head). Começa na cena carregada.
  const savedFpRef = useRef(fingerprint(diagram.scene.elements));
  // Houve edição desde o último snapshot? (draft salvo ainda conta como dirty
  // até o próximo flush com snapshot:true, que grava a linha de histórico.)
  const dirtySinceSnapshotRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingElementsRef = useRef<readonly unknown[] | null>(null);
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  apiRef.current = excalidrawAPI;

  const diagramId = diagram.id;

  // initialData como Promise (suportado pelo Excalidraw): restoreElements vem
  // do mesmo chunk lazy, então não dá pra tê-lo sincronamente no 1º render.
  const initialDataPromise = useMemo(async () => {
    const utils = await loadExcalidrawUtils();
    return {
      elements: utils.restoreElements(
        diagram.scene.elements as Parameters<typeof utils.restoreElements>[0],
        null,
      ),
      // Sem viewBackgroundColor custom: o theme="dark" do Excalidraw INVERTE
      // as cores do canvas — um bg escuro aqui viraria claro na tela. Os
      // defaults da lib (bg branco, stroke #1e1e1e) renderizam certo no dark.
      appState: {},
    };
    // Remontado por key={diagram.id}; a cena inicial não muda durante a vida
    // do componente.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const flush = useCallback(
    (snapshot: boolean) => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      const elements =
        pendingElementsRef.current ??
        apiRef.current?.getSceneElements() ??
        null;
      if (!elements) return;
      const fp = fingerprint(elements);
      const headStale = fp !== savedFpRef.current;
      const needsSnapshot = snapshot && dirtySinceSnapshotRef.current;
      if (!headStale && !needsSnapshot) return;
      savedFpRef.current = fp;
      if (snapshot) dirtySinceSnapshotRef.current = false;
      pendingElementsRef.current = null;
      void saveScene({
        id: diagramId,
        scene: { elements: elements as unknown[] },
        snapshot,
        ...(snapshot ? { summary: "Edição no canvas" } : {}),
      }).catch(() => {
        // Falha de save: reabre a janela de retry no próximo onChange.
        savedFpRef.current = "";
        dirtySinceSnapshotRef.current = true;
      });
    },
    [diagramId, saveScene],
  );
  const flushRef = useRef(flush);
  flushRef.current = flush;

  const handleChange = useCallback((elements: readonly unknown[]) => {
    const fp = fingerprint(elements);
    if (fp === savedFpRef.current) return;
    dirtySinceSnapshotRef.current = true;
    pendingElementsRef.current = elements;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(
      () => flushRef.current(false),
      SAVE_DEBOUNCE_MS,
    );
  }, []);

  // Flush com snapshot no blur da janela e no unmount (troca de diagrama).
  useEffect(() => {
    const onBlur = () => flushRef.current(true);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("blur", onBlur);
      flushRef.current(true);
    };
  }, []);

  const applyRemote = useCallback(async (remote: RemoteScene) => {
    const api = apiRef.current;
    if (!api) return;
    const utils = await loadExcalidrawUtils();
    const restored = utils.restoreElements(
      remote.scene.elements as Parameters<typeof utils.restoreElements>[0],
      null,
    );
    // Marca como "persistido" ANTES do updateScene: o onChange disparado pela
    // aplicação não deve reagendar save (seria eco local do estado remoto).
    savedFpRef.current = fingerprint(restored);
    dirtySinceSnapshotRef.current = false;
    pendingElementsRef.current = null;
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    api.updateScene({
      elements: restored,
      captureUpdate: utils.CaptureUpdateAction.NEVER,
    });
  }, []);

  // Broadcast de cena nova (remoteScene do store).
  const lastRemoteNonceRef = useRef(0);
  useEffect(() => {
    if (!remoteScene || remoteScene.nonce === lastRemoteNonceRef.current)
      return;
    lastRemoteNonceRef.current = remoteScene.nonce;
    const remoteFp = fingerprint(remoteScene.scene.elements);
    // Eco do nosso próprio save: fingerprint igual ao que salvamos → ignora.
    if (remoteFp === savedFpRef.current) return;
    const localPending =
      timerRef.current !== null ||
      (apiRef.current !== null &&
        fingerprint(apiRef.current.getSceneElements()) !== savedFpRef.current);
    if (localPending) {
      // Edição local em andamento: não sobrescreve — oferece recarregar.
      setConflict(remoteScene);
      return;
    }
    void applyRemote(remoteScene).then(() => {
      showToast({ title: "Atualizado pelo Claude", durationMs: 3500 });
    });
  }, [remoteScene, applyRemote]);

  return (
    <div className="flex h-full flex-1 flex-col overflow-hidden">
      <DiagramToolbar diagram={diagram} excalidrawAPI={excalidrawAPI} />

      {conflict && (
        <div className="flex items-center justify-between gap-3 border-b border-[var(--color-border)] bg-[color-mix(in_srgb,var(--color-warning,#e0a458)_14%,transparent)] px-4 py-2 text-xs text-[var(--color-text)]">
          <span>
            O Claude atualizou este diagrama enquanto você editava. Recarregar
            descarta suas mudanças locais.
          </span>
          <div className="flex shrink-0 items-center gap-2">
            <Button variant="ghost" onClick={() => setConflict(null)}>
              Manter as minhas
            </Button>
            <Button
              onClick={() => {
                const remote = conflict;
                setConflict(null);
                void applyRemote(remote);
              }}
            >
              Recarregar
            </Button>
          </div>
        </div>
      )}

      <div className="relative min-h-0 flex-1">
        <Suspense
          fallback={
            <div className="flex h-full items-center justify-center text-sm text-[var(--color-text-dim)]">
              <span className="animate-pulse">Carregando editor…</span>
            </div>
          }
        >
          <LazyExcalidraw
            excalidrawAPI={(api) => setExcalidrawAPI(api)}
            theme="dark"
            initialData={initialDataPromise}
            onChange={handleChange}
          />
        </Suspense>
      </div>
    </div>
  );
}
