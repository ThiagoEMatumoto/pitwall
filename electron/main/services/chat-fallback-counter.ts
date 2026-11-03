import type {
  ChatFallbackCounters,
  ChatFallbackKind,
  ChatFallbackReason,
} from '../../../shared/chat/fallback'
import { getPref, setPref } from './prefs-store'

export const CHAT_FALLBACK_PREF = 'chat_fallback_counts'

const EMPTY: ChatFallbackCounters = { chatFallbacks: {}, lastChatFallbackAt: null }

interface Store {
  get(): ChatFallbackCounters
  set(value: ChatFallbackCounters): void
}

const prefStore: Store = {
  get: () => getPref<ChatFallbackCounters>(CHAT_FALLBACK_PREF, EMPTY),
  set: (value) => setPref(CHAT_FALLBACK_PREF, value),
}

// Persistido a cada ocorrência (raras: uma por fallback que ficou na tela), pra
// sobreviver a restart; lido pelo sessions:attention-debug junto do unparsed.
export function noteChatFallback(
  kind: ChatFallbackKind,
  reason: ChatFallbackReason,
  store: Store = prefStore,
  now = Date.now(),
): ChatFallbackCounters {
  const prev = store.get()
  const key = `${kind}:${reason}`
  const next: ChatFallbackCounters = {
    chatFallbacks: { ...prev.chatFallbacks, [key]: (prev.chatFallbacks[key] ?? 0) + 1 },
    lastChatFallbackAt: now,
  }
  store.set(next)
  console.warn(
    JSON.stringify({ event: 'chat_fallback_terminal', key, total: next.chatFallbacks[key] }),
  )
  return next
}

export function chatFallbackCounters(store: Store = prefStore): ChatFallbackCounters {
  return store.get()
}
