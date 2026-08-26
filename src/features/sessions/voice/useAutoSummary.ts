import { useEffect, useState } from 'react'
import { voiceApi } from '@/lib/ipc'

// Toggle do resumo automático DESTA sessão (fim de turno → resumo no chip).
// A fonte da verdade é o Set no main (voice-summary.ts) — ele sobrevive a
// re-render e remount do pane; aqui só um espelho re-consultado no mount.
// Vive no dono do rodapé pra sobreviver ao controle migrar pro overflow.
export function useAutoSummary(ccSessionId: string | null) {
  // null = consultando o main. Não forçar "desligado" evita o flicker na troca
  // de sessão; desabilitar o clique até a resposta pousar elimina a corrida em
  // que o autoSummaryGet em voo sobrescreveria a interação do usuário.
  const [enabled, setEnabled] = useState<boolean | null>(null)

  useEffect(() => {
    // Reset ANTES do early-return: sem sessão CC o controle pode ser montado
    // pelo menu de overflow, e manter o valor da sessão anterior mostraria um
    // toggle ligado que não pertence a ninguém.
    setEnabled(null)
    if (!ccSessionId) return
    let alive = true
    void voiceApi.autoSummaryGet(ccSessionId).then((v) => {
      if (alive) setEnabled(v)
    })
    return () => {
      alive = false
    }
  }, [ccSessionId])

  function toggle() {
    if (!ccSessionId) return
    if (enabled === null) return
    const next = !enabled
    setEnabled(next)
    void voiceApi.autoSummarySet(ccSessionId, next)
  }

  return { enabled, toggle }
}
