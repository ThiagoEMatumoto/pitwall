import { useCallback, useEffect, useState } from 'react'
import { Plus, Trash2, Eye, EyeOff, ShieldAlert, ShieldCheck } from 'lucide-react'
import { secretsApi } from '@/lib/ipc'
import { KNOWN_ENV_VARS } from '@shared/known-env-vars'
import type { CustomEnvEntry, SecretsStatus } from '@shared/types/ipc'

// Aba "Variáveis de ambiente": editor key=value das vars customizadas do usuário,
// injetadas nos spawns de processos externos (sidecar de transcrição, claude -p).
//
// Os VALORES são segredos e ficam cifrados no banco (safeStorage do Electron).
// Esta tela nunca recebe o mapa inteiro em claro: lista só os NOMES + se há
// valor, e pede o texto claro de UMA chave por vez, quando o usuário clica em
// revelar. Esconder de volta descarta o valor da memória do renderer.

// Placeholder de comprimento FIXO: usar o tamanho real do segredo já vazaria
// informação sobre ele.
const MASK = '••••••••'

interface Row {
  // Identidade estável no cliente (a chave muda enquanto o usuário digita).
  id: number
  // Nome exibido/editável.
  key: string
  // Nome atualmente persistido (null = linha nova, ainda não gravada).
  savedKey: string | null
  hasValue: boolean
  // Texto claro em memória: null = não carregado (mascarado).
  draft: string | null
  visible: boolean
  unreadable: boolean
}

let nextId = 1

function toRow(entry: CustomEnvEntry): Row {
  return {
    id: nextId++,
    key: entry.key,
    savedKey: entry.key,
    hasValue: entry.hasValue,
    // Linha sem valor já nasce editável; com valor exige revelar antes de editar.
    draft: entry.hasValue ? null : '',
    visible: false,
    unreadable: entry.unreadable,
  }
}

function emptyRow(key: string): Row {
  return {
    id: nextId++,
    key,
    savedKey: null,
    hasValue: false,
    draft: '',
    visible: false,
    unreadable: false,
  }
}

const KNOWN_KEYS = new Set(KNOWN_ENV_VARS.map((v) => v.envKey))

function EncryptionNotice({ status }: { status: SecretsStatus }) {
  const unreadable = status.unreadableKeys.length
  if (status.backend === 'os_keyring' && unreadable === 0) {
    return (
      <div className="flex items-start gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)]/40 p-2.5 text-xs text-[var(--color-text-dim)]">
        <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--color-success,#22c55e)]" />
        <span>
          Valores cifrados em repouso pelo cofre de credenciais do sistema. Cópias do banco
          (backup, harness de testes) não levam a chave utilizável.
        </span>
      </div>
    )
  }
  const danger = status.backend === 'unavailable'
  const color = danger ? 'var(--color-danger,#ef4444)' : 'var(--color-warning,#f59e0b)'
  return (
    <div
      className="flex items-start gap-2 rounded-md border p-2.5 text-xs"
      style={{ borderColor: color, color: 'var(--color-text)' }}
    >
      <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" style={{ color }} />
      <div className="space-y-1">
        {status.backend === 'unavailable' && (
          <p>
            <strong>Cofre do sistema indisponível.</strong> Os valores abaixo estão gravados em
            TEXTO CLARO no banco local — qualquer cópia do perfil leva o segredo junto. No Linux,
            configure um keyring (gnome-keyring ou KWallet) e reinicie o app para que sejam
            cifrados automaticamente.
          </p>
        )}
        {status.backend === 'basic_text' && (
          <p>
            <strong>Keyring do sistema não configurado.</strong> O Chromium caiu no backend{' '}
            <code>basic_text</code>, que cifra com uma chave fixa e pública: é ofuscação, não
            proteção real. Instale/desbloqueie um keyring para proteção de verdade.
          </p>
        )}
        {status.backend !== 'unavailable' && status.plaintextKeys.length > 0 && (
          <p>
            {status.plaintextKeys.length} valor(es) ainda em texto claro. Reescreva-os para que
            sejam cifrados.
          </p>
        )}
        {unreadable > 0 && (
          <p>
            {unreadable} valor(es) não puderam ser decifrados neste cofre (banco copiado de outra
            máquina ou cofre trocado). Eles seguem no banco, mas são inutilizáveis — regrave.
          </p>
        )}
      </div>
    </div>
  )
}

export function EnvVarsTab({ open }: { open: boolean }) {
  const [rows, setRows] = useState<Row[]>([])
  const [status, setStatus] = useState<SecretsStatus | null>(null)

  const reload = useCallback(async () => {
    const [entries, nextStatus] = await Promise.all([secretsApi.list(), secretsApi.status()])
    const next = entries.map(toRow)
    // Toda integração conhecida ganha uma linha, mesmo sem valor: assim o input
    // da seção "Integrações" é sempre o MESMO elemento, revelado ou não (trocar
    // de elemento no meio da digitação faria o campo perder o foco).
    for (const envKey of KNOWN_KEYS) {
      if (!next.some((r) => r.key === envKey)) next.push(emptyRow(envKey))
    }
    setRows(next)
    setStatus(nextStatus)
  }, [])

  useEffect(() => {
    if (!open) return
    void reload()
    // Fechar a aba descarta qualquer texto claro que estivesse revelado.
    return () => setRows([])
  }, [open, reload])

  function patch(id: number, next: Partial<Row>) {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...next } : r)))
  }

  // Persiste o VALOR de uma linha. Chave vazia ou valor não carregado = no-op
  // (não dá para regravar o que não se leu).
  async function saveValue(row: Row) {
    const key = row.key.trim()
    if (!key || row.draft === null) return
    const next = await secretsApi.set(key, row.draft)
    setStatus(next)
    patch(row.id, { savedKey: key, hasValue: row.draft.length > 0, unreadable: false })
  }

  // Persiste o NOME. Renomear acontece no main: o valor não passa pelo renderer.
  async function saveKey(row: Row) {
    const key = row.key.trim()
    if (!key || key === row.savedKey) return
    if (row.savedKey) {
      const next = await secretsApi.rename(row.savedKey, key)
      setStatus(next)
      patch(row.id, { savedKey: key })
      return
    }
    if (row.draft !== null) await saveValue({ ...row, key })
  }

  async function removeRow(row: Row) {
    if (row.savedKey) setStatus(await secretsApi.remove(row.savedKey))
    setRows((prev) => prev.filter((r) => r.id !== row.id))
  }

  // Alterna o texto claro. Primeira revelação busca o valor no main; esconder
  // devolve a linha ao estado mascarado E descarta o texto claro da memória.
  async function toggleReveal(row: Row) {
    if (row.draft === null) {
      const value = row.savedKey ? await secretsApi.reveal(row.savedKey) : null
      patch(row.id, { draft: value ?? '', visible: true })
      return
    }
    if (row.visible && row.hasValue) patch(row.id, { visible: false, draft: null })
    else patch(row.id, { visible: !row.visible })
  }

  function addRow() {
    setRows((prev) => [...prev, emptyRow('')])
  }

  const customRows = rows.filter((row) => !KNOWN_KEYS.has(row.key.trim()))

  // Função de renderização, NÃO um componente: um componente declarado dentro do
  // corpo do pai é remontado a cada render e o input perderia o foco a cada tecla.
  function renderValue(row: Row) {
    const masked = row.draft === null
    return (
      <>
        <input
          type={row.visible ? 'text' : 'password'}
          value={row.draft ?? MASK}
          readOnly={masked}
          onChange={(e) => patch(row.id, { draft: e.target.value })}
          onBlur={() => void saveValue(row)}
          placeholder="valor"
          spellCheck={false}
          autoComplete="off"
          title={masked ? 'Revele para editar' : undefined}
          className="min-w-0 flex-1 rounded border border-[var(--color-border)] bg-[var(--color-bg)]/60 px-2 py-1 font-mono text-xs text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]"
        />
        <button
          type="button"
          onClick={() => void toggleReveal(row)}
          title={row.visible ? 'Ocultar valor' : 'Mostrar valor'}
          className="shrink-0 rounded p-1 text-[var(--color-text-dim)] transition hover:text-[var(--color-text)]"
        >
          {row.visible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
        </button>
      </>
    )
  }

  return (
    <div className="space-y-4">
      {status && <EncryptionNotice status={status} />}

      <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)]/40 p-3">
        <div className="mb-1 text-xs font-medium uppercase tracking-wide text-[var(--color-text-dim)]">
          Integrações
        </div>
        <p className="mb-3 text-xs text-[var(--color-text-dim)]">
          Credenciais que o app sabe usar. Sem elas, a funcionalidade correspondente fica
          desligada.
        </p>

        <div className="space-y-3">
          {KNOWN_ENV_VARS.map((integration) => {
            const row = rows.find((r) => r.key === integration.envKey)
            if (!row) return null
            const configured = row.hasValue || (row.draft ?? '').length > 0
            return (
              <div key={integration.envKey} className="space-y-1">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium text-[var(--color-text)]">
                    {integration.label}
                  </span>
                  <span
                    className="rounded-full border px-1.5 py-0.5 text-[10px]"
                    style={{
                      color: configured
                        ? 'var(--color-success, #22c55e)'
                        : 'var(--color-text-dim)',
                      borderColor: configured
                        ? 'var(--color-success, #22c55e)'
                        : 'var(--color-border)',
                    }}
                  >
                    {configured ? 'configurada' : 'não configurada'}
                  </span>
                  <span className="truncate text-[11px] text-[var(--color-text-dim)]">
                    {integration.unlocks}
                  </span>
                  <a
                    href={integration.docsUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="ml-auto shrink-0 text-[11px] text-[var(--color-accent)] hover:underline"
                  >
                    Obter chave
                  </a>
                </div>
                <div className="flex items-center gap-2">
                  <span className="w-40 shrink-0 truncate font-mono text-xs text-[var(--color-text-dim)]">
                    {integration.envKey}
                  </span>
                  {renderValue(row)}
                </div>
              </div>
            )
          })}
        </div>
      </div>

      <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)]/40 p-3">
        <div className="mb-1 text-xs font-medium uppercase tracking-wide text-[var(--color-text-dim)]">
          Variáveis de ambiente
        </div>
        <p className="mb-3 text-xs text-[var(--color-text-dim)]">
          Injetadas nos processos abertos pelo app (sidecar de transcrição, extração via
          claude). Têm precedência sobre as variáveis herdadas do sistema. Os valores ficam
          cifrados e mascarados até você revelar.
        </p>

        {customRows.length === 0 ? (
          <div className="py-4 text-center text-xs text-[var(--color-text-dim)]">
            Nenhuma variável definida.
          </div>
        ) : (
          <div className="space-y-2">
            {customRows.map((row) => (
              <div key={row.id} className="flex items-center gap-2">
                <input
                  type="text"
                  value={row.key}
                  onChange={(e) => patch(row.id, { key: e.target.value })}
                  onBlur={() => void saveKey(row)}
                  placeholder="NOME"
                  spellCheck={false}
                  autoComplete="off"
                  className="w-40 shrink-0 rounded border border-[var(--color-border)] bg-[var(--color-bg)]/60 px-2 py-1 font-mono text-xs text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]"
                />
                <span className="text-[var(--color-text-dim)]">=</span>
                {renderValue(row)}
                <button
                  type="button"
                  onClick={() => void removeRow(row)}
                  title="Remover"
                  className="shrink-0 rounded p-1 text-[var(--color-text-dim)] transition hover:text-[var(--color-danger,#ef4444)]"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            ))}
          </div>
        )}

        <button
          type="button"
          onClick={addRow}
          className="mt-3 inline-flex items-center gap-1 rounded-md border border-[var(--color-border)] px-2.5 py-1 text-xs text-[var(--color-text-dim)] transition hover:text-[var(--color-text)]"
        >
          <Plus className="h-3.5 w-3.5" />
          Adicionar variável
        </button>
      </div>
    </div>
  )
}
