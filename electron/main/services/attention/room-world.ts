// Apoio dos testes de componente da Room: o estado que o renderer recebe, montado
// pelos PRODUTORES (handoffStore, mapper do main, projectAttention,
// buildSessionGraph) sobre um banco migrado. Quem chama mocka db/transcript-path/
// session-activity/live-session-states, como nos testes da projeção.
import type Database from 'better-sqlite3'
import { projectAttention } from '../../../../shared/attention/project-attention'
import type { ScreenScan, LiveStatus } from '../../../../shared/tui/attention-reason'
import type { AttentionItem } from '../../../../shared/types/attention'
import type { Handoff, LiveSessionInfo } from '../../../../shared/types/ipc'
import type { SessionGraph } from '../../../../shared/types/session-graph'
import * as store from '../handoff-store'
import { buildSessionGraph, readSessionGraphInput, type LiveSessionState } from '../session-graph'
import { readTransitions, toAttentionLive } from './attention-service'
import { toLiveInfo } from './attention-test-harness'

export interface WorldLive {
  id: string
  status: LiveStatus
  scan?: ScreenScan | null
  lastText?: string
  title?: string
}

export interface RoomWorld {
  handoffs: Handoff[]
  attention: AttentionItem[]
  live: LiveSessionInfo[]
  graph: SessionGraph
}

export function roomWorld(db: Database.Database, lives: WorldLive[]): RoomWorld {
  const states = new Map<string, LiveSessionState>(
    lives.map((l) => [l.id, { status: l.status, lastActivityAt: 1_000, name: null }]),
  )
  const rows = db
    .prepare(
      'SELECT id, feature_id, repo_id FROM sessions WHERE id IN (SELECT value FROM json_each(?))',
    )
    .all(JSON.stringify(lives.map((l) => l.id))) as Array<{
    id: string
    feature_id: string | null
    repo_id: string | null
  }>
  const byId = new Map(lives.map((l) => [l.id, l]))
  const attentionLive = rows.map((r) => {
    const scan = byId.get(r.id)?.scan ?? null
    return toAttentionLive(r, states.get(r.id)!, scan, scan?.menu ? 1 : null)
  })
  const handoffs = store.list()
  const attention = projectAttention({
    handoffs,
    transitions: readTransitions(db, handoffs),
    live: attentionLive,
  })
  const live = attentionLive.map((s) => {
    const l = byId.get(s.sessionId)
    return toLiveInfo(db, s, { lastText: l?.lastText ?? null, title: l?.title ?? null })
  })
  const graph = buildSessionGraph({ ...readSessionGraphInput(db, states), attention })
  return { handoffs, attention, live, graph }
}
