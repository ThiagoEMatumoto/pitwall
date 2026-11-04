import { useEffect, useState } from 'react'
import { chatApi } from '@/lib/ipc'
import type { ChatFallbackKind, ChatFallbackReason } from '../../../../shared/chat/fallback'

// Só conta o fallback que ficou na tela: logo depois de responder, ao fechar um diálogo
// da CLI ou antes do 1º parse do menu, o status fica 'waiting' por um instante sem nada
// a mostrar, e isso não mandou ninguém ao terminal.
export const FALLBACK_STABLE_MS = 1500

// Devolve true quando o fallback está estável: a mesma condição que o conta. Quem mostra
// o banner usa esse retorno, então banner e contador nunca discordam. A chave (e não um
// boolean) evita que a troca direta de kind herde o "estável" do anterior por um render.
export function useChatFallback(kind: ChatFallbackKind | null, reason: ChatFallbackReason): boolean {
  const key = kind ? `${kind}:${reason}` : null
  const [stableKey, setStableKey] = useState<string | null>(null)
  useEffect(() => {
    if (!kind) return
    const t = setTimeout(() => {
      setStableKey(`${kind}:${reason}`)
      void chatApi.noteFallback?.(kind, reason)?.catch(() => {})
    }, FALLBACK_STABLE_MS)
    return () => {
      clearTimeout(t)
      setStableKey(null)
    }
  }, [kind, reason])
  return key != null && stableKey === key
}
