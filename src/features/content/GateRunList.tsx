import type { ContentGateFinding, ContentGateRun } from '../../../shared/types/ipc'
import {
  GATE_KIND_LABEL,
  GATE_KIND_NATURE,
  GATE_OUTCOME_COLOR,
  GATE_OUTCOME_LABEL,
  GATE_SEVERITY_COLOR,
  GATE_SEVERITY_LABEL,
  gateOutcome,
} from './gate-labels'

function formatWhen(ts: number): string {
  return new Date(ts).toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function position(f: ContentGateFinding): string | null {
  if (f.line == null) return null
  return f.column == null ? `linha ${f.line}` : `linha ${f.line}, coluna ${f.column}`
}

function Finding({ finding }: { finding: ContentGateFinding }) {
  const color = GATE_SEVERITY_COLOR[finding.severity]
  const pos = position(finding)
  return (
    <li className="border-t border-[var(--color-border)] px-3 py-2">
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-mono text-[11px] text-[var(--color-text)]">{finding.rule}</span>
        <span className="text-[11px] font-medium" style={{ color }}>
          {GATE_SEVERITY_LABEL[finding.severity]}
        </span>
      </div>
      <p className="mt-0.5 text-xs text-[var(--color-text)]">{finding.message}</p>
      {pos && (
        <p className="mt-0.5 font-mono text-[11px] tabular-nums text-[var(--color-text-dim)]">
          {pos}
        </p>
      )}
      {finding.excerpt && (
        <pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap break-words rounded border border-[var(--color-border)] bg-[var(--color-bg)]/60 px-2 py-1 font-mono text-[11px] leading-relaxed text-[var(--color-text)]">
          {finding.excerpt}
        </pre>
      )}
      {finding.replacement && (
        <p className="mt-1 text-[11px] text-[var(--color-text-dim)]">
          Dizer no lugar: <span className="text-[var(--color-text)]">{finding.replacement}</span>
        </p>
      )}
    </li>
  )
}

function GateRunCard({ run }: { run: ContentGateRun }) {
  const outcome = gateOutcome(run)
  const color = GATE_OUTCOME_COLOR[outcome]

  return (
    <li
      className="overflow-hidden rounded-md border bg-[var(--color-surface)]"
      // Só a borda carrega o resultado: legível de relance sem preencher o card
      // inteiro de vermelho quando o gate reprova.
      style={{
        borderColor: `color-mix(in srgb, ${color} 45%, var(--color-border))`,
      }}
    >
      <div className="flex items-start justify-between gap-3 px-3 py-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span
              aria-hidden
              className="h-1.5 w-1.5 shrink-0 rounded-full"
              style={{ background: color }}
            />
            <span className="truncate text-sm font-medium text-[var(--color-text)]">
              {GATE_KIND_LABEL[run.gate]}
            </span>
            <span className="shrink-0 text-[11px]" style={{ color }}>
              {GATE_OUTCOME_LABEL[outcome]}
            </span>
          </div>
          <p className="mt-0.5 truncate text-[11px] text-[var(--color-text-dim)]">
            {GATE_KIND_NATURE[run.gate]} · v{run.contractVersion}
            {run.materialRef && ` · ${run.materialRef}`}
          </p>
        </div>
        <span className="shrink-0 font-mono text-[11px] tabular-nums text-[var(--color-text-dim)]">
          {formatWhen(run.createdAt)}
        </span>
      </div>

      {(run.blockingCount > 0 || run.warningCount > 0) && (
        <p className="px-3 pb-2 font-mono text-[11px] tabular-nums text-[var(--color-text-dim)]">
          {run.blockingCount} bloqueante(s) · {run.warningCount} aviso(s)
        </p>
      )}

      {/* A evidência é o ponto da tela: literal, sem reformatação, porque é o
          que sustenta (ou derruba) a afirmação de que o gate passou. */}
      {run.evidence && (
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words border-t border-[var(--color-border)] bg-[var(--color-bg)]/60 px-3 py-2 font-mono text-[11px] leading-relaxed text-[var(--color-text)]">
          {run.evidence}
        </pre>
      )}

      {run.findings.length > 0 && (
        <ul>
          {run.findings.map((f, i) => (
            <Finding key={i} finding={f} />
          ))}
        </ul>
      )}

      {run.findingsTruncated && (
        <p className="border-t border-[var(--color-border)] px-3 py-1.5 text-[11px] text-[var(--color-warning)]">
          Achados truncados na gravação — a cauda não está aqui.
        </p>
      )}
    </li>
  )
}

interface Props {
  runs: ContentGateRun[]
  loading: boolean
}

export function GateRunList({ runs, loading }: Props) {
  return (
    <div className="flex h-full flex-col">
      <h3 className="border-b border-[var(--color-border)] px-4 py-2 text-xs font-semibold uppercase tracking-wide text-[var(--color-text-dim)]">
        Gate runs
      </h3>
      <div className="flex-1 overflow-y-auto p-3">
        {loading && runs.length === 0 ? (
          <p className="px-1 py-3 text-sm text-[var(--color-text-dim)]">Carregando…</p>
        ) : runs.length === 0 ? (
          <p className="px-1 py-3 text-sm text-[var(--color-text-dim)]">
            Nenhum gate rodou contra este contrato ainda.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {runs.map((run) => (
              <GateRunCard key={run.id} run={run} />
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
