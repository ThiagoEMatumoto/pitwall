import { useEffect, useMemo } from 'react'
import { FileText } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import { activeMarker } from '@/features/brand'
import { useContentContractsStore } from '@/store/contentContractsStore'
import { CONTRACT_STATUS_COLOR, CONTRACT_STATUS_LABEL } from './gate-labels'
import { ContractView } from './ContractView'
import { GateRunList } from './GateRunList'

function formatWhen(ts: number): string {
  return new Date(ts).toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function ContentArea() {
  const contracts = useContentContractsStore((s) => s.contracts)
  const selectedContractId = useContentContractsStore((s) => s.selectedContractId)
  const gateRuns = useContentContractsStore((s) => s.gateRuns)
  const versions = useContentContractsStore((s) => s.versions)
  const loading = useContentContractsStore((s) => s.loading)
  const runsLoading = useContentContractsStore((s) => s.runsLoading)
  const versionsLoading = useContentContractsStore((s) => s.versionsLoading)
  const error = useContentContractsStore((s) => s.error)
  const load = useContentContractsStore((s) => s.load)
  const selectContract = useContentContractsStore((s) => s.selectContract)
  const startWatch = useContentContractsStore((s) => s.startWatch)
  const stopWatch = useContentContractsStore((s) => s.stopWatch)

  useEffect(() => {
    void load()
    startWatch()
    return () => stopWatch()
  }, [load, startWatch, stopWatch])

  const selected = useMemo(
    () => contracts.find((c) => c.id === selectedContractId) ?? null,
    [contracts, selectedContractId],
  )

  return (
    <>
      <aside className="flex w-72 shrink-0 flex-col border-r border-[var(--color-border)] bg-[var(--color-surface)]">
        <div className="flex items-center justify-between border-b border-[var(--color-border)] px-4 py-3">
          <span className="text-sm font-semibold text-[var(--color-text)]">Contratos</span>
        </div>

        <div className="flex-1 overflow-y-auto">
          {error ? (
            <p className="px-4 py-6 text-sm text-[var(--color-danger)]">{error}</p>
          ) : loading && contracts.length === 0 ? (
            <p className="px-4 py-6 text-sm text-[var(--color-text-dim)]">Carregando…</p>
          ) : contracts.length === 0 ? (
            <p className="px-4 py-6 text-sm text-[var(--color-text-dim)]">
              Nenhum contrato ainda. Contratos são criados e editados por uma sessão via MCP (
              <code className="font-mono">content_contract_upsert</code>).
            </p>
          ) : (
            <ul>
              {contracts.map((c) => {
                const active = c.id === selectedContractId
                return (
                  <li key={c.id}>
                    <button
                      type="button"
                      onClick={() => void selectContract(c.id)}
                      className={`flex w-full flex-col gap-1 border-b border-[var(--color-border)] px-4 py-3 text-left transition ${
                        active
                          ? `bg-[var(--color-surface-2)] ${activeMarker}`
                          : 'hover:bg-[var(--color-surface-2)]/60'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate text-sm font-medium text-[var(--color-text)]">
                          {c.title}
                        </span>
                        <span
                          className="shrink-0 text-[11px]"
                          style={{ color: CONTRACT_STATUS_COLOR[c.status] }}
                        >
                          {CONTRACT_STATUS_LABEL[c.status]}
                        </span>
                      </div>
                      <span className="truncate font-mono text-xs text-[var(--color-text-dim)]">
                        {c.slug}
                      </span>
                      <span className="font-mono text-[11px] tabular-nums text-[var(--color-text-dim)]">
                        v{c.version} · {formatWhen(c.updatedAt)}
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      </aside>

      <main className="flex flex-1 flex-col overflow-hidden">
        {!selected ? (
          <div className="flex flex-1 items-center justify-center text-sm text-[var(--color-text-dim)]">
            <div className="flex flex-col items-center gap-2">
              <Icon as={FileText} size={32} />
              <span>Selecione um contrato.</span>
            </div>
          </div>
        ) : (
          <>
            <header className="flex items-start justify-between gap-4 border-b border-[var(--color-border)] px-6 py-4">
              <div className="min-w-0">
                <h2 className="truncate text-lg font-semibold text-[var(--color-text)]">
                  {selected.title}
                </h2>
                {/* Versão é o que amarra a evidência de cada gate run ao texto
                    que valia; o histórico de cada emenda está no changelog, no
                    fim do contrato. */}
                <p className="mt-1 font-mono text-xs text-[var(--color-text-dim)]">
                  {selected.slug} · v{selected.version} · {CONTRACT_STATUS_LABEL[selected.status]} ·
                  atualizado {formatWhen(selected.updatedAt)}
                </p>
              </div>
            </header>

            <div className="flex flex-1 overflow-hidden">
              <section className="flex-1 overflow-y-auto">
                <ContractView
                  contract={selected}
                  versions={versions}
                  versionsLoading={versionsLoading}
                />
              </section>
              <section className="w-[26rem] shrink-0 overflow-hidden border-l border-[var(--color-border)]">
                <GateRunList runs={gateRuns} loading={runsLoading} />
              </section>
            </div>
          </>
        )}
      </main>
    </>
  )
}
