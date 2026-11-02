// Quando gerar o título automático de uma sessão não-filha (fonte 'llm').
//
// O gatilho é o rebuild do grafo de sessões (ipc/session-graph.ts), que já roda
// a cada mudança de atividade e quando o índice acha um transcript novo: consider()
// recebe os nós e só age em quem é candidata E já tem 1º prompt. É idempotente
// (uma geração por conversa, trava por cc_session_id) e barata (readFirstPrompt
// cacheia o positivo para sempre e o miss de sessão viva por 30s).
//
// Nunca em massa: só sessão viva, no máximo AUTO_TITLE_MAX_CONCURRENT ao mesmo
// tempo. Falha não grava e re-tenta uma vez depois de AUTO_TITLE_RETRY_MS. Os
// contadores (stats) saem em log estruturado a cada desfecho: uma supressão total
// aparece como attempts subindo com succeeded parado.
import type { SessionGraphNode } from '../../../shared/types/session-graph'
import type { SessionTitleResult } from './session-purpose'
import { isChildSessionNode } from '../../../shared/session-title'

export const AUTO_TITLE_MAX_CONCURRENT = 2
export const AUTO_TITLE_RETRY_MS = 5 * 60_000
export const AUTO_TITLE_MAX_ATTEMPTS = 2

export type AutoTitleNode = Pick<
  SessionGraphNode,
  | 'sessionId'
  | 'ccSessionId'
  | 'provider'
  | 'status'
  | 'titleSource'
  | 'autoTitle'
  | 'hierarchyMotherId'
  | 'childOfHandoffId'
>

export function isAutoTitleCandidate(n: AutoTitleNode): boolean {
  return (
    n.status !== 'ended' &&
    n.provider === 'claude' &&
    !!n.ccSessionId &&
    n.titleSource !== 'manual' &&
    !n.autoTitle?.trim() &&
    !isChildSessionNode(n)
  )
}

export interface AutoTitleStats {
  attempts: number
  succeeded: number
  failed: number
  discarded: number
  gaveUp: number
  running: number
}

export interface AutoTitlerDeps {
  readPrompt: (ccSessionId: string) => string | null
  summarize: (ccSessionId: string) => Promise<SessionTitleResult>
  // true = gravou (o store recusa se já há manual/self).
  save: (sessionId: string, title: string) => boolean
  onSaved: (sessionId: string, ccSessionId: string, title: string) => void
  now?: () => number
  log?: (event: string, data: Record<string, unknown>) => void
}

export interface AutoTitler {
  consider: (nodes: readonly AutoTitleNode[]) => void
  stats: () => AutoTitleStats
  // Espera as gerações em voo (testes e shutdown).
  idle: () => Promise<void>
}

const defaultLog = (event: string, data: Record<string, unknown>) =>
  console.info(`[auto-title] ${JSON.stringify({ event, ...data })}`)

export function createAutoTitler(deps: AutoTitlerDeps): AutoTitler {
  const now = deps.now ?? Date.now
  const log = deps.log ?? defaultLog
  const running = new Map<string, Promise<void>>()
  // Conversas encerradas para este processo do app: gravou, foi recusada ou desistiu.
  const done = new Set<string>()
  const tries = new Map<string, { count: number; lastAt: number }>()
  const counters = { attempts: 0, succeeded: 0, failed: 0, discarded: 0, gaveUp: 0 }

  const stats = (): AutoTitleStats => ({ ...counters, running: running.size })

  async function generate(sessionId: string, cc: string): Promise<void> {
    const result = await deps
      .summarize(cc)
      .catch((err): SessionTitleResult => ({ ok: false, error: String(err) }))
    if (!result.ok) {
      counters.failed++
      const count = tries.get(cc)?.count ?? 0
      if (count >= AUTO_TITLE_MAX_ATTEMPTS) {
        counters.gaveUp++
        done.add(cc)
      }
      log('failed', { sessionId, error: result.error, try: count, ...stats() })
      return
    }
    done.add(cc)
    if (!deps.save(sessionId, result.title)) {
      counters.discarded++
      log('discarded', { sessionId, ...stats() })
      return
    }
    counters.succeeded++
    deps.onSaved(sessionId, cc, result.title)
    log('saved', { sessionId, ...stats() })
  }

  function consider(nodes: readonly AutoTitleNode[]): void {
    for (const n of nodes) {
      if (running.size >= AUTO_TITLE_MAX_CONCURRENT) return
      if (!isAutoTitleCandidate(n)) continue
      const cc = n.ccSessionId!
      if (done.has(cc) || running.has(cc)) continue
      const prev = tries.get(cc)
      if (prev && now() - prev.lastAt < AUTO_TITLE_RETRY_MS) continue
      if (!deps.readPrompt(cc)) continue
      tries.set(cc, { count: (prev?.count ?? 0) + 1, lastAt: now() })
      counters.attempts++
      const job = generate(n.sessionId, cc).finally(() => running.delete(cc))
      running.set(cc, job)
    }
  }

  return {
    consider,
    stats,
    idle: async () => {
      await Promise.all([...running.values()])
    },
  }
}
