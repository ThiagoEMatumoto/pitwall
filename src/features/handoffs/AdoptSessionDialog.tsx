// Adoção de uma sessão JÁ aberta: "esta sessão é filha de X". Pergunta as duas
// coisas que a adoção precisa — a MÃE (endereço de volta) e a TAREFA (que dá
// escopo ao apelido) — e avisa, de forma inequívoca, do custo: a sessão REINICIA.
//
// O aviso não é decoração. Ser filha endereçável depende de flags fixadas no exec
// (o `-n <alias>` e o accept-inbound), então adotar relança o processo por
// --resume: o histórico volta, mas um turno em andamento se perde. O usuário
// aceitou esse custo — precisa é vê-lo antes de confirmar, não depois.

import { useEffect, useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import { Dialog } from '@/components/ui/Dialog'
import { Button } from '@/components/ui/Button'
import { Icon } from '@/components/ui/Icon'
import { handoffsApi } from '@/lib/ipc'
import { MotherSessionPicker } from './MotherSessionPicker'
import type { AdoptedSession } from '../../../shared/types/ipc'

interface Props {
  open: boolean
  onClose: () => void
  // Sessão candidata a filha (sessions.id) e como ela aparece hoje na UI.
  sessionId: string
  displayTitle: string
  // Chamado só depois da adoção dar certo — é aqui que o caller fecha a pane (a
  // sessão passa a viver no painel da equipe).
  onAdopted?: (result: AdoptedSession) => void
}

export function AdoptSessionDialog({ open, onClose, sessionId, displayTitle, onAdopted }: Props) {
  const [motherSessionId, setMotherSessionId] = useState<string | null>(null)
  const [task, setTask] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Reabrir o diálogo não herda a escolha anterior nem um erro velho.
  useEffect(() => {
    if (!open) return
    setMotherSessionId(null)
    setTask('')
    setBusy(false)
    setError(null)
  }, [open])

  const ready = !!motherSessionId && task.trim().length > 0

  async function confirm() {
    // Guarda de verdade (não só o disabled do botão): sem mãe não há endereço de
    // volta, e sem tarefa o apelido não tem escopo — nada disso pode ser inferido.
    if (!ready || busy) return
    setBusy(true)
    setError(null)
    try {
      const result = await handoffsApi.adoptSession({
        sessionId,
        motherSessionId: motherSessionId!,
        task: task.trim(),
      })
      onAdopted?.(result)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Tornar sessão filha"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancelar
          </Button>
          <Button onClick={() => void confirm()} disabled={!ready || busy}>
            {busy ? 'Adotando…' : 'Adotar e reiniciar'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="text-xs text-[var(--color-text-dim)]">
          <span className="text-[var(--color-text)]">{displayTitle}</span> passa a viver no painel da
          equipe, com apelido endereçável pela mãe.
        </div>

        <div
          data-testid="adopt-restart-warning"
          className="flex items-start gap-2 rounded-md border border-[var(--color-warning)]/50 bg-[var(--color-warning)]/5 px-3 py-2 text-xs"
        >
          <Icon as={AlertTriangle} size={14} className="mt-0.5 shrink-0 text-[var(--color-danger)]" />
          <div>
            <div className="font-medium text-[var(--color-text)]">
              A sessão será REINICIADA agora.
            </div>
            <div className="mt-0.5 text-[var(--color-text-dim)]">
              O apelido e o canal de mensagens só se fixam no start do processo, então adotar mata o
              processo atual e o sobe de novo com <code>--resume</code>. O histórico volta inteiro;{' '}
              <span className="text-[var(--color-text)]">
                um turno em andamento se perde (o que estiver rodando agora é interrompido)
              </span>
              .
            </div>
          </div>
        </div>

        <MotherSessionPicker
          value={motherSessionId}
          onChange={setMotherSessionId}
          excludeSessionId={sessionId}
        />

        <div className="w-full">
          <label className="mb-1 block text-xs text-[var(--color-text-dim)]">
            Tarefa desta filha
          </label>
          <textarea
            data-testid="adopt-task"
            value={task}
            onChange={(e) => setTask(e.target.value)}
            placeholder="O que ela vai fazer — vira o escopo do apelido"
            rows={2}
            className="w-full resize-y rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
          />
        </div>

        {error && (
          <div data-testid="adopt-error" className="text-xs text-[var(--color-danger)]">
            {error}
          </div>
        )}
      </div>
    </Dialog>
  )
}
