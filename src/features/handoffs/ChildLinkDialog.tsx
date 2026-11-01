// Vínculo de uma sessão que JÁ é (ou foi) filha: re-vincular o mesmo handoff,
// trocar a mãe ou desvincular. Nada aqui reinicia o processo — diferente da adoção,
// que relança pra fixar apelido e canal. Quem decide o que é oferecido é a régua
// única childLinkState (a mesma do backend), vinda em `link`.

import { useEffect, useState } from 'react'
import { Dialog } from '@/components/ui/Dialog'
import { Button } from '@/components/ui/Button'
import { handoffsApi } from '@/lib/ipc'
import { MotherSessionPicker } from './MotherSessionPicker'
import type { ChildLinkInfo } from '../../../shared/types/ipc'

interface Props {
  open: boolean
  onClose: () => void
  sessionId: string
  displayTitle: string
  link: ChildLinkInfo
  onChanged?: () => void
}

export function ChildLinkDialog({
  open,
  onClose,
  sessionId,
  displayTitle,
  link,
  onChanged,
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
      title={relinkable ? 'Re-vincular à mãe' : 'Vínculo com a mãe'}
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
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancelar
          </Button>
          <Button
            data-testid="child-link-confirm"
            onClick={() => void confirm()}
            disabled={busy || (!relinkable && !changedMother)}
          >
            {relinkable ? 'Re-vincular' : 'Trocar mãe'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="text-xs text-[var(--color-text-dim)]">
          <span className="text-[var(--color-text)]">{displayTitle}</span>{' '}
          {relinkable
            ? 'tem um vínculo interrompido ou dispensado. Re-vincular reativa o MESMO handoff — sem criar outro e sem reiniciar a sessão.'
            : 'é filha de um handoff ativo. Dá pra trocar a mãe só desta filha, ou desvincular (ela volta a ser uma sessão comum).'}
        </div>
        <MotherSessionPicker
          value={motherSessionId}
          onChange={setMotherSessionId}
          excludeSessionId={sessionId}
        />
        {error && (
          <div data-testid="child-link-error" className="text-xs text-[var(--color-danger)]">
            {error}
          </div>
        )}
      </div>
    </Dialog>
  )
}
