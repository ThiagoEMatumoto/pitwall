import { useMemo } from "react";
import { Check, X } from "lucide-react";
import { Icon } from "@/components/ui/Icon";
import { useVideosStore } from "@/store/videosStore";

export function BrandKitPanel() {
  const project = useVideosStore((s) => s.selected);
  const brandKits = useVideosStore((s) => s.brandKits);
  const loading = useVideosStore((s) => s.libraryLoading);
  const error = useVideosStore((s) => s.libraryError);

  const kit = useMemo(
    () => brandKits.find((b) => b.id === project?.brandKitId) ?? null,
    [brandKits, project],
  );

  if (error) {
    return (
      <p className="px-6 py-8 text-sm text-[var(--color-danger)]">{error}</p>
    );
  }

  if (loading && brandKits.length === 0) {
    return (
      <p className="px-6 py-8 text-sm text-[var(--color-text-dim)]">
        Carregando marca…
      </p>
    );
  }

  if (!kit) {
    return (
      <p className="max-w-xl px-6 py-8 text-sm text-[var(--color-text-dim)]">
        Esta peça não tem brand kit. O brand kit é reusado por todas as peças de
        uma marca — normalmente ela o herda do template.
      </p>
    );
  }

  const palette = Object.entries(kit.tokens.palette);
  const typography = Object.entries(kit.tokens.typography).filter(
    (entry): entry is [string, string] => Boolean(entry[1]),
  );
  const voices = Object.entries(kit.ttsVoices);

  return (
    <div className="flex-1 overflow-y-auto px-6 py-4">
      <h3 className="mb-4 text-sm font-semibold text-[var(--color-text)]">
        {kit.name}
      </h3>

      <section className="mb-5">
        <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-[var(--color-text-dim)]">
          Paleta
        </p>
        {palette.length === 0 ? (
          <p className="text-sm text-[var(--color-text-dim)]">
            Sem cores definidas.
          </p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {palette.map(([name, color]) => (
              <div
                key={name}
                className="flex items-center gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5"
              >
                {/* A cor vem do dado da marca, não do tema do app — por isso é
                    o único lugar da área com cor literal, vinda do banco. */}
                <span
                  className="h-5 w-5 rounded border border-[var(--color-border)]"
                  style={{ background: color }}
                />
                <span className="text-xs text-[var(--color-text)]">{name}</span>
                <span className="font-mono text-[11px] text-[var(--color-text-dim)]">
                  {color}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="mb-5">
        <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-[var(--color-text-dim)]">
          Tipografia
        </p>
        {typography.length === 0 ? (
          <p className="text-sm text-[var(--color-text-dim)]">
            Sem tipografia definida.
          </p>
        ) : (
          <ul className="flex flex-col gap-1">
            {typography.map(([role, family]) => (
              <li key={role} className="flex items-baseline gap-2 text-sm">
                <span className="w-16 shrink-0 text-[11px] text-[var(--color-text-dim)]">
                  {role}
                </span>
                <span className="text-[var(--color-text)]">{family}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mb-5">
        <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-[var(--color-text-dim)]">
          Tom de voz
        </p>
        <p className="max-w-2xl whitespace-pre-wrap text-sm text-[var(--color-text)]">
          {kit.toneOfVoice || "Não descrito."}
        </p>
      </section>

      <section className="mb-5 grid gap-3 sm:grid-cols-2">
        <div>
          <p className="mb-2 flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-[var(--color-success)]">
            <Icon as={Check} size={12} /> Fazer
          </p>
          {kit.doDont.do.length === 0 ? (
            <p className="text-sm text-[var(--color-text-dim)]">—</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {kit.doDont.do.map((item) => (
                <li key={item} className="text-sm text-[var(--color-text)]">
                  {item}
                </li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <p className="mb-2 flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-[var(--color-danger)]">
            <Icon as={X} size={12} /> Não fazer
          </p>
          {kit.doDont.dont.length === 0 ? (
            <p className="text-sm text-[var(--color-text-dim)]">—</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {kit.doDont.dont.map((item) => (
                <li key={item} className="text-sm text-[var(--color-text)]">
                  {item}
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      <section>
        <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-[var(--color-text-dim)]">
          Vozes de TTS
        </p>
        {voices.length === 0 ? (
          <p className="max-w-xl text-sm text-[var(--color-text-dim)]">
            Sem voz preferida por locale — a geração de narração vai exigir uma
            voz explícita.
          </p>
        ) : (
          <ul className="flex flex-col gap-1">
            {voices.map(([loc, voiceId]) => (
              <li key={loc} className="flex items-baseline gap-2 text-sm">
                <span className="w-16 shrink-0 text-[11px] text-[var(--color-text-dim)]">
                  {loc}
                </span>
                <span className="font-mono text-xs text-[var(--color-text)]">
                  {voiceId}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
