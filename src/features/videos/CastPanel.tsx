import { useEffect, useState } from "react";
import { ImageIcon, Trash2, UserPlus } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { useVideosStore } from "@/store/videosStore";
import type { VideoCastSlot } from "../../../shared/types/ipc";

export function CastPanel() {
  const project = useVideosStore((s) => s.selected);
  const characters = useVideosStore((s) => s.characters);
  const detail = useVideosStore((s) => s.characterDetail);
  const libraryLoading = useVideosStore((s) => s.libraryLoading);
  const libraryError = useVideosStore((s) => s.libraryError);
  const ensureCharacter = useVideosStore((s) => s.ensureCharacter);
  const setCast = useVideosStore((s) => s.setCast);

  const [addingId, setAddingId] = useState("");
  const [role, setRole] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cast = project?.cast ?? [];

  // As refs aprovadas não vêm no list() (é meta leve) — puxamos o personagem
  // inteiro só de quem está escalado, que é quem entra em prompt.
  useEffect(() => {
    for (const entry of cast) void ensureCharacter(entry.characterId);
  }, [cast, ensureCharacter]);

  async function commit(next: VideoCastSlot[]) {
    if (!project) return;
    setBusy(true);
    setError(null);
    try {
      await setCast({ projectId: project.id, cast: next });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function add() {
    if (!addingId) return;
    const next: VideoCastSlot[] = [
      ...cast.map((c) => ({
        characterId: c.characterId,
        roleInPiece: c.roleInPiece,
      })),
      { characterId: addingId, roleInPiece: role.trim() || "elenco" },
    ];
    setAddingId("");
    setRole("");
    void commit(next);
  }

  function remove(characterId: string, roleInPiece: string) {
    void commit(
      cast
        .filter(
          (c) =>
            !(c.characterId === characterId && c.roleInPiece === roleInPiece),
        )
        .map((c) => ({
          characterId: c.characterId,
          roleInPiece: c.roleInPiece,
        })),
    );
  }

  if (!project) return null;

  const available = characters.filter(
    (c) => !cast.some((e) => e.characterId === c.id),
  );

  return (
    <div className="flex-1 overflow-y-auto px-6 py-4">
      <p className="mb-4 max-w-2xl text-xs text-[var(--color-text-dim)]">
        O texto canônico do personagem é injetado, literal, em todo prompt de
        imagem dele — junto das refs aprovadas. É isso (e não a sorte do
        gerador) que faz ele parecer o mesmo nas oito cenas.
      </p>

      {error && (
        <p className="mb-3 text-sm text-[var(--color-danger)]">{error}</p>
      )}

      {libraryError ? (
        <p className="text-sm text-[var(--color-danger)]">{libraryError}</p>
      ) : libraryLoading && characters.length === 0 ? (
        <p className="text-sm text-[var(--color-text-dim)]">
          Carregando biblioteca…
        </p>
      ) : cast.length === 0 ? (
        <p className="mb-4 text-sm text-[var(--color-text-dim)]">
          Nenhum personagem escalado. O elenco vem do template — ou escale um da
          biblioteca abaixo.
        </p>
      ) : (
        <ul className="mb-5 flex flex-col gap-3">
          {cast.map((entry) => {
            const meta =
              detail[entry.characterId] ??
              characters.find((c) => c.id === entry.characterId);
            const refs = detail[entry.characterId]?.refs ?? [];
            const approved = refs.filter((r) => r.isApproved).length;
            return (
              <li
                key={`${entry.characterId}-${entry.roleInPiece}`}
                className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-3"
              >
                <div className="mb-2 flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-[var(--color-text)]">
                      {meta?.name ?? entry.characterId}
                    </p>
                    <p className="text-[11px] text-[var(--color-text-dim)]">
                      {entry.roleInPiece}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <span
                      className="flex items-center gap-1 text-[11px]"
                      style={{
                        color:
                          approved > 0
                            ? "var(--color-success)"
                            : "var(--color-warning)",
                      }}
                      title="Imagens aprovadas passadas como referência ao gerador"
                    >
                      <Icon as={ImageIcon} size={11} />
                      {approved} ref{approved === 1 ? "" : "s"}
                    </span>
                    <button
                      type="button"
                      title="Tirar do elenco"
                      disabled={busy}
                      onClick={() =>
                        remove(entry.characterId, entry.roleInPiece)
                      }
                      className="text-[var(--color-text-dim)] transition hover:text-[var(--color-danger)] disabled:opacity-50"
                    >
                      <Icon as={Trash2} size={14} />
                    </button>
                  </div>
                </div>

                {meta && (
                  <>
                    <p className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-2 font-mono text-[11px] leading-relaxed text-[var(--color-text-dim)]">
                      {meta.visualSpec.canonical || "Sem texto canônico ainda."}
                    </p>
                    {meta.visualSpec.invariants.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-1">
                        {meta.visualSpec.invariants.map((inv) => (
                          <span
                            key={inv}
                            className="rounded-full border border-[var(--color-border)] px-2 py-px text-[11px] text-[var(--color-text-dim)]"
                          >
                            {inv}
                          </span>
                        ))}
                      </div>
                    )}
                    {meta.visualSpec.negative.length > 0 && (
                      <div className="mt-1 flex flex-wrap gap-1">
                        {meta.visualSpec.negative.map((neg) => (
                          <span
                            key={neg}
                            title="Nunca deve aparecer (negative prompt)"
                            className="rounded-full px-2 py-px text-[11px]"
                            style={{
                              color: "var(--color-danger)",
                              border:
                                "1px solid color-mix(in srgb, var(--color-danger) 40%, transparent)",
                            }}
                          >
                            ✕ {neg}
                          </span>
                        ))}
                      </div>
                    )}
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <div className="flex flex-wrap items-end gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] p-3">
        <label className="flex flex-col gap-1 text-xs text-[var(--color-text-dim)]">
          Personagem
          <select
            value={addingId}
            onChange={(e) => setAddingId(e.target.value)}
            className="min-w-48 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-sm text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]"
          >
            <option value="">
              {available.length === 0
                ? "Nada disponível na biblioteca"
                : "Escolher…"}
            </option>
            {available.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-[var(--color-text-dim)]">
          Papel nesta peça
          <input
            value={role}
            onChange={(e) => setRole(e.target.value)}
            placeholder="protagonista"
            className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-sm text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]"
          />
        </label>
        <Button onClick={add} disabled={!addingId || busy}>
          <Icon as={UserPlus} size={14} />
          Escalar
        </Button>
      </div>
    </div>
  );
}
