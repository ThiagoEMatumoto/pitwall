import { useEffect, useState } from 'react'
import {
  CheckCircle2,
  AlertTriangle,
  CloudOff,
  ArrowUp,
  ArrowDown,
  RefreshCw,
  Download,
  Upload,
} from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { dialogApi, syncApi } from '@/lib/ipc'
import type { SyncStatus, SyncNowResult, SyncBackupResult } from '../../../shared/types/ipc'

interface Props {
  open: boolean
}

type ActionKey = 'configure' | 'now' | 'export' | 'import' | 'resolve' | 'backup'

// Confirmação destrutiva inline: qual ação está aguardando confirmação.
type PendingConfirm =
  | { kind: 'export-force' }
  | { kind: 'import-force' }
  | { kind: 'resolve'; keep: 'local' | 'remote' }
  | { kind: 'backup-import' }
  | null

function formatTimestamp(ms: number | null): string {
  if (!ms) return 'nunca'
  return new Date(ms).toLocaleString()
}

function describeResult(r: SyncNowResult): string {
  switch (r.state) {
    case 'not-configured':
      return 'Sync não configurado.'
    case 'up-to-date':
      return 'Já está em sincronia.'
    case 'pushed':
      return 'Alterações enviadas para o remoto.'
    case 'pulled':
      return 'Alterações da outra máquina importadas.'
    case 'conflict':
      return `Conflito: ${r.ahead} commit(s) local(is) e ${r.behind} remoto(s) divergiram.`
  }
}

export function SyncTab({ open }: Props) {
  const [status, setStatus] = useState<SyncStatus | null>(null)
  const [repoUrl, setRepoUrl] = useState('')
  const [busy, setBusy] = useState<ActionKey | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [conflict, setConflict] = useState<{ ahead: number; behind: number } | null>(null)
  const [pending, setPending] = useState<PendingConfirm>(null)

  useEffect(() => {
    if (!open) return
    setError(null)
    setMessage(null)
    void refresh()
  }, [open])

  async function refresh() {
    try {
      const s = await syncApi.status()
      setStatus(s)
      if (s.repoUrl) setRepoUrl(s.repoUrl)
    } catch (e) {
      setError(errorText(e))
    }
  }

  function errorText(e: unknown): string {
    if (e instanceof Error) return e.message
    return String(e)
  }

  // Aplica o resultado de uma operação de sync: mensagem, estado de conflito, refresh.
  function applyResult(r: SyncNowResult) {
    setMessage(describeResult(r))
    if (r.state === 'conflict') setConflict({ ahead: r.ahead, behind: r.behind })
    else setConflict(null)
  }

  async function run(key: ActionKey, fn: () => Promise<void>) {
    setBusy(key)
    setError(null)
    setMessage(null)
    try {
      await fn()
      await refresh()
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(null)
    }
  }

  async function configure() {
    const url = repoUrl.trim()
    if (!url) {
      setError('Informe a URL do repositório.')
      return
    }
    await run('configure', async () => {
      const s = await syncApi.configure({ repoUrl: url })
      setStatus(s)
    })
  }

  // Abre o folder picker e grava a pasta-raiz dos projetos desta máquina.
  async function pickProjectsRoot() {
    const picked = await dialogApi.openDirectory()
    if (!picked) return
    await run('configure', async () => {
      const s = await syncApi.setProjectsRoot({ root: picked })
      setStatus(s)
    })
  }

  async function syncNow() {
    await run('now', async () => {
      const r = await syncApi.now()
      applyResult(r)
    })
  }

  function requestExportForce() {
    setPending({ kind: 'export-force' })
  }

  function requestImportForce() {
    setPending({ kind: 'import-force' })
  }

  function requestResolve(keep: 'local' | 'remote') {
    setPending({ kind: 'resolve', keep })
  }

  function requestBackupImport() {
    setPending({ kind: 'backup-import' })
  }

  // Descreve o resultado de um backup (independente do git).
  function describeBackup(r: SyncBackupResult): string | null {
    switch (r.state) {
      case 'canceled':
        return null // usuário fechou o dialog → sem feedback
      case 'exported':
        return `Backup salvo em ${r.path}`
      case 'imported':
        return `Backup restaurado de ${r.path}`
    }
  }

  // Export de backup: NÃO é destrutivo (não toca dados locais) → sem confirmação.
  async function backupExport() {
    await run('backup', async () => {
      const r = await syncApi.backupExport()
      const msg = describeBackup(r)
      if (msg) setMessage(msg)
    })
  }

  async function confirmPending() {
    if (!pending) return
    const action = pending
    setPending(null)
    if (action.kind === 'export-force') {
      await run('export', async () => {
        const r = await syncApi.exportForce()
        applyResult(r)
      })
    } else if (action.kind === 'import-force') {
      await run('import', async () => {
        const r = await syncApi.importForce()
        applyResult(r)
      })
    } else if (action.kind === 'backup-import') {
      await run('backup', async () => {
        const r = await syncApi.backupImport()
        const msg = describeBackup(r)
        if (msg) setMessage(msg)
      })
    } else {
      await run('resolve', async () => {
        const r = await syncApi.resolveConflict({ keep: action.keep })
        applyResult(r)
      })
    }
  }

  const configured = status?.configured ?? false
  const git = status?.git ?? null

  return (
    <div className="space-y-4">
      {error && (
        <div className="rounded-md border border-[var(--color-danger)] bg-[var(--color-danger)]/10 px-3 py-2 text-sm text-[var(--color-danger)]">
          {error}
        </div>
      )}
      {message && !error && (
        <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)]/40 px-3 py-2 text-sm text-[var(--color-text)]">
          {message}
        </div>
      )}

      {pending && (
        <ConfirmBanner
          pending={pending}
          onConfirm={confirmPending}
          onCancel={() => setPending(null)}
        />
      )}

      {/* Pasta-raiz dos projetos — sempre visível (inclusive no wizard), pois define
          a portabilidade de paths já no primeiro export. */}
      {status !== null && (
        <Section title="Pasta-raiz dos projetos">
          <p className="mb-2 text-xs text-[var(--color-text-dim)]">
            A pasta onde seus projetos vivem NESTA máquina. Caminhos abaixo dela são
            sincronizados de forma portável (cada máquina resolve contra a sua própria raiz).
          </p>
          <div className="flex items-center gap-2">
            <div className="flex-1 truncate rounded-md border border-[var(--color-border)] bg-[var(--color-bg)]/40 px-3 py-1.5 text-sm">
              {status.projectsRoot ? (
                <span className="font-mono">{status.projectsRoot}</span>
              ) : (
                <span className="text-[var(--color-text-dim)]">não definida</span>
              )}
            </div>
            <Button variant="ghost" loading={busy === 'configure'} onClick={pickProjectsRoot}>
              Escolher pasta…
            </Button>
          </div>
        </Section>
      )}

      {status === null ? (
        <div className="text-sm text-[var(--color-text-dim)]">carregando…</div>
      ) : !configured ? (
        <FirstRunWizard
          repoUrl={repoUrl}
          setRepoUrl={setRepoUrl}
          busy={busy}
          onConfigureExport={async () => {
            const url = repoUrl.trim()
            if (!url) {
              setError('Informe a URL do repositório.')
              return
            }
            setError(null)
            setBusy('configure')
            try {
              await syncApi.configure({ repoUrl: url })
              setPending({ kind: 'export-force' })
              await refresh()
            } catch (e) {
              setError(errorText(e))
            } finally {
              setBusy(null)
            }
          }}
          onConfigureImport={async () => {
            const url = repoUrl.trim()
            if (!url) {
              setError('Informe a URL do repositório.')
              return
            }
            setError(null)
            setBusy('configure')
            try {
              await syncApi.configure({ repoUrl: url })
              setPending({ kind: 'import-force' })
              await refresh()
            } catch (e) {
              setError(errorText(e))
            } finally {
              setBusy(null)
            }
          }}
        />
      ) : (
        <>
          {/* Configuração */}
          <Section title="Repositório">
            <div className="flex items-end gap-2">
              <Input
                label="URL do repositório Git privado"
                value={repoUrl}
                onChange={(e) => setRepoUrl(e.target.value)}
                placeholder="https://github.com/usuario/pitwall-data.git"
              />
              <Button onClick={configure} loading={busy === 'configure'}>
                Conectar
              </Button>
            </div>
            <div className="mt-2 text-xs text-[var(--color-text-dim)]">
              Esta máquina: <span className="font-mono">{status.machineId}</span>
            </div>
          </Section>

          {/* Status */}
          <Section title="Status">
            <div className="mb-3">
              <StateBadge status={status} conflict={conflict} />
            </div>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm">
              <Field label="Último pull" value={formatTimestamp(status.lastPullAt)} />
              <Field label="Último push" value={formatTimestamp(status.lastPushAt)} />
              <Field
                label="Alterações locais"
                value={git ? (git.dirty ? 'sim' : 'não') : '—'}
              />
              <Field label="Versão do schema" value={String(status.schemaVersion)} />
              {git && (
                <>
                  <Field label="Commits à frente (ahead)" value={String(git.ahead)} />
                  <Field label="Commits atrás (behind)" value={String(git.behind)} />
                </>
              )}
            </dl>
            {git === null && (
              <div className="mt-2 text-xs text-[var(--color-text-dim)]">
                Git indisponível (offline ou erro). Operando com dados locais.
              </div>
            )}
            {status.lastSyncState === 'schema-mismatch' && (
              <div className="mt-2 text-xs text-[var(--color-danger)]">
                O outro dispositivo gravou dados de uma versão mais nova do app. Atualize este app
                antes de sincronizar.
              </div>
            )}
            {status.lastError && status.lastSyncState === 'stale' && (
              <div className="mt-2 break-words text-xs text-[var(--color-text-dim)]">
                Último erro: {status.lastError}
              </div>
            )}
          </Section>

          {/* Resolução de conflito */}
          {conflict && (
            <Section title="Conflito de sincronização">
              <p className="mb-3 text-sm text-[var(--color-text-dim)]">
                As duas máquinas divergiram ({conflict.ahead} local / {conflict.behind} remoto).
                Escolha qual versão manter — a outra será sobrescrita.
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="danger"
                  loading={busy === 'resolve'}
                  onClick={() => requestResolve('local')}
                >
                  Manter esta máquina (sobrescreve remoto)
                </Button>
                <Button
                  variant="danger"
                  loading={busy === 'resolve'}
                  onClick={() => requestResolve('remote')}
                >
                  Usar a outra máquina (sobrescreve local)
                </Button>
              </div>
            </Section>
          )}

          {/* Ações */}
          <Section title="Ações">
            <div className="flex flex-wrap gap-2">
              <Button onClick={syncNow} loading={busy === 'now'}>
                <RefreshCw className="h-4 w-4" />
                Sincronizar agora
              </Button>
              <Button
                variant="ghost"
                loading={busy === 'export'}
                onClick={requestExportForce}
              >
                Forçar envio (sobrescreve remoto)
              </Button>
              <Button
                variant="ghost"
                loading={busy === 'import'}
                onClick={requestImportForce}
              >
                Forçar importação (sobrescreve local)
              </Button>
            </div>
          </Section>
        </>
      )}

      {/* Backup manual — independente do sync git; visível sempre. */}
      {status !== null && (
        <Section title="Backup manual">
          <p className="mb-3 text-xs text-[var(--color-text-dim)]">
            Exporte um arquivo <span className="font-mono">.zip</span> restaurável para onde quiser
            (não depende de repositório Git). Importar substitui os dados desta máquina.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button variant="ghost" loading={busy === 'backup'} onClick={backupExport}>
              <Download className="h-4 w-4" />
              Exportar backup (.zip)
            </Button>
            <Button variant="ghost" loading={busy === 'backup'} onClick={requestBackupImport}>
              <Upload className="h-4 w-4" />
              Importar backup (.zip)
            </Button>
          </div>
        </Section>
      )}
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)]/40 p-3">
      <div className="mb-2 text-xs font-medium uppercase tracking-wide text-[var(--color-text-dim)]">
        {title}
      </div>
      {children}
    </div>
  )
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-[var(--color-text-dim)]">{label}</dt>
      <dd className="text-right text-[var(--color-text)]">{value}</dd>
    </>
  )
}

function StateBadge({
  status,
  conflict,
}: {
  status: SyncStatus
  conflict: { ahead: number; behind: number } | null
}) {
  const git = status.git

  let label: string
  let tone: 'ok' | 'warn' | 'danger' | 'dim'
  let Icon = CheckCircle2

  // O estado PERSISTENTE do backend (lastSyncState) tem prioridade — sobrevive a
  // reabrir o dialog e carrega conflict/schema-mismatch/syncing detectados no
  // boot ou no auto-sync, que o git status sozinho não expressa. O `conflict`
  // local (de uma ação recém-feita) reforça o estado de conflito.
  if (status.lastSyncState === 'schema-mismatch') {
    label = 'Atualize o app antes de sincronizar'
    tone = 'danger'
    Icon = AlertTriangle
  } else if (conflict || status.lastSyncState === 'conflict') {
    label = 'Conflito'
    tone = 'danger'
    Icon = AlertTriangle
  } else if (status.lastSyncState === 'syncing') {
    label = 'Sincronizando…'
    tone = 'warn'
    Icon = RefreshCw
  } else if (status.lastSyncState === 'stale' || git === null) {
    label = 'Offline (stale)'
    tone = 'dim'
    Icon = CloudOff
  } else if (git.ahead > 0 && git.behind > 0) {
    label = 'Divergente'
    tone = 'danger'
    Icon = AlertTriangle
  } else if (git.ahead > 0 || git.dirty || status.lastSyncState === 'ahead') {
    label = 'À frente (não enviado)'
    tone = 'warn'
    Icon = ArrowUp
  } else if (git.behind > 0 || status.lastSyncState === 'behind') {
    label = 'Atrás (importar)'
    tone = 'warn'
    Icon = ArrowDown
  } else {
    label = 'Em sincronia'
    tone = 'ok'
    Icon = CheckCircle2
  }

  const tones: Record<typeof tone, string> = {
    ok: 'border-[var(--color-accent)] text-[var(--color-accent)]',
    warn: 'border-[var(--color-border)] text-[var(--color-text)]',
    danger: 'border-[var(--color-danger)] text-[var(--color-danger)]',
    dim: 'border-[var(--color-border)] text-[var(--color-text-dim)]',
  }

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs ${tones[tone]}`}
    >
      <Icon className="h-3.5 w-3.5" />
      {label}
    </span>
  )
}

function ConfirmBanner({
  pending,
  onConfirm,
  onCancel,
}: {
  pending: NonNullable<PendingConfirm>
  onConfirm: () => void
  onCancel: () => void
}) {
  const text =
    pending.kind === 'export-force'
      ? 'Isto vai SOBRESCREVER os dados no repositório remoto com os desta máquina. Continuar?'
      : pending.kind === 'import-force'
        ? 'Isto vai SOBRESCREVER os dados desta máquina com os do remoto. Continuar?'
        : pending.kind === 'backup-import'
          ? 'Importar o backup vai SOBRESCREVER os dados desta máquina pelos do arquivo .zip. Continuar?'
          : pending.keep === 'local'
            ? 'Manter esta máquina vai SOBRESCREVER o remoto. Continuar?'
            : 'Usar a outra máquina vai SOBRESCREVER os dados locais. Continuar?'

  return (
    <div className="rounded-md border border-[var(--color-danger)] bg-[var(--color-danger)]/10 p-3">
      <div className="mb-2 flex items-start gap-2 text-sm text-[var(--color-text)]">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-danger)]" />
        <span>{text}</span>
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" className="h-7 px-2 text-xs" onClick={onCancel}>
          Cancelar
        </Button>
        <Button variant="danger" className="h-7 px-2 text-xs" onClick={onConfirm}>
          Sim, sobrescrever
        </Button>
      </div>
    </div>
  )
}

function FirstRunWizard({
  repoUrl,
  setRepoUrl,
  busy,
  onConfigureExport,
  onConfigureImport,
}: {
  repoUrl: string
  setRepoUrl: (v: string) => void
  busy: ActionKey | null
  onConfigureExport: () => void
  onConfigureImport: () => void
}) {
  return (
    <div className="space-y-4">
      <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)]/40 p-3">
        <div className="mb-2 text-xs font-medium uppercase tracking-wide text-[var(--color-text-dim)]">
          Primeira configuração
        </div>
        <p className="mb-3 text-sm text-[var(--color-text-dim)]">
          Sincronize seus dados (objetivos, features, tarefas) entre máquinas usando um
          repositório Git privado. Comece informando a URL do repositório.
        </p>
        <Input
          label="URL do repositório Git privado"
          value={repoUrl}
          onChange={(e) => setRepoUrl(e.target.value)}
          placeholder="https://github.com/usuario/pitwall-data.git"
        />
      </div>

      <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)]/40 p-3">
        <div className="mb-1 text-sm font-medium text-[var(--color-text)]">
          A · Esta é minha máquina principal
        </div>
        <p className="mb-3 text-xs text-[var(--color-text-dim)]">
          Use os dados desta máquina como ponto de partida: conecta o repositório e envia
          (sobrescreve o remoto). Faça isto primeiro, em uma única máquina.
        </p>
        <Button loading={busy === 'configure'} onClick={onConfigureExport}>
          Conectar, exportar e enviar
        </Button>
      </div>

      <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)]/40 p-3">
        <div className="mb-1 text-sm font-medium text-[var(--color-text)]">
          B · Já tenho dados em outra máquina
        </div>
        <p className="mb-3 text-xs text-[var(--color-text-dim)]">
          Clona o repositório já populado e importa (sobrescreve os dados locais). Use depois
          de ter feito o passo A em outra máquina.
        </p>
        <Button variant="ghost" loading={busy === 'configure'} onClick={onConfigureImport}>
          Conectar, clonar e importar
        </Button>
      </div>
    </div>
  )
}
