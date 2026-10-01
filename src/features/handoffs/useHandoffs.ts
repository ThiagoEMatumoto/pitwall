import { useEffect, useMemo, useRef, useState } from 'react'
import { prefsApi } from '@/lib/ipc'
import { pendingHandoffs, useHandoffsStore } from '@/store/handoffsStore'

// Kill-switch do gate humano. Default FALSE: delegar não pede aprovação — a MCP
// spawna a filha direto no main. Ligar reativa o modal (HandoffApprovalDialog),
// que volta a ser a única porta de entrada da sessão-filha.
export const HANDOFFS_REQUIRE_APPROVAL_KEY = 'handoffs.requireApproval'

// Monta a assinatura de handoffs (load + watch, StrictMode-safe via store). Com o
// gate DESLIGADO (default), o main já spawna sozinho; o loop abaixo só existe pra
// destravar pendentes remanescentes — criados enquanto o gate estava ligado, ou
// legados de antes desta mudança, que ficariam presos para sempre.
export function useHandoffs() {
  const load = useHandoffsStore((s) => s.load)
  const start = useHandoffsStore((s) => s.startUpdatedWatch)
  const stop = useHandoffsStore((s) => s.stopUpdatedWatch)
  const approve = useHandoffsStore((s) => s.approve)
  const handoffs = useHandoffsStore((s) => s.handoffs)
  const pending = useMemo(() => pendingHandoffs(handoffs), [handoffs])

  // null = pref ainda não chegou. Sem esperar por ela, o load() dos handoffs
  // costuma chegar antes e o loop aprovava os pending com o gate LIGADO.
  const [requireApproval, setRequireApproval] = useState<boolean | null>(null)
  // Ids já disparados, pra não tentar duas vezes enquanto o approve está em voo
  // (o handoff só sai de 'pending' após o markRunning).
  const firing = useRef(new Set<string>())

  useEffect(() => {
    void load()
    start()
    void prefsApi.get<boolean>(HANDOFFS_REQUIRE_APPROVAL_KEY).then((v) => {
      setRequireApproval(v ?? false)
    })
    return () => stop()
  }, [load, start, stop])

  useEffect(() => {
    if (requireApproval !== false) return
    for (const h of pending) {
      if (firing.current.has(h.id)) continue
      firing.current.add(h.id)
      void approve(h.id, h.composedPrompt).catch(() => {
        // Falhou: libera pra uma nova tentativa (ex: usuário liga/desliga o gate).
        firing.current.delete(h.id)
      })
    }
  }, [pending, approve, requireApproval])
}
