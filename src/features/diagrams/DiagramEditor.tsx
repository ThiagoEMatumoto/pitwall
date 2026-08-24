import {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  ExcalidrawImperativeAPI,
  LibraryItems,
} from "@excalidraw/excalidraw/types";
import type { Diagram } from "../../../shared/types/ipc";
import type { RemoteScene } from "@/store/diagramsStore";
import { useDiagramsStore } from "@/store/diagramsStore";
import { diagramsApi } from "@/lib/ipc";
import { showToast } from "@/features/notifications/toast-store";
import { Button } from "@/components/ui/Button";
import { LazyExcalidraw, loadExcalidrawUtils } from "./excalidraw-lazy";
import {
  fromExcalidrawLibraryItems,
  toExcalidrawLibraryItems,
} from "./library-convert";
import { DiagramToolbar } from "./DiagramToolbar";

const SAVE_DEBOUNCE_MS = 800;

// Identidade barata da cena: id+version de cada elemento. É o que decide se um
// onChange é edição real (Excalidraw bumpa version a cada mutação) e se um
// broadcast é eco do nosso próprio save.
// Fingerprint BARATO por versão de elemento: detecta "algo mudou" no
// onChange sem serializar a cena. NÃO é estável entre canvas e banco
// (restoreElements reseta version) — nunca usar pra comparar os dois lados.
// Enquadra o conteúdo com zoom no máximo em 100% (fitToViewport nativo
// aplica num frame posterior e estoura 100% em cenas pequenas).
function frameContent(
  api: ExcalidrawImperativeAPI,
  elements: readonly unknown[],
): void {
  if (elements.length === 0) return;
  const st = api.getAppState();
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const e of elements as Array<{
    x: number;
    y: number;
    width: number;
    height: number;
    isDeleted?: boolean;
  }>) {
    if (e.isDeleted) continue;
    minX = Math.min(minX, e.x);
    minY = Math.min(minY, e.y);
    maxX = Math.max(maxX, e.x + e.width);
    maxY = Math.max(maxY, e.y + e.height);
  }
  if (!Number.isFinite(minX)) return;
  const bw = Math.max(1, maxX - minX);
  const bh = Math.max(1, maxY - minY);
  const zoom = Math.min(1, 0.85 * Math.min(st.width / bw, st.height / bh));
  api.updateScene({
    appState: {
      scrollX: st.width / (2 * zoom) - (minX + bw / 2),
      scrollY: st.height / (2 * zoom) - (minY + bh / 2),
      zoom: { value: zoom as unknown as never },
    },
  });
}

function versionFingerprint(elements: readonly unknown[]): string {
  return elements
    .map((e) => {
      const el = e as { id?: string; version?: number };
      return `${el.id}:${el.version}`;
    })
    .join("|");
}

// Campos voláteis que restoreElements/interações regeneram sem mudança real.
const VOLATILE_FIELDS = new Set([
  "version",
  "versionNonce",
  "updated",
  "seed",
  "index",
]);

// Fingerprint de CONTEÚDO: estável entre a cena do canvas e a cena crua do
// banco (pós-restore). É o que decide "precisa salvar?" e "o broadcast traz
// algo novo?".
function fingerprint(elements: readonly unknown[]): string {
  return elements
    .filter((e) => !(e as { isDeleted?: boolean }).isDeleted)
    .map((e) => {
      const el = e as Record<string, unknown>;
      const keys = Object.keys(el)
        .filter((k) => !VOLATILE_FIELDS.has(k))
        .sort();
      return JSON.stringify(keys.map((k) => [k, el[k]]));
    })
    .join("|");
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
  // Estado de sync exibido no toolbar. Espelha os refs de dirty/save (que
  // continuam donos da lógica) porque refs não re-renderizam o chip.
  const [syncStatus, setSyncStatus] = useState<"saved" | "saving" | "dirty">(
    "saved",
  );
  const [lastRemoteAt, setLastRemoteAt] = useState<number | null>(null);

  // Fingerprint do que está persistido (head). Começa na cena carregada.
  const savedFpRef = useRef(fingerprint(diagram.scene.elements));
  // Houve edição desde o último snapshot? (draft salvo ainda conta como dirty
  // até o próximo flush com snapshot:true, que grava a linha de histórico.)
  const dirtySinceSnapshotRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingElementsRef = useRef<readonly unknown[] | null>(null);
  const lastElementsRef = useRef<readonly unknown[] | null>(null);
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  apiRef.current = excalidrawAPI;

  const diagramId = diagram.id;

  // Hash da biblioteca persistida/aplicada (getLibraryItemsHash). É o que
  // decide se um onLibraryChange é edição real ou eco (boot, updateLibrary,
  // broadcast do nosso próprio replace).
  const libraryHashRef = useRef<number | null>(null);

  // initialData como Promise (suportado pelo Excalidraw): restoreElements vem
  // do mesmo chunk lazy, então não dá pra tê-lo sincronamente no 1º render.
  const initialDataPromise = useMemo(async () => {
    const utils = await loadExcalidrawUtils();
    // Biblioteca global entra junto da cena; o hash inicial marca o estado
    // persistido pra reconhecer o eco do onLibraryChange de boot.
    const libraryItems = toExcalidrawLibraryItems(
      await diagramsApi.library.get(),
    );
    libraryHashRef.current = utils.getLibraryItemsHash(libraryItems);
    return {
      elements: utils.restoreElements(
        diagram.scene.elements as Parameters<typeof utils.restoreElements>[0],
        null,
      ),
      libraryItems,
      // Sem viewBackgroundColor custom: o theme="dark" do Excalidraw INVERTE
      // as cores do canvas — um bg escuro aqui viraria claro na tela. Os
      // defaults da lib (bg branco, stroke #1e1e1e) renderizam certo no dark.
      appState: {},
      // Centraliza a câmera no conteúdo — sem isso, cena criada via MCP em
      // (0,0) abre escondida atrás da toolbar.
      scrollToContent: true,
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
      // NUNCA usar getSceneElements() aqui: no flush do unmount o Excalidraw
      // já desmontou e retorna [] — persistir isso apagaria a cena inteira.
      // lastElementsRef guarda o último onChange e sobrevive ao teardown.
      const elements =
        pendingElementsRef.current ?? lastElementsRef.current ?? null;
      if (!elements) return;
      const fp = fingerprint(elements);
      const headStale = fp !== savedFpRef.current;
      const needsSnapshot = snapshot && dirtySinceSnapshotRef.current;
      if (!headStale && !needsSnapshot) return;
      savedFpRef.current = fp;
      if (snapshot) dirtySinceSnapshotRef.current = false;
      pendingElementsRef.current = null;
      setSyncStatus("saving");
      void saveScene({
        id: diagramId,
        scene: { elements: elements as unknown[] },
        snapshot,
        ...(snapshot ? { summary: "Edição no canvas" } : {}),
      })
        .then(() => {
          // Edição nova durante o save em voo reagendou o debounce → o
          // conteúdo do canvas ainda não está persistido.
          setSyncStatus(timerRef.current ? "dirty" : "saved");
        })
        .catch((err) => {
          // Falha de save: reabre a janela de retry no próximo onChange.
          savedFpRef.current = "";
          dirtySinceSnapshotRef.current = true;
          setSyncStatus("dirty");
          showToast({
            title: "Falha ao salvar diagrama",
            body: err instanceof Error ? err.message : String(err),
          });
        });
    },
    [diagramId, saveScene],
  );
  const flushRef = useRef(flush);
  flushRef.current = flush;

  const lastVersionFpRef = useRef("");
  const handleChange = useCallback((elements: readonly unknown[]) => {
    lastElementsRef.current = elements;
    // Pré-filtro barato: seleção/zoom não bumpam version de elemento.
    const vfp = versionFingerprint(elements);
    if (vfp === lastVersionFpRef.current) return;
    lastVersionFpRef.current = vfp;
    const fp = fingerprint(elements);
    if (fp === savedFpRef.current) return;
    dirtySinceSnapshotRef.current = true;
    setSyncStatus("dirty");
    pendingElementsRef.current = elements;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(
      () => flushRef.current(false),
      SAVE_DEBOUNCE_MS,
    );
  }, []);

  // Persistência da biblioteca: o Excalidraw manda o conjunto INTEIRO a cada
  // mudança (adicionar/remover/reordenar no painel). replace regrava tudo.
  const handleLibraryChange = useCallback((items: LibraryItems) => {
    void (async () => {
      const utils = await loadExcalidrawUtils();
      const hash = utils.getLibraryItemsHash(items);
      // Eco (boot, updateLibrary aplicado por nós, broadcast do nosso save).
      if (hash === libraryHashRef.current) return;
      libraryHashRef.current = hash;
      try {
        await diagramsApi.library.replace(fromExcalidrawLibraryItems(items));
      } catch (err) {
        // Falha de save: reabre a janela de retry no próximo onLibraryChange.
        libraryHashRef.current = null;
        showToast({
          title: "Falha ao salvar biblioteca de shapes",
          body: err instanceof Error ? err.message : String(err),
        });
      }
    })();
  }, []);

  // Broadcast de biblioteca nova (install via URL/MCP, replace de outra
  // janela) → aplica no editor aberto, a menos que seja eco do nosso replace.
  const remoteLibrary = useDiagramsStore((s) => s.remoteLibrary);
  const lastLibraryNonceRef = useRef(0);
  useEffect(() => {
    if (!remoteLibrary || remoteLibrary.nonce === lastLibraryNonceRef.current)
      return;
    lastLibraryNonceRef.current = remoteLibrary.nonce;
    void (async () => {
      const api = apiRef.current;
      if (!api) return;
      const utils = await loadExcalidrawUtils();
      const libraryItems = toExcalidrawLibraryItems(remoteLibrary.items);
      const hash = utils.getLibraryItemsHash(libraryItems);
      if (hash === libraryHashRef.current) return;
      // Marca ANTES do updateLibrary: o onLibraryChange disparado pela
      // aplicação não deve regravar (seria eco local do estado remoto).
      libraryHashRef.current = hash;
      await api.updateLibrary({ libraryItems, merge: false });
    })();
  }, [remoteLibrary]);

  // Enquadra o conteúdo na abertura: initialData.scrollToContent centraliza
  // mas mantém zoom 100% — diagrama largo abre estourando a viewport.
  useEffect(() => {
    if (!excalidrawAPI) return;
    const t = setTimeout(
      () => frameContent(excalidrawAPI, excalidrawAPI.getSceneElements()),
      50,
    );
    return () => clearTimeout(t);
  }, [excalidrawAPI]);

  // Flush com snapshot no blur da janela e no unmount (troca de diagrama).
  useEffect(() => {
    const onBlur = () => flushRef.current(true);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("blur", onBlur);
      flushRef.current(true);
    };
  }, []);

  // Um remoto foi aplicado desde o último focus? Janela em background tem o
  // repaint throttlado pelo Electron — ao focar, força um refresh extra.
  const remoteSinceFocusRef = useRef(false);

  const applyRemote = useCallback(async (remote: RemoteScene) => {
    const api = apiRef.current;
    if (!api) return false;
    const utils = await loadExcalidrawUtils();
    const restored = utils.restoreElements(
      remote.scene.elements as Parameters<typeof utils.restoreElements>[0],
      null,
    );
    // Compara APÓS o restore: o fingerprint dos elementos crus do banco
    // difere dos restaurados (restoreElements normaliza campos), então um
    // echo de rename/thumbnail chegaria aqui como "mudança" e causaria
    // updateScene + zoom desnecessários.
    const restoredFp = fingerprint(restored);
    const currentFp = fingerprint(api.getSceneElements());
    if (restoredFp === currentFp) {
      savedFpRef.current = restoredFp;
      setSyncStatus("saved");
      return false;
    }
    // Marca como "persistido" ANTES do updateScene: o onChange disparado pela
    // aplicação não deve reagendar save (seria eco local do estado remoto).
    savedFpRef.current = restoredFp;
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
    // Elementos novos podem ter entrado fora do viewport (ex.: patch do
    // Claude adicionando um nó) — re-enquadra sem animação brusca. Nunca
    // além de 100%: fitToViewport em cena pequena daria zoom gigante.
    frameContent(api, restored);
    // Repaint imediato: com a janela em background o Electron throttla o
    // repaint e o canvas mostraria a cena antiga até o próximo focus.
    api.refresh();
    remoteSinceFocusRef.current = true;
    setSyncStatus("saved");
    setLastRemoteAt(Date.now());
    return true;
  }, []);

  // Ao focar a janela, repinta de novo se um remoto chegou em background —
  // cinto e suspensório contra o throttling de repaint do Electron.
  useEffect(() => {
    const onFocus = () => {
      if (!remoteSinceFocusRef.current) return;
      remoteSinceFocusRef.current = false;
      apiRef.current?.refresh();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  // Salvar manual (botão do toolbar e Ctrl+S): flush imediato com snapshot,
  // cancelando o debounce pendente.
  const saveNow = useCallback(() => flushRef.current(true), []);

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
    void applyRemote(remoteScene).then((applied) => {
      if (applied)
        showToast({ title: "Atualizado pelo Claude", durationMs: 3500 });
    });
  }, [remoteScene, applyRemote]);

  return (
    <div
      className="flex h-full flex-1 flex-col overflow-hidden"
      onKeyDown={(e) => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
          e.preventDefault();
          saveNow();
        }
      }}
    >
      <DiagramToolbar
        diagram={diagram}
        excalidrawAPI={excalidrawAPI}
        syncState={{
          status: syncStatus,
          lastRemoteAt,
          version: diagram.version,
        }}
        onSaveNow={saveNow}
      />

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
            onLibraryChange={handleLibraryChange}
          />
        </Suspense>
      </div>
    </div>
  );
}
