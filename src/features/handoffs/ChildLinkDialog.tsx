// Vínculo de uma sessão que JÁ é (ou foi) filha: re-vincular o mesmo handoff,
// trocar a mãe ou desvincular. Em geral nada aqui reinicia o processo — diferente da
// adoção, que relança pra fixar apelido e canal. Exceção: `link.relinkRestarts`
// (filha viva retomada como sessão comum), que o texto e o botão avisam. Quem
// decide o que é oferecido é a régua única childLinkState (a mesma do backend).

import { useEffect, useState } from 'react'
import { Dialog } from '@/components/ui/Dialog'
import { Button } from '@/components/ui/Button'
import { handoffsApi } from '@/lib/ipc'
import { useMotherPinsStore } from '@/features/sessions/mother-pins-store'
import { MotherSessionPicker } from './MotherSessionPicker'
import type { ChildLinkInfo } from '../../../shared/types/ipc'

interface Props {
  open: boolean
  onClose: () => void
  sessionId: string
  displayTitle: string
  link: ChildLinkInfo
  onChanged?: () => void
  // Vínculo ENCERRADO (state 'none' com handoff): a árvore ainda aninha a sessão
  // sob a mãe; aqui o humano desvincula ou cria um vínculo novo (adoção).
  onAdoptNew?: () => void
}

export function ChildLinkDialog({
  open,
  onClose,
  sessionId,
  displayTitle,
  link,
  onChanged,
  onAdoptNew,
}: Props) {
  const current = link.handoff?.motherSessionId ?? null
  const [motherSessionId, setMotherSessionId] = useState<string | null>(current)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setMotherSessionId(current)
    setBusy(false)
    setError(null)
  }, [open, current])

  const relinkable = link.state === 'relinkable'
  const restarts = relinkable && link.relinkRestarts
  const ended = link.state === 'none'

  async function run(action: () => Promise<unknown>) {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await action()
      onChanged?.()
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  const changedMother = !!motherSessionId && motherSessionId !== current

  function confirm() {
    if (relinkable) {
      return run(() =>
        handoffsApi.relinkChild({
          sessionId,
          ...(changedMother ? { motherSessionId: motherSessionId! } : {}),
        }),
      )
    }
    if (!changedMother || !link.handoff) return
    return run(() =>
      handoffsApi.setMother({ id: link.handoff!.id, motherSessionId: motherSessionId! }),
    )
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={relinkable ? 'Re-vincular à mãe' : ended ? 'Vínculo encerrado' : 'Vínculo com a mãe'}
      footer={
        <>
          <Button
            variant="ghost"
            data-testid="child-link-detach"
            onClick={() => void run(() => handoffsApi.detachChild(sessionId))}
            disabled={busy}
          >
            Desvincular
          </Button>
          <Button
            variant="ghost"
            data-testid="child-link-promote"
            title="Solta da mãe, traz as filhas dela, fixa como mãe e reinicia sem as travas de filha quando terminar o turno (o worktree fica)."
            onClick={() =>
              void run(() => useMotherPinsStore.getState().promote(sessionId, 'when-idle'))
            }
            disabled={busy}
          >
            Tornar mãe
          </Button>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancelar
          </Button>
          {ended ? (
            <Button
              data-testid="child-link-adopt-new"
              onClick={() => {
                onClose()
                onAdoptNew?.()
              }}
              disabled={busy || !onAdoptNew}
            >
              Tornar filha de novo
            </Button>
          ) : (
            <Button
              data-testid="child-link-confirm"
              onClick={() => void confirm()}
              disabled={busy || (!relinkable && !changedMother)}
            >
              {restarts ? 'Reiniciar e re-vincular' : relinkable ? 'Re-vincular' : 'Trocar mãe'}
            </Button>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="text-xs text-[var(--color-text-dim)]">
          <span className="text-[var(--color-text)]">{displayTitle}</span>{' '}
          {restarts
            ? 'tem um vínculo interrompido ou dispensado e foi retomada como sessão comum — sem apelido e sem canal de entrada, a mãe não consegue falar com ela. Re-vincular REINICIA a sessão (o histórico volta por --resume; o turno em andamento se perde) para devolver os dois.'
            : relinkable
              ? 'tem um vínculo interrompido ou dispensado. Re-vincular reativa o MESMO handoff — sem criar outro e sem reiniciar a sessão.'
              : ended
                ? 'foi filha de um handoff já encerrado e segue aninhada sob a mãe. Desvincular a devolve ao nível de mãe; tornar filha de novo cria um vínculo novo (reinicia a sessão).'
                : 'é filha de um handoff ativo. Dá pra trocar a mãe só desta filha, ou desvincular (ela volta a ser uma sessão comum).'}
        </div>
        {!ended && (
          <MotherSessionPicker
            value={motherSessionId}
            onChange={setMotherSessionId}
            excludeSessionId={sessionId}
          />
        )}
        {error && (
          <div data-testid="child-link-error" className="text-xs text-[var(--color-danger)]">
            {error}
          </div>
        )}
      </div>
    </Dialog>
  )
}
