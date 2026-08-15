import type { ReactNode } from 'react'
import type {
  ContentContract,
  ContentContractVersion,
  ToneHardRule,
} from '../../../shared/types/ipc'
import {
  ALLOWED_SCOPE_LABEL,
  FORBIDDEN_STATUS_COLOR,
  FORBIDDEN_STATUS_LABEL,
  GATE_SEVERITY_COLOR,
  GATE_SEVERITY_LABEL,
} from './gate-labels'

// Pílula colorida por token — mesmo desenho do badge de JobsArea/dossiês
// (color-mix sobre a var do tema), extraído aqui porque a tela usa vários.
function Pill({ color, children }: { color: string; children: ReactNode }) {
  return (
    <span
      className="inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[11px] font-medium"
      style={{
        color,
        borderColor: `color-mix(in srgb, ${color} 45%, transparent)`,
        background: `color-mix(in srgb, ${color} 12%, transparent)`,
      }}
    >
      {children}
    </span>
  )
}

function Tag({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex shrink-0 items-center rounded-full border border-[var(--color-border)] px-2 py-0.5 text-[11px] text-[var(--color-text-dim)]">
      {children}
    </span>
  )
}

function Section({
  title,
  count,
  children,
}: {
  title: string
  count?: number
  children: ReactNode
}) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="flex items-baseline gap-2 text-xs font-semibold uppercase tracking-wide text-[var(--color-text-dim)]">
        {title}
        {count != null && <span className="font-mono tabular-nums">{count}</span>}
      </h3>
      {children}
    </section>
  )
}

function Card({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
      {children}
    </div>
  )
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="text-sm text-[var(--color-text-dim)]">{children}</p>
}

// As formas literais são o que o gate procura no material — mostrar em mono
// deixa claro que é texto casado ao pé da letra, não paráfrase.
function Forms({ forms }: { forms: string[] }) {
  if (forms.length === 0) return null
  return (
    <div className="mt-2 flex flex-wrap gap-1">
      {forms.map((f, i) => (
        <code
          key={i}
          className="rounded border border-[var(--color-border)] bg-[var(--color-bg)]/60 px-1.5 py-0.5 font-mono text-[11px] text-[var(--color-text)]"
        >
          {f}
        </code>
      ))}
    </div>
  )
}

function AppliesTo({ tracks }: { tracks?: string[] | null }) {
  // Vazio = vale pra todas as trilhas; dizer isso evita a leitura errada de
  // "não se aplica a nada".
  if (!tracks || tracks.length === 0) return <Tag>todas as trilhas</Tag>
  return (
    <>
      {tracks.map((t) => (
        <Tag key={t}>{t}</Tag>
      ))}
    </>
  )
}

function toneThresholds(rule: ToneHardRule): string[] {
  const out: string[] = []
  if (rule.threshold != null) out.push(`threshold ${rule.threshold}`)
  if (rule.threshold_min != null) out.push(`mín ${rule.threshold_min}`)
  if (rule.threshold_max != null) out.push(`máx ${rule.threshold_max}`)
  if (rule.threshold_palavras_por_ocorrencia != null) {
    out.push(`1 a cada ${rule.threshold_palavras_por_ocorrencia} palavras`)
  }
  if (rule.n_minimo_frases != null) out.push(`n mínimo ${rule.n_minimo_frases} frases`)
  return out
}

function formatWhen(ts: number): string {
  return new Date(ts).toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const mib = bytes / (1024 * 1024)
  if (mib >= 1) return `${mib.toFixed(1).replace('.', ',')} MiB`
  return `${Math.round(bytes / 1024)} KiB`
}

interface Props {
  contract: ContentContract
  versions: ContentContractVersion[]
  versionsLoading: boolean
}

export function ContractView({ contract, versions, versionsLoading }: Props) {
  const { audience, tone } = contract
  // Ordena aqui em vez de confiar na ordem do IPC: a leitura do changelog é
  // "o que mudou por último", e inverter isso descaracteriza a seção.
  const changelog = [...versions].sort((a, b) => b.version - a.version)

  return (
    <div className="flex flex-col gap-6 p-6">
      <Section title="Rótulo obrigatório de saída">
        <Card>
          <p className="font-mono text-sm text-[var(--color-text)]">{contract.outputLabel}</p>
        </Card>
      </Section>

      <Section title="Audiência">
        <Card>
          <p className="text-sm text-[var(--color-text)]">{audience.who || '—'}</p>
          {audience.situation && (
            <p className="mt-1 text-xs text-[var(--color-text-dim)]">{audience.situation}</p>
          )}
          {audience.notWho.length > 0 && (
            <div className="mt-3">
              <p className="mb-1 text-[11px] font-medium uppercase text-[var(--color-text-dim)]">
                Não é para
              </p>
              <ul className="list-disc pl-4 text-sm text-[var(--color-text)]">
                {audience.notWho.map((n, i) => (
                  <li key={i}>{n}</li>
                ))}
              </ul>
            </div>
          )}
          {audience.assumptions.length > 0 && (
            <div className="mt-3">
              <p className="mb-1 text-[11px] font-medium uppercase text-[var(--color-text-dim)]">
                Pressupostos
              </p>
              <ul className="list-disc pl-4 text-sm text-[var(--color-text-dim)]">
                {audience.assumptions.map((a, i) => (
                  <li key={i}>{a}</li>
                ))}
              </ul>
            </div>
          )}
        </Card>
      </Section>

      <Section title="Linha ética" count={contract.ethicalLine.length}>
        {contract.ethicalLine.length === 0 ? (
          <Empty>Sem regras declaradas.</Empty>
        ) : (
          <div className="flex flex-col gap-2">
            {contract.ethicalLine.map((r) => (
              <Card key={r.id}>
                <p className="text-sm text-[var(--color-text)]">{r.rule}</p>
                {r.rationale && (
                  <p className="mt-1 text-xs text-[var(--color-text-dim)]">{r.rationale}</p>
                )}
              </Card>
            ))}
          </div>
        )}
      </Section>

      <Section title="Fatos permitidos" count={contract.allowedFacts.length}>
        {contract.allowedFacts.length === 0 ? (
          <Empty>Nenhum fato permitido declarado.</Empty>
        ) : (
          <div className="flex flex-col gap-2">
            {contract.allowedFacts.map((f) => (
              <Card key={f.id}>
                <div className="flex items-start justify-between gap-3">
                  <p className="text-sm text-[var(--color-text)]">{f.statement}</p>
                  <Tag>{ALLOWED_SCOPE_LABEL[f.scope]}</Tag>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-1">
                  <AppliesTo tracks={f.appliesTo} />
                </div>
                <p className="mt-2 text-xs text-[var(--color-text-dim)]">
                  Fonte: {f.source ?? '— sem fonte declarada'}
                </p>
              </Card>
            ))}
          </div>
        )}
      </Section>

      <Section title="Fatos proibidos" count={contract.forbiddenFacts.length}>
        {contract.forbiddenFacts.length === 0 ? (
          <Empty>Nenhum fato proibido declarado.</Empty>
        ) : (
          <div className="flex flex-col gap-2">
            {contract.forbiddenFacts.map((f) => (
              <Card key={f.id}>
                <div className="flex items-start justify-between gap-3">
                  <p className="text-sm text-[var(--color-text)]">{f.claim}</p>
                  <Pill color={FORBIDDEN_STATUS_COLOR[f.status]}>
                    {FORBIDDEN_STATUS_LABEL[f.status]}
                  </Pill>
                </div>
                <Forms forms={f.forms} />
                {/* A forma neutra é o que o gate oferece no lugar: sem ela a
                    reprovação não diz o que escrever. */}
                <p className="mt-2 text-xs text-[var(--color-text)]">
                  <span className="text-[var(--color-text-dim)]">Dizer no lugar: </span>
                  {f.neutralForm}
                </p>
                {f.reason && (
                  <p className="mt-1 text-xs text-[var(--color-text-dim)]">{f.reason}</p>
                )}
                <div className="mt-2 flex flex-wrap items-center gap-1">
                  <AppliesTo tracks={f.appliesTo} />
                </div>
              </Card>
            ))}
          </div>
        )}
      </Section>

      <Section title="Fora de escopo" count={contract.outOfScope.length}>
        {contract.outOfScope.length === 0 ? (
          <Empty>Nada declarado fora de escopo.</Empty>
        ) : (
          <div className="flex flex-col gap-2">
            {contract.outOfScope.map((o) => (
              <Card key={o.id}>
                <div className="flex items-start justify-between gap-3">
                  <p className="text-sm text-[var(--color-text)]">{o.item}</p>
                  <Tag>{o.owner ?? 'sem dono'}</Tag>
                </div>
                <Forms forms={o.forms} />
                {o.question && (
                  <p className="mt-2 text-xs text-[var(--color-text-dim)]">
                    Checklist: {o.question}
                  </p>
                )}
              </Card>
            ))}
          </div>
        )}
      </Section>

      <Section title="Tom">
        <Card>
          {tone.id && <p className="font-mono text-xs text-[var(--color-text-dim)]">{tone.id}</p>}
          {tone.tone_words && tone.tone_words.length > 0 && (
            <div className="mt-2">
              <p className="mb-1 text-[11px] font-medium uppercase text-[var(--color-text-dim)]">
                Palavras do tom
              </p>
              <div className="flex flex-wrap gap-1">
                {tone.tone_words.map((w) => (
                  <Tag key={w}>{w}</Tag>
                ))}
              </div>
            </div>
          )}
          {tone.anti_tone_words && tone.anti_tone_words.length > 0 && (
            <div className="mt-2">
              <p className="mb-1 text-[11px] font-medium uppercase text-[var(--color-text-dim)]">
                Antipalavras
              </p>
              <div className="flex flex-wrap gap-1">
                {tone.anti_tone_words.map((w) => (
                  <Tag key={w}>{w}</Tag>
                ))}
              </div>
            </div>
          )}
          {tone.densidade_tone_words_min_por_100_palavras != null && (
            <p className="mt-2 text-xs text-[var(--color-text-dim)]">
              Densidade mínima: {tone.densidade_tone_words_min_por_100_palavras} por 100 palavras
            </p>
          )}
          {tone.hard_rules && tone.hard_rules.length > 0 && (
            <div className="mt-3 flex flex-col gap-2">
              {tone.hard_rules.map((r) => {
                const thresholds = toneThresholds(r)
                return (
                  <div
                    key={r.id}
                    className="rounded border border-[var(--color-border)] bg-[var(--color-bg)]/40 px-2 py-1.5"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <span className="font-mono text-[11px] text-[var(--color-text)]">{r.id}</span>
                      {r.severidade && (
                        <Pill color={GATE_SEVERITY_COLOR[r.severidade]}>
                          {GATE_SEVERITY_LABEL[r.severidade]}
                        </Pill>
                      )}
                    </div>
                    {r.regra && <p className="mt-1 text-xs text-[var(--color-text)]">{r.regra}</p>}
                    {r.porque && (
                      <p className="mt-1 text-xs text-[var(--color-text-dim)]">{r.porque}</p>
                    )}
                    {thresholds.length > 0 && (
                      <p className="mt-1 font-mono text-[11px] tabular-nums text-[var(--color-text-dim)]">
                        {thresholds.join(' · ')}
                      </p>
                    )}
                  </div>
                )
              })}
            </div>
          )}
          {tone.paragrafo_canonico && (
            <div className="mt-3">
              <p className="mb-1 text-[11px] font-medium uppercase text-[var(--color-text-dim)]">
                Parágrafo canônico
              </p>
              <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded border border-[var(--color-border)] bg-[var(--color-bg)]/60 px-2 py-1.5 font-mono text-xs leading-relaxed text-[var(--color-text)]">
                {tone.paragrafo_canonico}
              </pre>
            </div>
          )}
        </Card>
      </Section>

      <Section title="Limites de entrega" count={contract.deliveryLimits.length}>
        {contract.deliveryLimits.length === 0 ? (
          <Empty>Sem limite por canal.</Empty>
        ) : (
          <div className="flex flex-col gap-2">
            {contract.deliveryLimits.map((l) => (
              <Card key={l.channel}>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm text-[var(--color-text)]">{l.channel}</span>
                  <span className="font-mono text-xs tabular-nums text-[var(--color-text-dim)]">
                    {l.maxBytes != null ? formatBytes(l.maxBytes) : '—'}
                    {l.maxDurationSec != null && ` · ${l.maxDurationSec}s`}
                  </span>
                </div>
                {l.notes && <p className="mt-1 text-xs text-[var(--color-text-dim)]">{l.notes}</p>}
              </Card>
            ))}
          </div>
        )}
      </Section>

      <Section title="Invariantes de produção" count={contract.productionInvariants.length}>
        {contract.productionInvariants.length === 0 ? (
          <Empty>Nenhuma invariante declarada.</Empty>
        ) : (
          <div className="flex flex-col gap-2">
            {contract.productionInvariants.map((inv) => (
              <Card key={inv.id}>
                <p className="text-sm text-[var(--color-text)]">{inv.invariant}</p>
                {inv.rationale && (
                  <p className="mt-1 text-xs text-[var(--color-text-dim)]">{inv.rationale}</p>
                )}
              </Card>
            ))}
          </div>
        )}
      </Section>

      <Section title="Precedência de fontes" count={contract.sourcePrecedence.length}>
        {contract.sourcePrecedence.length === 0 ? (
          <Empty>Sem ordem de precedência declarada.</Empty>
        ) : (
          <ol className="flex flex-col gap-1">
            {[...contract.sourcePrecedence]
              .sort((a, b) => a.rank - b.rank)
              .map((s) => (
                <li
                  key={`${s.rank}-${s.source}`}
                  className="flex items-baseline gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2"
                >
                  <span className="font-mono text-xs tabular-nums text-[var(--color-text-dim)]">
                    {s.rank}
                  </span>
                  <span className="text-sm text-[var(--color-text)]">{s.source}</span>
                  {s.note && (
                    <span className="text-xs text-[var(--color-text-dim)]">— {s.note}</span>
                  )}
                </li>
              ))}
          </ol>
        )}
      </Section>

      {/* O changelog é o que transforma erro corrigido em memória: cada emenda
          registra o que mudou (summary) e por que mudou (reason). Sem ele, o
          contrato vigente não explica de onde veio. */}
      <Section title="Changelog" count={changelog.length}>
        {versionsLoading && changelog.length === 0 ? (
          <Empty>Carregando…</Empty>
        ) : changelog.length === 0 ? (
          <Empty>Sem histórico de versões.</Empty>
        ) : (
          <ol className="flex flex-col gap-2">
            {changelog.map((v) => (
              <li key={v.id}>
                <Card>
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="font-mono text-xs tabular-nums text-[var(--color-text)]">
                      v{v.version}
                    </span>
                    <span className="shrink-0 font-mono text-[11px] tabular-nums text-[var(--color-text-dim)]">
                      {formatWhen(v.createdAt)}
                    </span>
                  </div>
                  <p className="mt-1 text-sm text-[var(--color-text)]">{v.summary}</p>
                  <p className="mt-1 text-xs text-[var(--color-text-dim)]">{v.reason}</p>
                  {v.changedFields.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1">
                      {v.changedFields.map((f) => (
                        <Tag key={f}>{f}</Tag>
                      ))}
                    </div>
                  )}
                </Card>
              </li>
            ))}
          </ol>
        )}
      </Section>
    </div>
  )
}
