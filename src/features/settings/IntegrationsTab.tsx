import { useCallback, useEffect, useState } from 'react'
import { FileSearch, Loader2 } from 'lucide-react'
import { secretsApi } from '@/lib/ipc'
import { SERVICE_REGISTRY, type ServiceDef } from '@shared/service-registry'
import type {
  ApplyImportResult,
  ImportCandidate,
  ServiceHealth,
  ServiceStatusEntry,
} from '@shared/types/ipc'

// Aba "Integrações": estado dos serviços que o env hub conhece (registry) +
// importador de credenciais dos .env espalhados em ~/projetos.
//
// Segurança: esta tela NUNCA vê valor de credencial. O scan devolve fingerprint
// (máscara + últimos 4 chars + tamanho) e path de origem; no apply o main relê
// o valor do arquivo escolhido.

function varPresent(canonical: string, aliases: readonly string[], has: Set<string>): boolean {
  return [canonical, ...aliases].some((k) => has.has(k))
}

// Configurado = todas as required presentes; serviço sem required conta
// qualquer var conhecida como sinal de configuração.
function isConfigured(def: ServiceDef, has: Set<string>): boolean {
  const required = def.vars.filter((v) => v.required)
  const pool = required.length > 0 ? required : def.vars
  const check = required.length > 0 ? pool.every.bind(pool) : pool.some.bind(pool)
  return check((v) => varPresent(v.canonical, v.aliases, has))
}

function presentCount(def: ServiceDef, has: Set<string>): number {
  return def.vars.filter((v) => varPresent(v.canonical, v.aliases, has)).length
}

const STATUS_LABEL: Record<ImportCandidate['status'], string> = {
  new: 'nova',
  same: 'já no cofre',
  conflict: 'conflito',
  // Alias cuja canônica já está no cofre: importar gravaria var que a resolução
  // (canônica primeiro) ignora.
  shadowed: 'sombreada pela canônica',
}

function statusColor(status: ImportCandidate['status']): string {
  if (status === 'new') return 'var(--color-success, #22c55e)'
  if (status === 'conflict' || status === 'shadowed') return 'var(--color-warning, #f59e0b)'
  return 'var(--color-text-dim)'
}

function serviceTitle(id: string | undefined): string | null {
  const def = SERVICE_REGISTRY.find((s) => s.id === id)
  return def ? def.title : null
}

const HEALTH_LABEL: Record<ServiceHealth['status'], string> = {
  ok: 'health ok',
  error: 'health falhou',
  unconfigured: 'health sem credencial',
  unsupported: 'health —',
}

function healthColor(status: ServiceHealth['status']): string {
  if (status === 'ok') return 'var(--color-success, #22c55e)'
  if (status === 'error') return 'var(--color-danger, #ef4444)'
  return 'var(--color-text-dim)'
}

export function IntegrationsTab({ open }: { open: boolean }) {
  const [vaultKeys, setVaultKeys] = useState<Set<string>>(new Set())
  const [candidates, setCandidates] = useState<ImportCandidate[] | null>(null)
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [sourceByKey, setSourceByKey] = useState<Record<string, string>>({})
  const [scanning, setScanning] = useState(false)
  const [applying, setApplying] = useState(false)
  const [result, setResult] = useState<ApplyImportResult | null>(null)
  const [statuses, setStatuses] = useState<Record<string, ServiceStatusEntry> | null>(null)

  const reloadVault = useCallback(async () => {
    const entries = await secretsApi.list()
    setVaultKeys(new Set(entries.filter((e) => e.hasValue).map((e) => e.key)))
  }, [])

  const reloadStatuses = useCallback(async () => {
    const list = await secretsApi.servicesStatus()
    setStatuses(Object.fromEntries(list.map((entry) => [entry.id, entry])))
  }, [])

  useEffect(() => {
    if (!open) return
    void reloadVault()
    void reloadStatuses()
    return () => {
      setCandidates(null)
      setChecked(new Set())
      setSourceByKey({})
      setResult(null)
    }
  }, [open, reloadVault, reloadStatuses])

  async function scan() {
    setScanning(true)
    setResult(null)
    try {
      const found = await secretsApi.importScan()
      setCandidates(found)
      // Pré-seleção conservadora: só chaves novas; conflito exige escolha ativa.
      setChecked(new Set(found.filter((c) => c.status === 'new').map((c) => c.key)))
      setSourceByKey(Object.fromEntries(found.map((c) => [c.key, c.sources[0]?.path ?? ''])))
    } finally {
      setScanning(false)
    }
  }

  function toggle(key: string) {
    setChecked((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  async function apply() {
    if (!candidates) return
    const selections = candidates
      .filter((c) => checked.has(c.key) && sourceByKey[c.key])
      .map((c) => ({ key: c.key, sourcePath: sourceByKey[c.key] }))
    if (selections.length === 0) return
    setApplying(true)
    try {
      const applied = await secretsApi.importApply(selections)
      setResult(applied)
      await reloadVault()
      await reloadStatuses()
      const found = await secretsApi.importScan()
      setCandidates(found)
      setChecked(new Set())
    } finally {
      setApplying(false)
    }
  }

  const selectedCount = candidates
    ? candidates.filter((c) => checked.has(c.key) && sourceByKey[c.key]).length
    : 0

  return (
    <div className="space-y-4">
      <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)]/40 p-3">
        <div className="mb-1 text-xs font-medium uppercase tracking-wide text-[var(--color-text-dim)]">
          Serviços
        </div>
        <p className="mb-3 text-xs text-[var(--color-text-dim)]">
          Serviços que o app sabe acessar com as credenciais do cofre. Os valores ficam cifrados e
          são editáveis na aba "Variáveis de ambiente".
        </p>
        <div className="grid grid-cols-2 gap-2">
          {SERVICE_REGISTRY.map((def) => {
            const status = statuses?.[def.id]
            const configured = status?.configured ?? isConfigured(def, vaultKeys)
            const health = status?.health
            const lastCall = status?.lastCall ?? null
            return (
              <div
                key={def.id}
                className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)]/60 p-2.5"
              >
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-sm font-medium text-[var(--color-text)]">
                    {def.title}
                  </span>
                  <span
                    className="shrink-0 rounded-full border px-1.5 py-0.5 text-[10px]"
                    style={{
                      color: configured ? 'var(--color-success, #22c55e)' : 'var(--color-text-dim)',
                      borderColor: configured
                        ? 'var(--color-success, #22c55e)'
                        : 'var(--color-border)',
                    }}
                  >
                    {configured ? 'configurado' : 'não configurado'}
                  </span>
                </div>
                <div className="mt-1 flex items-center justify-between text-[11px] text-[var(--color-text-dim)]">
                  <span>
                    {presentCount(def, vaultKeys)}/{def.vars.length} variáveis no cofre
                  </span>
                  {health ? (
                    <span
                      style={{ color: healthColor(health.status) }}
                      title={health.error ?? undefined}
                    >
                      {HEALTH_LABEL[health.status]}
                    </span>
                  ) : (
                    <span>health …</span>
                  )}
                </div>
                {lastCall && (
                  <div
                    className="mt-1 truncate text-[11px] text-[var(--color-text-dim)]"
                    title={lastCall.error ?? undefined}
                  >
                    última chamada: {lastCall.operation} ·{' '}
                    {lastCall.status === 'ok' ? 'ok' : 'erro'} · {lastCall.durationMs}ms ·{' '}
                    {new Date(lastCall.ts).toLocaleString('pt-BR')}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>

      <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)]/40 p-3">
        <div className="mb-1 text-xs font-medium uppercase tracking-wide text-[var(--color-text-dim)]">
          Importar de .env
        </div>
        <p className="mb-3 text-xs text-[var(--color-text-dim)]">
          Procura arquivos .env em ~/projetos e traz as credenciais para o cofre. Os valores nunca
          aparecem aqui — só uma impressão digital (últimos 4 caracteres + tamanho) para você
          distinguir fontes em conflito.
        </p>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void scan()}
            disabled={scanning}
            className="inline-flex items-center gap-1 rounded-md border border-[var(--color-border)] px-2.5 py-1 text-xs text-[var(--color-text-dim)] transition hover:text-[var(--color-text)] disabled:opacity-50"
          >
            {scanning ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <FileSearch className="h-3.5 w-3.5" />
            )}
            {candidates === null ? 'Buscar arquivos .env' : 'Buscar de novo'}
          </button>
          {candidates !== null && (
            <button
              type="button"
              onClick={() => void apply()}
              disabled={applying || selectedCount === 0}
              className="inline-flex items-center gap-1 rounded-md border border-[var(--color-accent)] px-2.5 py-1 text-xs text-[var(--color-accent)] transition hover:bg-[var(--color-accent)]/10 disabled:opacity-50"
            >
              {applying && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Importar {selectedCount > 0 ? `${selectedCount} chave(s)` : ''}
            </button>
          )}
        </div>

        {result && (
          <div className="mt-3 space-y-1 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)]/60 p-2.5 text-xs text-[var(--color-text)]">
            <div>{result.applied.length} chave(s) importada(s) para o cofre.</div>
            {result.missing.length > 0 && (
              <div className="text-[var(--color-warning,#f59e0b)]">
                Não encontradas no arquivo na hora de gravar: {result.missing.join(', ')}
              </div>
            )}
            {result.rejected.length > 0 && (
              <div className="text-[var(--color-danger,#ef4444)]">
                Fonte recusada na revalidação (fora da raiz, symlink ou nome inválido):{' '}
                {result.rejected.join(', ')}
              </div>
            )}
            {result.plaintext.length > 0 && (
              <div className="text-[var(--color-danger,#ef4444)]">
                Gravadas em texto claro (cofre do sistema indisponível):{' '}
                {result.plaintext.join(', ')}
              </div>
            )}
          </div>
        )}

        {candidates !== null && candidates.length === 0 && (
          <div className="mt-3 py-2 text-center text-xs text-[var(--color-text-dim)]">
            Nenhuma variável encontrada nos .env de ~/projetos.
          </div>
        )}

        {candidates !== null && candidates.length > 0 && (
          <div className="mt-3 space-y-2">
            {candidates.map((c) => {
              const disabled = c.status === 'same'
              const service = serviceTitle(c.serviceId)
              return (
                <div
                  key={c.key}
                  className={`rounded-md border border-[var(--color-border)] p-2 ${
                    disabled ? 'opacity-60' : ''
                  }`}
                >
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={checked.has(c.key)}
                      disabled={disabled}
                      onChange={() => toggle(c.key)}
                      className="size-3.5 shrink-0 accent-[var(--color-accent)]"
                    />
                    <span className="min-w-0 flex-1 truncate font-mono text-xs text-[var(--color-text)]">
                      {c.key}
                    </span>
                    {service && (
                      <span className="shrink-0 rounded-full border border-[var(--color-border)] px-1.5 py-0.5 text-[10px] text-[var(--color-text-dim)]">
                        {service}
                      </span>
                    )}
                    <span
                      className="shrink-0 rounded-full border px-1.5 py-0.5 text-[10px]"
                      style={{
                        color: statusColor(c.status),
                        borderColor: statusColor(c.status),
                      }}
                    >
                      {STATUS_LABEL[c.status]}
                    </span>
                  </label>
                  <div className="mt-1.5 space-y-1 pl-5">
                    {c.sources.map((src) => (
                      <label key={src.path} className="flex items-center gap-2 text-[11px]">
                        {c.sources.length > 1 ? (
                          <input
                            type="radio"
                            name={`src-${c.key}`}
                            checked={sourceByKey[c.key] === src.path}
                            disabled={disabled}
                            onChange={() =>
                              setSourceByKey((prev) => ({
                                ...prev,
                                [c.key]: src.path,
                              }))
                            }
                            className="size-3 shrink-0 accent-[var(--color-accent)]"
                          />
                        ) : (
                          <span className="w-3 shrink-0" />
                        )}
                        <span
                          className="min-w-0 flex-1 truncate text-[var(--color-text-dim)]"
                          title={src.path}
                        >
                          {src.path}
                        </span>
                        <span className="shrink-0 font-mono text-[var(--color-text-dim)]">
                          {src.fingerprint}
                        </span>
                      </label>
                    ))}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
