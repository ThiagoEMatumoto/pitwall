import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Plus, Trash2, Volume2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { useVideosStore } from "@/store/videosStore";
import {
  SCRIPT_KIND_LABEL,
  estimateSpeechSec,
  formatSeconds,
} from "./video-labels";
import type {
  VideoAsset,
  VideoScene,
  VideoScriptLine,
  VideoScriptLineKind,
} from "../../../shared/types/ipc";

interface DraftLine {
  key: string;
  sceneId: string;
  kind: VideoScriptLineKind;
  text: string;
}

let draftSeq = 0;

function toDraft(lines: VideoScriptLine[]): DraftLine[] {
  return lines.map((l) => ({
    key: `srv-${l.id}`,
    sceneId: l.sceneId,
    kind: l.kind,
    text: l.text,
  }));
}

// Assinatura do conteúdo (não dos ids): é o que diz se o rascunho divergiu do
// banco e se o banco mudou por baixo (Claude escrevendo pelo MCP).
function signature(lines: Array<Pick<DraftLine, "sceneId" | "kind" | "text">>) {
  return lines.map((l) => `${l.sceneId}|${l.kind}|${l.text}`).join("\n");
}

type AudioState = "none" | "stale" | "fresh";

/**
 * O áudio de uma cena casa com o texto pelo `textHash`. Divergiu o hash, o MP3
 * no disco é de uma versão anterior da fala — é isso que o aviso denuncia.
 */
function audioStateOf(
  saved: VideoScriptLine | undefined,
  asset: VideoAsset | undefined,
): AudioState {
  if (!asset) return "none";
  if (!saved) return "stale";
  return asset.hash === saved.textHash ? "fresh" : "stale";
}

export function ScriptEditor() {
  const project = useVideosStore((s) => s.selected);
  const locale = useVideosStore((s) => s.locale);
  const script = useVideosStore((s) => s.script);
  const assets = useVideosStore((s) => s.assets);
  const loading = useVideosStore((s) => s.scriptLoading);
  const error = useVideosStore((s) => s.scriptError);
  const saveScript = useVideosStore((s) => s.saveScript);
  const loadScript = useVideosStore((s) => s.loadScript);

  const [draft, setDraft] = useState<DraftLine[]>(() => toDraft(script));
  const [baseSig, setBaseSig] = useState(() => signature(script));
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const serverSig = useMemo(() => signature(script), [script]);
  const draftSig = useMemo(() => signature(draft), [draft]);
  const dirty = draftSig !== baseSig;
  const serverMoved = serverSig !== baseSig;

  // Adota o roteiro do banco quando não há edição local pendente. Com pendência
  // a edição vence e o banner oferece descartar — mesmo contrato do editor de
  // diagramas, que nunca engole texto digitado.
  useEffect(() => {
    if (!serverMoved || dirty) return;
    setDraft(toDraft(script));
    setBaseSig(serverSig);
  }, [serverMoved, dirty, script, serverSig]);

  // Linhas salvas agrupadas por cena, na ordem do banco: comparar posição a
  // posição é o que acende a borda "editado e ainda não salvo" no textarea.
  const savedByScene = useMemo(() => {
    const map = new Map<string, VideoScriptLine[]>();
    for (const l of script) {
      const list = map.get(l.sceneId) ?? [];
      list.push(l);
      map.set(l.sceneId, list);
    }
    return map;
  }, [script]);

  // Narração da cena naquele locale: é a chave que casa fala e MP3.
  const audioByScene = useMemo(() => {
    const map = new Map<string, VideoAsset>();
    for (const a of assets) {
      if (a.kind !== "audio" || !a.sceneId) continue;
      if (locale && a.locale !== locale) continue;
      const prev = map.get(a.sceneId);
      if (!prev || a.createdAt > prev.createdAt) map.set(a.sceneId, a);
    }
    return map;
  }, [assets, locale]);

  const scenes: VideoScene[] = useMemo(
    () => [...(project?.scenes ?? [])].sort((a, b) => a.ord - b.ord),
    [project],
  );

  function linesOf(sceneId: string): DraftLine[] {
    return draft.filter((l) => l.sceneId === sceneId);
  }

  function estimateOf(sceneId: string): number {
    const narration = linesOf(sceneId).filter((l) => l.kind === "narration");
    const asset = audioByScene.get(sceneId);
    const saved = script.find(
      (l) => l.sceneId === sceneId && l.kind === "narration",
    );
    // Áudio em dia: a duração REAL manda sobre o palpite de palavras/min.
    if (asset?.durationSec && audioStateOf(saved, asset) === "fresh") {
      return asset.durationSec;
    }
    return narration.reduce((a, l) => a + estimateSpeechSec(l.text), 0);
  }

  const totalEstimate = scenes.reduce((a, s) => a + estimateOf(s.sceneId), 0);
  const totalTarget = scenes.reduce((a, s) => a + s.targetSec, 0);

  function editLine(key: string, text: string) {
    setDraft((d) => d.map((l) => (l.key === key ? { ...l, text } : l)));
  }

  function addLine(sceneId: string, kind: VideoScriptLineKind) {
    const line: DraftLine = {
      key: `new-${++draftSeq}`,
      sceneId,
      kind,
      text: "",
    };
    // Insere logo depois da última linha da cena pra manter a ordem visual.
    setDraft((d) => {
      const last = d.map((l) => l.sceneId).lastIndexOf(sceneId);
      if (last === -1) return [...d, line];
      return [...d.slice(0, last + 1), line, ...d.slice(last + 1)];
    });
  }

  function removeLine(key: string) {
    setDraft((d) => d.filter((l) => l.key !== key));
  }

  async function save() {
    if (!project || !locale) return;
    setSaving(true);
    setSaveError(null);
    try {
      // `ord` é a posição dentro da cena — o store recalcula o textHash.
      const perScene = new Map<string, number>();
      const lines = draft.map((l) => {
        const ord = perScene.get(l.sceneId) ?? 0;
        perScene.set(l.sceneId, ord + 1);
        return { sceneId: l.sceneId, kind: l.kind, text: l.text, ord };
      });
      await saveScript({ projectId: project.id, locale, lines });
      setBaseSig(signature(lines));
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  if (!project || !locale) {
    return (
      <p className="px-6 py-8 text-sm text-[var(--color-text-dim)]">
        Escolha uma peça e um locale.
      </p>
    );
  }

  if (error) {
    return (
      <div className="px-6 py-8">
        <p className="text-sm text-[var(--color-danger)]">{error}</p>
        <Button
          variant="ghost"
          className="mt-3"
          onClick={() => void loadScript()}
        >
          Tentar de novo
        </Button>
      </div>
    );
  }

  if (loading && script.length === 0 && draft.length === 0) {
    return (
      <p className="px-6 py-8 text-sm text-[var(--color-text-dim)]">
        Carregando roteiro…
      </p>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between gap-3 border-b border-[var(--color-border)] px-6 py-3">
        <div className="flex items-baseline gap-3 text-xs">
          <span className="text-[var(--color-text-dim)]">
            Estimado{" "}
            <span className="tabular-nums text-[var(--color-text)]">
              {formatSeconds(totalEstimate)}
            </span>
          </span>
          <span
            className="tabular-nums"
            style={{
              color:
                totalEstimate > totalTarget * 1.15
                  ? "var(--color-warning)"
                  : "var(--color-text-dim)",
            }}
          >
            alvo {formatSeconds(totalTarget)}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {dirty && (
            <span className="text-[11px] text-[var(--color-warning)]">
              Não salvo
            </span>
          )}
          <Button
            onClick={() => void save()}
            disabled={!dirty}
            loading={saving}
          >
            Salvar roteiro
          </Button>
        </div>
      </div>

      {serverMoved && dirty && (
        <div className="flex items-center justify-between gap-3 border-b border-[var(--color-border)] bg-[color-mix(in_srgb,var(--color-warning)_12%,transparent)] px-6 py-2">
          <span className="text-xs text-[var(--color-text)]">
            O roteiro deste locale mudou no banco enquanto você editava.
          </span>
          <button
            type="button"
            onClick={() => {
              setDraft(toDraft(script));
              setBaseSig(serverSig);
            }}
            className="text-xs text-[var(--color-accent)] hover:underline"
          >
            Descartar minha edição
          </button>
        </div>
      )}

      {saveError && (
        <p className="border-b border-[var(--color-border)] px-6 py-2 text-sm text-[var(--color-danger)]">
          {saveError}
        </p>
      )}

      <div className="flex-1 overflow-y-auto px-6 py-4">
        {scenes.length === 0 ? (
          <p className="text-sm text-[var(--color-text-dim)]">
            Esta peça não tem cenas. Cenas vêm do blueprint do template — ou
            peça a uma sessão do Claude para desenhá-las.
          </p>
        ) : (
          <ul className="flex flex-col gap-3">
            {scenes.map((scene) => {
              const lines = linesOf(scene.sceneId);
              const estimate = estimateOf(scene.sceneId);
              const over = estimate > scene.targetSec * 1.15;
              const asset = audioByScene.get(scene.sceneId);
              const saved = script.find(
                (l) => l.sceneId === scene.sceneId && l.kind === "narration",
              );
              const audio = audioStateOf(saved, asset);
              return (
                <li
                  key={scene.id}
                  className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-3"
                >
                  <div className="mb-2 flex items-center justify-between gap-3">
                    <div className="flex min-w-0 items-baseline gap-2">
                      <span className="truncate font-mono text-xs text-[var(--color-accent)]">
                        {scene.sceneId}
                      </span>
                      <span className="truncate text-sm text-[var(--color-text)]">
                        {scene.role}
                      </span>
                    </div>
                    <div className="flex shrink-0 items-center gap-2 text-[11px]">
                      {audio === "stale" && (
                        <span
                          title="O texto mudou depois que o áudio foi gerado (textHash ≠ hash do asset)."
                          className="flex items-center gap-1 rounded-full border px-2 py-px"
                          style={{
                            color: "var(--color-warning)",
                            borderColor:
                              "color-mix(in srgb, var(--color-warning) 45%, transparent)",
                          }}
                        >
                          <Icon as={AlertTriangle} size={11} />
                          Áudio desatualizado
                        </span>
                      )}
                      {audio === "fresh" && (
                        <span
                          className="flex items-center gap-1 text-[var(--color-success)]"
                          title="Áudio em dia com o texto salvo."
                        >
                          <Icon as={Volume2} size={11} />
                          Áudio em dia
                        </span>
                      )}
                      {audio === "none" && (
                        <span className="text-[var(--color-text-dim)]">
                          Sem áudio
                        </span>
                      )}
                      <span
                        className="tabular-nums"
                        style={{
                          color: over
                            ? "var(--color-warning)"
                            : "var(--color-text-dim)",
                        }}
                        title="Estimado / alvo da cena"
                      >
                        {formatSeconds(estimate)} /{" "}
                        {formatSeconds(scene.targetSec)}
                      </span>
                    </div>
                  </div>

                  {scene.visual && (
                    <p className="mb-2 text-[11px] italic text-[var(--color-text-dim)]">
                      {scene.visual}
                    </p>
                  )}

                  <div className="flex flex-col gap-2">
                    {lines.map((line, i) => {
                      const savedLine = savedByScene.get(scene.sceneId)?.[i];
                      const changed = savedLine?.text !== line.text;
                      return (
                        <div key={line.key} className="flex items-start gap-2">
                          <span className="mt-2 w-16 shrink-0 text-[11px] text-[var(--color-text-dim)]">
                            {SCRIPT_KIND_LABEL[line.kind]}
                          </span>
                          <textarea
                            aria-label={`${SCRIPT_KIND_LABEL[line.kind]} — ${scene.sceneId}`}
                            value={line.text}
                            rows={line.kind === "narration" ? 2 : 1}
                            onChange={(e) => editLine(line.key, e.target.value)}
                            className={`min-h-0 flex-1 resize-y rounded-md border bg-[var(--color-bg)] px-2 py-1.5 text-sm text-[var(--color-text)] outline-none focus:border-[var(--color-accent)] ${
                              changed
                                ? "border-[var(--color-warning)]"
                                : "border-[var(--color-border)]"
                            }`}
                          />
                          <button
                            type="button"
                            title="Remover linha"
                            onClick={() => removeLine(line.key)}
                            className="mt-1.5 text-[var(--color-text-dim)] transition hover:text-[var(--color-danger)]"
                          >
                            <Icon as={Trash2} size={14} />
                          </button>
                        </div>
                      );
                    })}
                  </div>

                  <div className="mt-2 flex gap-3">
                    <button
                      type="button"
                      onClick={() => addLine(scene.sceneId, "narration")}
                      className="flex items-center gap-1 text-[11px] text-[var(--color-text-dim)] transition hover:text-[var(--color-text)]"
                    >
                      <Icon as={Plus} size={11} /> Narração
                    </button>
                    <button
                      type="button"
                      onClick={() => addLine(scene.sceneId, "on_screen")}
                      className="flex items-center gap-1 text-[11px] text-[var(--color-text-dim)] transition hover:text-[var(--color-text)]"
                    >
                      <Icon as={Plus} size={11} /> Texto de tela
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
