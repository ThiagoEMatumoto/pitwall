import { chatApi } from '@/lib/ipc'

// O main mantém um watcher por sessionId (watch idempotente, unwatch apaga).
// Com 2+ ChatViews da mesma sessão (Room + Peek, MotherDock + Peek) o primeiro
// unmount derrubaria o watcher dos outros. O contador fica no renderer porque um
// reload zera ele junto com os consumidores; no main sobraria contagem órfã.
const refs = new Map<string, number>()

export function acquireChatWatch(sessionId: string): void {
  const n = refs.get(sessionId) ?? 0
  refs.set(sessionId, n + 1)
  if (n === 0) chatApi.watch(sessionId)
}

export function releaseChatWatch(sessionId: string): void {
  const n = refs.get(sessionId) ?? 0
  if (n <= 1) {
    refs.delete(sessionId)
    if (n === 1) chatApi.unwatch(sessionId)
    return
  }
  refs.set(sessionId, n - 1)
}

export function chatWatchCountForTest(sessionId: string): number {
  return refs.get(sessionId) ?? 0
}
