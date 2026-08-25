import { useMemo, useState } from "react";
import { Users, Palette, Film } from "lucide-react";
import { Dialog } from "@/components/ui/Dialog";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { useVideosStore } from "@/store/videosStore";
import { formatSeconds, kindLabel, slugify } from "./video-labels";
import type { VideoTemplate } from "../../../shared/types/ipc";

interface Props {
  open: boolean;
  onClose: () => void;
}

function parseLocales(raw: string): string[] {
  return raw
    .split(",")
    .map((l) => l.trim())
    .filter(Boolean);
}

export function NewProjectDialog({ open, onClose }: Props) {
  const templates = useVideosStore((s) => s.templates);
  const brandKits = useVideosStore((s) => s.brandKits);
  const characters = useVideosStore((s) => s.characters);
  const libraryLoading = useVideosStore((s) => s.libraryLoading);
  const libraryError = useVideosStore((s) => s.libraryError);
  const createProject = useVideosStore((s) => s.createProject);

  const [templateId, setTemplateId] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [slug, setSlug] = useState("");
  const [localesRaw, setLocalesRaw] = useState("pt-BR");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Agrupa por categoria: é o eixo do reuso — quem vai criar uma peça escolhe
  // primeiro "que tipo de peça é essa", não um template solto numa lista longa.
  const groups = useMemo(() => {
    const byKind = new Map<string, VideoTemplate[]>();
    for (const t of templates) {
      const list = byKind.get(t.kind) ?? [];
      list.push(t);
      byKind.set(t.kind, list);
    }
    return [...byKind.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [templates]);

  const template = useMemo(
    () => templates.find((t) => t.id === templateId) ?? null,
    [templates, templateId],
  );

  const brandKit = useMemo(
    () => brandKits.find((b) => b.id === template?.brandKitId) ?? null,
    [brandKits, template],
  );

  const blueprintTotalSec = useMemo(
    () => (template?.sceneBlueprint ?? []).reduce((a, s) => a + s.targetSec, 0),
    [template],
  );

  function pickTemplate(t: VideoTemplate | null) {
    setTemplateId(t?.id ?? null);
    if (!t) return;
    // Os locales do brand kit do template são os que já têm voz de TTS — é o
    // palpite honesto de "em que idiomas essa peça nasce".
    const kit = brandKits.find((b) => b.id === t.brandKitId);
    const fromKit = Object.keys(kit?.ttsVoices ?? {});
    if (fromKit.length > 0) setLocalesRaw(fromKit.join(", "));
  }

  function changeTitle(value: string) {
    setTitle(value);
    if (!slugTouched) setSlug(slugify(value));
  }

  const locales = parseLocales(localesRaw);
  const canCreate =
    title.trim().length > 0 && slug.trim().length > 0 && locales.length > 0;

  async function submit() {
    if (!canCreate) return;
    setCreating(true);
    setError(null);
    try {
      await createProject({
        slug: slug.trim(),
        title: title.trim(),
        kind: template?.kind ?? "promo",
        templateId,
        locales,
      });
      onClose();
      setTitle("");
      setSlug("");
      setSlugTouched(false);
      setTemplateId(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Nova peça"
      widthClassName="w-[52rem]"
      footer={
        <div className="flex items-center justify-between gap-3">
          <span className="text-xs text-[var(--color-text-dim)]">
            {template
              ? `Herda de “${template.name}”`
              : "Sem template: a peça nasce vazia."}
          </span>
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancelar
            </Button>
            <Button
              onClick={() => void submit()}
              disabled={!canCreate}
              loading={creating}
            >
              Criar peça
            </Button>
          </div>
        </div>
      }
    >
      <div className="flex min-h-0 flex-1 gap-4 overflow-hidden">
        <div className="flex w-64 shrink-0 flex-col overflow-y-auto rounded-lg border border-[var(--color-border)]">
          {libraryError ? (
            <p className="px-3 py-4 text-sm text-[var(--color-danger)]">
              {libraryError}
            </p>
          ) : libraryLoading && templates.length === 0 ? (
            <p className="px-3 py-4 text-sm text-[var(--color-text-dim)]">
              Carregando templates…
            </p>
          ) : templates.length === 0 ? (
            <p className="px-3 py-4 text-sm text-[var(--color-text-dim)]">
              Nenhum template ainda. Peça a uma sessão do Claude para criar um —
              é ele que carrega o estilo, o elenco e as cenas da categoria.
            </p>
          ) : (
            groups.map(([kind, list]) => (
              <div key={kind}>
                <p className="sticky top-0 bg-[var(--color-surface-2)] px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-[var(--color-text-dim)]">
                  {kindLabel(kind)}
                </p>
                {list.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => pickTemplate(t)}
                    className={`flex w-full flex-col gap-0.5 border-b border-[var(--color-border)] px-3 py-2 text-left transition ${
                      t.id === templateId
                        ? "bg-[var(--color-surface-2)] shadow-[inset_2px_0_0_var(--color-accent)]"
                        : "hover:bg-[var(--color-surface-2)]/60"
                    }`}
                  >
                    <span className="truncate text-sm text-[var(--color-text)]">
                      {t.name}
                    </span>
                    <span className="text-[11px] text-[var(--color-text-dim)]">
                      {t.sceneBlueprint.length} cenas
                    </span>
                  </button>
                ))}
              </div>
            ))
          )}
          <button
            type="button"
            onClick={() => pickTemplate(null)}
            className={`mt-auto border-t border-[var(--color-border)] px-3 py-2 text-left text-xs transition ${
              templateId === null
                ? "bg-[var(--color-surface-2)] text-[var(--color-text)]"
                : "text-[var(--color-text-dim)] hover:bg-[var(--color-surface-2)]/60"
            }`}
          >
            Começar em branco
          </button>
        </div>

        <div className="flex min-w-0 flex-1 flex-col gap-3 overflow-y-auto">
          <Input
            label="Título"
            aria-label="Título"
            value={title}
            onChange={(e) => changeTitle(e.target.value)}
            placeholder="Pitwall — promo de lançamento"
          />
          <Input
            label="Slug"
            aria-label="Slug"
            value={slug}
            onChange={(e) => {
              setSlugTouched(true);
              setSlug(slugify(e.target.value));
            }}
            placeholder="pitwall-promo"
          />
          <Input
            label="Locales (separados por vírgula)"
            aria-label="Locales"
            value={localesRaw}
            onChange={(e) => setLocalesRaw(e.target.value)}
            placeholder="pt-BR, en-US"
          />

          <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] p-3">
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-[var(--color-text-dim)]">
              O que a peça herda
            </p>
            {!template ? (
              <p className="text-sm text-[var(--color-text-dim)]">
                Sem template a peça nasce sem estilo, sem elenco e sem cenas — é
                o caminho de exceção. Escolha um template à esquerda.
              </p>
            ) : (
              <div className="flex flex-col gap-3">
                <div className="flex items-start gap-2">
                  <Icon as={Palette} size={14} />
                  <div className="min-w-0">
                    <p className="text-sm text-[var(--color-text)]">
                      {brandKit ? brandKit.name : "Sem brand kit"}
                    </p>
                    {brandKit && (
                      <div className="mt-1 flex flex-wrap items-center gap-1">
                        {Object.entries(brandKit.tokens.palette)
                          .slice(0, 8)
                          .map(([name, color]) => (
                            <span
                              key={name}
                              title={`${name} · ${color}`}
                              className="h-3.5 w-3.5 rounded-full border border-[var(--color-border)]"
                              style={{ background: color }}
                            />
                          ))}
                      </div>
                    )}
                  </div>
                </div>

                <div className="flex items-start gap-2">
                  <Icon as={Users} size={14} />
                  <div className="min-w-0">
                    {template.defaultCast.length === 0 ? (
                      <p className="text-sm text-[var(--color-text-dim)]">
                        Sem elenco default
                      </p>
                    ) : (
                      <div className="flex flex-wrap gap-1">
                        {template.defaultCast.map((slot) => {
                          const c = characters.find(
                            (x) => x.id === slot.characterId,
                          );
                          return (
                            <span
                              key={`${slot.characterId}-${slot.roleInPiece}`}
                              className="rounded-full border border-[var(--color-border)] px-2 py-px text-[11px] text-[var(--color-text-dim)]"
                            >
                              {c?.name ?? slot.characterId} · {slot.roleInPiece}
                            </span>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>

                <div className="flex items-start gap-2">
                  <Icon as={Film} size={14} />
                  <div className="min-w-0 flex-1">
                    <p className="mb-1 text-sm text-[var(--color-text)]">
                      {template.sceneBlueprint.length} cenas ·{" "}
                      <span className="tabular-nums">
                        {formatSeconds(blueprintTotalSec)}
                      </span>
                    </p>
                    <ul className="flex flex-col gap-0.5">
                      {template.sceneBlueprint.map((s) => (
                        <li
                          key={s.sceneId}
                          className="flex items-baseline justify-between gap-2 text-[11px] text-[var(--color-text-dim)]"
                        >
                          <span className="truncate font-mono">
                            {s.sceneId}
                          </span>
                          <span className="truncate">{s.role}</span>
                          <span className="shrink-0 tabular-nums">
                            {formatSeconds(s.targetSec)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              </div>
            )}
          </div>

          {error && (
            <p className="text-sm text-[var(--color-danger)]">{error}</p>
          )}
        </div>
      </div>
    </Dialog>
  );
}
