import { useEffect, useMemo, useState } from 'react'
import { Dialog } from '@/components/ui/Dialog'
import { Button } from '@/components/ui/Button'
import { prefsApi } from '@/lib/ipc'
import { useAppStore } from '@/store/appStore'
import { pendingHandoffs, useHandoffsStore } from '@/store/handoffsStore'
import { HANDOFFS_REQUIRE_APPROVAL_KEY } from './useHandoffs'

// Gate humano de handoffs cross-repo — DESLIGADO por default. Sempre montado no
// AppShell, mas só abre quando a pref handoffs.requireApproval está ligada (o
// kill-switch): no caminho normal a filha nasce direto pelo main e o usuário é
// avisado por toast (handoffsStore), não por modal. Ligado, mostra um pendente
// por vez (o mais antigo), com o prompt composto editável.
export function HandoffApprovalDialog() {
  const handoffs = useHandoffsStore((s) => s.handoffs)
  const approve = useHandoffsStore((s) => s.approve)
  const reject = useHandoffsStore((s) => s.reject)
  const error = useHandoffsStore((s) => s.error)

  const pending = useMemo(() => pendingHandoffs(handoffs), [handoffs])

  // O mais antigo (lista vem ordenada do store/list; createdAt asc por padrão).
  const handoff = useMemo(
    () => [...pending].sort((a, b) => a.createdAt - b.createdAt)[0] ?? null,
    [pending],
  )

  const [requireApproval, setRequireApproval] = useState(false)
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState(false)

  // Label do repo-alvo já vem resolvido do store (LEFT JOIN repos); fallback no id.
  const repoLabel = handoff?.targetRepoLabel ?? handoff?.targetRepoId ?? null

  // Lê o pref e reage a mudanças (Settings emite via prefs:updated? usamos o valor
  // no mount + re-leitura sempre que o handoff atual muda, suficiente pro fluxo).
  useEffect(() => {
    void prefsApi
      .get<boolean>(HANDOFFS_REQUIRE_APPROVAL_KEY)
      .then((v) => setRequireApproval(v ?? false))
  }, [handoff?.id])

  // Pré-preenche o textarea quando o handoff muda.
  useEffect(() => {
    setPrompt(handoff?.composedPrompt ?? '')
  }, [handoff])

  const open = !!handoff && requireApproval

  async function onApprove() {
    if (!handoff) return
    setBusy(true)
    try {
      await approve(handoff.id, prompt)
      // Pane abriu na área de projetos — leva o usuário pra lá.
      useAppStore.getState().setArea('projects')
    } catch {
      // erro já está no store (exibido abaixo); mantém o dialog aberto.
    } finally {
      setBusy(false)
    }
  }

  async function onReject() {
    if (!handoff) return
    setBusy(true)
    try {
      await reject(handoff.id)
    } finally {
      setBusy(false)
    }
  }

  if (!handoff) return null

  return (
    <Dialog
      open={open}
      onClose={() => {
        /* gate obrigatório: fechar sem decidir não é permitido */
      }}
      title={`Handoff → ${repoLabel ?? handoff.targetRepoId}`}
      widthClassName="w-[40rem]"
      footer={
        <div className="flex w-full items-center justify-between gap-2">
          <Button variant="ghost" onClick={() => void onReject()} disabled={busy}>
            Rejeitar
          </Button>
          <Button variant="primary" onClick={() => void onApprove()} disabled={busy}>
            {busy ? 'Abrindo…' : 'Aprovar e abrir sessão'}
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <div>
          <div className="mb-1 text-xs font-medium uppercase tracking-wide text-[var(--color-text-dim)]">
            Tarefa
          </div>
          <div className="text-sm text-[var(--color-text)]">{handoff.task}</div>
        </div>

        <div>
          <div className="mb-1 text-xs font-medium uppercase tracking-wide text-[var(--color-text-dim)]">
            Prompt da sessão-filha (editável)
          </div>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            spellCheck={false}
            className="h-64 w-full resize-y rounded-md border border-[var(--color-border)] bg-[var(--color-bg)]/60 px-3 py-2 font-mono text-xs text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]"
          />
        </div>

        {pending.length > 1 && (
          <div className="text-xs text-[var(--color-text-dim)]">
            +{pending.length - 1} outro(s) handoff(s) pendente(s) na fila.
          </div>
        )}

        {error && (
          <div className="rounded-md border border-[var(--color-danger,#ef4444)] bg-[var(--color-danger,#ef4444)]/10 px-3 py-2 text-xs text-[var(--color-danger,#ef4444)]">
            {error}
          </div>
        )}
      </div>
    </Dialog>
  )
}
