import { Archive, Bot, Copy } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import { relativeTime } from '@/lib/time'
import type { FeatureWithStats } from '../../../shared/types/ipc'

interface Props {
  features: FeatureWithStats[]
  suspectIds: ReadonlySet<string>
  onSelect: (id: string) => void
  onArchive: (id: string) => void
  onDismissDuplicate: (id: string) => void
}

// Fila de triagem: a resposta ao "algumas registradas, outras duplicadas ou
// esquecidas". Cada linha diz POR QUE está aqui e oferece os dois vereditos
// baratos — abrir (pra decidir com o dossiê na frente) ou arquivar. Linhas
// densas de propósito: o valor está em resolver várias de uma sentada.
export function FeatureTriage({
  features,
  suspectIds,
  onSelect,
  onArchive,
  onDismissDuplicate,
}: Props) {
  return (
    <section data-testid="feature-triage">
      <header className="mb-3">
        <h2 className="text-sm font-semibold text-[var(--color-text)]">Fila de triagem</h2>
        <p className="mt-0.5 text-xs text-[var(--color-text-dim)]">
          Features criadas por agentes e possíveis duplicatas. Abra pra decidir com o dossiê na
          frente, ou arquive — arquivar não apaga nada.
        </p>
      </header>

      {features.length === 0 ? (
        <p className="py-12 text-center text-sm text-[var(--color-text-dim)]">
          Fila vazia: nada auto-criado ou repetido esperando decisão.
        </p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {features.map((f) => (
            <li
              key={f.id}
              data-testid="feature-triage-row"
              data-feature-id={f.id}
              className="flex items-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm text-[var(--color-text)]">{f.title}</span>
                <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[10px] text-[var(--color-text-dim)]">
                  <span>{relativeTime(f.lastRecordAt ?? f.updatedAt)}</span>
                  <span aria-hidden>·</span>
                  <span>{f.recordCount === 0 ? 'sem registros' : `${f.recordCount} registros`}</span>
                </span>
              </span>

              {suspectIds.has(f.id) && (
                <>
                  <ReasonChip icon={Copy} color="var(--color-warning)" label="possível duplicata" />
                  <button
                    type="button"
                    data-testid="feature-triage-dismiss"
                    onClick={() => onDismissDuplicate(f.id)}
                    className="shrink-0 rounded-md border border-[var(--color-border)] px-2.5 py-1 text-xs text-[var(--color-text-dim)] transition hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text)]"
                  >
                    não é duplicata
                  </button>
                </>
              )}
              {f.origin === 'auto' && (
                <ReasonChip icon={Bot} color="var(--color-info)" label="criada por agente" />
              )}

              <button
                type="button"
                data-testid="feature-triage-open"
                onClick={() => onSelect(f.id)}
                className="shrink-0 rounded-md border border-[var(--color-border)] px-2.5 py-1 text-xs text-[var(--color-text)] transition hover:bg-[var(--color-surface-2)]"
              >
                abrir
              </button>
              <button
                type="button"
                data-testid="feature-triage-archive"
                title="Arquivar (reversível)"
                onClick={() => onArchive(f.id)}
                className="shrink-0 rounded-md border border-[var(--color-border)] p-1.5 text-[var(--color-text-dim)] transition hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text)]"
              >
                <Icon as={Archive} size={13} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function ReasonChip({
  icon,
  color,
  label,
}: {
  icon: typeof Bot
  color: string
  label: string
}) {
  return (
    <span
      data-testid="feature-triage-reason"
      className="inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium"
      style={{
        color,
        borderColor: `color-mix(in srgb, ${color} 45%, transparent)`,
        background: `color-mix(in srgb, ${color} 12%, transparent)`,
      }}
    >
      <Icon as={icon} size={10} />
      {label}
    </span>
  )
}
