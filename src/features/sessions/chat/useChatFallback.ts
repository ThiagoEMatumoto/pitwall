import { useEffect } from 'react'
import { chatApi } from '@/lib/ipc'
import type { ChatFallbackKind, ChatFallbackReason } from '../../../../shared/chat/fallback'

// Só conta o fallback que ficou na tela: logo depois de responder, ou antes do 1º
// parse do menu, um banner pisca por um instante e não mandou ninguém ao terminal.
export const FALLBACK_STABLE_MS = 1500

export function useChatFallback(kind: ChatFallbackKind | null, reason: ChatFallbackReason): void {
  useEffect(() => {
    if (!kind) return
    const t = setTimeout(() => {
      void chatApi.noteFallback?.(kind, reason)?.catch(() => {})
    }, FALLBACK_STABLE_MS)
    return () => clearTimeout(t)
  }, [kind, reason])
}
