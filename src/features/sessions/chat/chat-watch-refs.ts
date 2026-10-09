import { chatApi } from '@/lib/ipc'

// O main mantém um watcher por sessionId (watch idempotente, unwatch apaga).
// Com 2+ ChatViews da mesma sessão (Room + Peek, MotherDock + Peek) o primeiro
// unmount derrubaria o watcher dos outros. O contador fica no renderer porque um
// reload zera ele junto com os consumidores; no main sobraria contagem órfã.
//
// O main ignora o watch enquanto a sessão não tem ccSessionId (não há transcript
// a observar) e não guarda nada. Por isso lembramos se o watch já saiu com um cc
// id conhecido: enquanto não, quem trouxer o cc id refaz o watch.
type Entry = { count: number; ccSessionId: string | null }
const refs = new Map<string, Entry>()

export function acquireChatWatch(sessionId: string, ccSessionId: string | null = null): void {
  const entry = refs.get(sessionId)
  if (!entry) {
    refs.set(sessionId, { count: 1, ccSessionId })
    chatApi.watch(sessionId)
    return
  }
  entry.count += 1
  noteChatWatchCcSessionId(sessionId, ccSessionId)
}

// O cc id de uma sessão já assistida apareceu (ex.: chegou no snapshot de live
// sessions depois do mount): refaz o watch que o main descartou.
export function noteChatWatchCcSessionId(sessionId: string, ccSessionId: string | null): void {
  const entry = refs.get(sessionId)
  if (!entry || entry.ccSessionId || !ccSessionId) return
  entry.ccSessionId = ccSessionId
  chatApi.watch(sessionId)
}

export function releaseChatWatch(sessionId: string): void {
  const entry = refs.get(sessionId)
  if (!entry) return
  if (entry.count <= 1) {
    refs.delete(sessionId)
    chatApi.unwatch(sessionId)
    return
  }
  entry.count -= 1
}

export function chatWatchCountForTest(sessionId: string): number {
  return refs.get(sessionId)?.count ?? 0
}
