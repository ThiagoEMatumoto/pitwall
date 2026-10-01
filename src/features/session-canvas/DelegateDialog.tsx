import { useEffect, useRef, useState } from 'react'
import { Dialog } from '@/components/ui/Dialog'
import { Button } from '@/components/ui/Button'
import { handoffsApi, projectsApi } from '@/lib/ipc'
import { showToast } from '@/features/notifications/toast-store'
import { dispatchHandoffChild } from '@/features/handoffs/spawn-child'

export interface DelegateTarget {
  motherSessionId: string
  motherTitle: string
  // null = a mãe não tem repo (avulsa): o seletor começa no 1º repo.
  targetRepoId: string | null
  targetRepoLabel: string | null
  // "Nova filha" do cartão: o repo é trocável. O fio arrastado já escolheu o repo.
  pickRepo?: boolean
}

interface RepoOption {
  id: string
  label: string
  projectName: string
}

async function loadRepos(): Promise<RepoOption[]> {
  const projects = await projectsApi.list()
  const perProject = await Promise.all(
    projects.map(async (p) =>
      (await projectsApi.listRepos(p.id)).map((r) => ({
        id: r.id,
        label: r.label,
        projectName: p.name,
      })),
    ),
  )
  return perProject.flat()
}

// Arrastar o fio de uma sessão até a lane de outro repo, ou "Nova filha" no
// cartão = delegar. Mesmo caminho
// da criação manual de filha (NewSessionFlow): o main compõe o briefing e o
// apelido, e o spawn sai daqui pelo dispatch compartilhado — que carimba failed
// se quebrar. A filha nasce no Crew Dock, não como aba.
export function DelegateDialog({
  target,
  onClose,
}: {
  target: DelegateTarget | null
  onClose: () => void
}) {
  const [task, setTask] = useState('')
  const [busy, setBusy] = useState(false)
  const [repos, setRepos] = useState<RepoOption[]>([])
  const [repoId, setRepoId] = useState<string | null>(null)
  const ref = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (!target) return
    setTask('')
    setRepoId(target.targetRepoId)
    requestAnimationFrame(() => ref.current?.focus())
    if (!target.pickRepo) return
    let cancelled = false
    void loadRepos().then((list) => {
      if (cancelled) return
      setRepos(list)
      setRepoId((cur) => cur ?? list[0]?.id ?? null)
    })
    return () => {
      cancelled = true
    }
  }, [target])

  const repoLabel =
    repos.find((r) => r.id === repoId)?.label ?? target?.targetRepoLabel ?? 'outro repo'

  async function delegate() {
    if (!target || !repoId || !task.trim() || busy) return
    setBusy(true)
    try {
      const { handoff, alias } = await handoffsApi.createManual({
        repoId,
        motherSessionId: target.motherSessionId,
        task: task.trim(),
        mode: 'interactive',
      })
      onClose()
      await dispatchHandoffChild(handoff.id, () => ({
        repoId,
        alias,
        systemPromptText: handoff.composedPrompt,
      }))
    } catch (err) {
      showToast({
        title: 'Não foi possível delegar',
        body: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={!!target}
      onClose={onClose}
      title={target ? `Nova filha em ${repoLabel}` : 'Nova filha'}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            data-testid="delegate-submit"
            onClick={() => void delegate()}
            disabled={!task.trim() || !repoId}
            loading={busy}
          >
            Delegar
          </Button>
        </>
      }
    >
      {target && (
        <div className="flex flex-col gap-2 text-sm">
          <div className="text-xs text-[var(--color-text-dim)]">
            De <span className="text-[var(--color-text)]">{target.motherTitle}</span> para uma nova
            sessão-filha em <span className="text-[var(--color-text)]">{repoLabel}</span>. Ela nasce
            no Crew Dock e aparece ligada à mãe no mapa.
          </div>
          {target.pickRepo && repos.length > 0 && (
            <select
              data-testid="delegate-repo"
              value={repoId ?? ''}
              onChange={(e) => setRepoId(e.target.value)}
              aria-label="Repo da filha"
              className="w-full rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-sm text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]"
            >
              {repos.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.label} · {r.projectName}
                </option>
              ))}
            </select>
          )}
          <textarea
            ref={ref}
            value={task}
            onChange={(e) => setTask(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void delegate()
            }}
            rows={4}
            placeholder="O que a filha deve fazer?"
            className="w-full resize-y rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-sm text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]"
          />
          <div className="text-[11px] text-[var(--color-text-dim)]">Ctrl+Enter delega</div>
        </div>
      )}
    </Dialog>
  )
}
